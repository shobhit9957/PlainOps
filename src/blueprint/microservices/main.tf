terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.0" }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      "managed-by"        = "plainops"
      "plainops-project" = var.project_name
    }
  }
}

data "aws_availability_zones" "available" { state = "available" }

locals {
  name = "po-${var.project_name}"
  ns   = "${var.project_name}.internal"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
  # The single public (gateway) service.
  public_service = [for k, v in var.services : k if v.public][0]
  # Every service reachable at http://<name>.<ns>:<port> — injected into all services.
  url_env = [for sname, s in var.services : {
    name  = "${upper(replace(sname, "-", "_"))}_URL"
    value = "http://${sname}.${local.ns}:${s.port}"
  }]
  # Shared Redis cache endpoint, injected into all services when enabled.
  cache_env = var.with_cache ? [{
    name  = "REDIS_URL"
    value = "redis://${aws_elasticache_cluster.main[0].cache_nodes[0].address}:6379"
  }] : []
}

# ---------------- Network ----------------

resource "aws_vpc" "main" {
  cidr_block           = "10.30.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true
}

resource "aws_internet_gateway" "igw" { vpc_id = aws_vpc.main.id }

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "alb" {
  name_prefix = "${local.name}-alb-"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  lifecycle {
    create_before_destroy = true
  }
}

# Services: reachable from the ALB and from each other (self-referencing).
resource "aws_security_group" "service" {
  name_prefix = "${local.name}-svc-"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port       = 0
    to_port         = 65535
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "service_self" {
  type              = "ingress"
  from_port         = 0
  to_port           = 65535
  protocol          = "tcp"
  security_group_id = aws_security_group.service.id
  self              = true
}

resource "aws_security_group" "docdb" {
  count       = var.with_database ? 1 : 0
  name_prefix = "${local.name}-docdb-"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port       = 27017
    to_port         = 27017
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------------- Service discovery (Cloud Map) ----------------

resource "aws_service_discovery_private_dns_namespace" "main" {
  name = local.ns
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "svc" {
  for_each = var.services
  name     = each.key
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config { failure_threshold = 1 }
}

# ---------------- Load balancer → gateway ----------------

resource "aws_lb" "main" {
  name               = local.name
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
}

resource "aws_lb_target_group" "gateway" {
  name        = local.name
  port        = var.services[local.public_service].port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    path                = var.health_path
    matcher             = "200-399"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 5
  }
  deregistration_delay = 30
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}

# ---------------- ECS cluster + roles ----------------

resource "aws_ecs_cluster" "main" { name = local.name }

resource "aws_iam_role" "task_execution" {
  name_prefix = "${local.name}-exec-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  count = var.with_database ? 1 : 0
  role  = aws_iam_role.task_execution.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.mongodb[0].arn] }]
  })
}

resource "aws_iam_role" "task" {
  name_prefix = "${local.name}-task-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

# ---------------- MongoDB (DocumentDB) ----------------

resource "aws_secretsmanager_secret" "mongodb" {
  count                   = var.with_database ? 1 : 0
  name                    = "plainops/${var.project_name}/MONGODB_URI"
  recovery_window_in_days = 0
}

resource "random_password" "docdb" {
  count   = var.with_database ? 1 : 0
  length  = 24
  special = false
}

resource "aws_docdb_subnet_group" "main" {
  count      = var.with_database ? 1 : 0
  name       = local.name
  subnet_ids = aws_subnet.public[*].id
}

# Disable TLS so services connect with a plain, reliable MongoDB URI (traffic
# stays inside the VPC, locked to the service security group). Re-enable with a
# CA bundle for stricter production setups.
resource "aws_docdb_cluster_parameter_group" "main" {
  count  = var.with_database ? 1 : 0
  family = "docdb5.0"
  name   = "${local.name}-params"
  parameter {
    name  = "tls"
    value = "disabled"
  }
}

resource "aws_docdb_cluster" "main" {
  count                           = var.with_database ? 1 : 0
  cluster_identifier              = local.name
  engine                          = "docdb"
  engine_version                  = "5.0.0"
  master_username                 = "appuser"
  master_password                 = random_password.docdb[0].result
  db_subnet_group_name            = aws_docdb_subnet_group.main[0].name
  vpc_security_group_ids          = [aws_security_group.docdb[0].id]
  db_cluster_parameter_group_name = aws_docdb_cluster_parameter_group.main[0].name
  skip_final_snapshot             = true
  apply_immediately               = true
  backup_retention_period         = 7
}

resource "aws_docdb_cluster_instance" "main" {
  count              = var.with_database ? 1 : 0
  identifier         = "${local.name}-1"
  cluster_identifier = aws_docdb_cluster.main[0].id
  instance_class     = "db.t3.medium"
}

# ---------------- Cache (ElastiCache Redis) ----------------

resource "aws_security_group" "cache" {
  count       = var.with_cache ? 1 : 0
  name_prefix = "${local.name}-cache-"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_elasticache_subnet_group" "main" {
  count      = var.with_cache ? 1 : 0
  name       = local.name
  subnet_ids = aws_subnet.public[*].id
}

resource "aws_elasticache_cluster" "main" {
  count                = var.with_cache ? 1 : 0
  cluster_id           = local.name
  engine               = "redis"
  node_type            = "cache.t3.micro"
  num_cache_nodes      = 1
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main[0].name
  security_group_ids   = [aws_security_group.cache[0].id]
}

# ---------------- Per-service: ECR, CodeBuild, logs, task def, service, autoscaling ----------------

resource "aws_ecr_repository" "svc" {
  for_each     = var.services
  name         = "${local.name}-${each.key}"
  force_delete = true
}

resource "aws_cloudwatch_log_group" "svc" {
  for_each          = var.services
  name              = "/plainops/${var.project_name}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "codebuild" {
  name_prefix = "${local.name}-cb-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "codebuild.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "codebuild" {
  role = aws_iam_role.codebuild.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart"], Resource = [for r in aws_ecr_repository.svc : r.arn] },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"], Resource = "arn:aws:s3:::${var.bootstrap_bucket}/${var.project_name}/*" }
    ]
  })
}

locals {
  buildspec = <<-YAML
    version: 0.2
    phases:
      pre_build:
        commands:
          - aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_URL
      build:
        commands:
          - docker build -t $ECR_URL:$IMAGE_TAG -t $ECR_URL:live .
      post_build:
        commands:
          - docker push $ECR_URL:$IMAGE_TAG
          - docker push $ECR_URL:live
  YAML
}

resource "aws_codebuild_project" "svc" {
  for_each     = var.services
  name         = "${local.name}-${each.key}"
  service_role = aws_iam_role.codebuild.arn
  artifacts { type = "NO_ARTIFACTS" }
  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/standard:7.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = true
    environment_variable {
      name  = "ECR_URL"
      value = aws_ecr_repository.svc[each.key].repository_url
    }
    environment_variable {
      name  = "IMAGE_TAG"
      value = "manual"
    }
  }
  source {
    type      = "S3"
    location  = "${var.bootstrap_bucket}/${var.project_name}/${each.key}/source.zip"
    buildspec = local.buildspec
  }
  build_timeout = 20
}

resource "aws_ecs_task_definition" "svc" {
  for_each                 = var.services
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(each.value.cpu)
  memory                   = tostring(each.value.memory)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([
    {
      name      = each.key
      image     = "${aws_ecr_repository.svc[each.key].repository_url}:live"
      essential = true
      portMappings = [{ containerPort = each.value.port, protocol = "tcp" }]
      environment = concat(
        [
          { name = "PORT", value = tostring(each.value.port) },
          { name = "NODE_ENV", value = "production" },
        ],
        local.url_env,
        local.cache_env,
      )
      secrets = each.value.needs_db && var.with_database ? [
        { name = "MONGODB_URI", valueFrom = aws_secretsmanager_secret.mongodb[0].arn }
      ] : []
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.svc[each.key].name
          awslogs-region        = var.region
          awslogs-stream-prefix = each.key
        }
      }
    }
  ])
}

resource "aws_ecs_service" "svc" {
  for_each                          = var.services
  name                              = each.key
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.svc[each.key].arn
  desired_count                     = each.value.desired
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = each.value.public ? 60 : null
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = true
  }
  service_registries {
    registry_arn = aws_service_discovery_service.svc[each.key].arn
  }
  dynamic "load_balancer" {
    for_each = each.value.public ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.gateway.arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }
  lifecycle { ignore_changes = [desired_count] }
  depends_on = [aws_lb_listener.http]
}

resource "aws_appautoscaling_target" "svc" {
  for_each           = var.services
  max_capacity       = each.value.max
  min_capacity       = each.value.desired
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.svc[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "svc_cpu" {
  for_each           = var.services
  name               = "${local.name}-${each.key}-cpu70"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.svc[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.svc[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.svc[each.key].service_namespace
  target_tracking_scaling_policy_configuration {
    target_value           = 70
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}
