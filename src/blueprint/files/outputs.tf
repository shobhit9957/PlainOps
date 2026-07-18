output "app_url" {
  value = "http://${aws_lb.main.dns_name}"
}

output "alb_dns" {
  value = aws_lb.main.dns_name
}

output "ecr_repo_url" {
  value = aws_ecr_repository.app.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "codebuild_project" {
  value = aws_codebuild_project.app.name
}

output "log_group" {
  value = aws_cloudwatch_log_group.app.name
}

output "secret_arns" {
  value = { for name, s in aws_secretsmanager_secret.app : name => s.arn }
}

output "db_endpoint" {
  value = var.with_database ? aws_db_instance.main[0].address : ""
}

output "db_name" {
  value = var.with_database ? "appdb" : ""
}

output "db_user" {
  value = var.with_database ? "appuser" : ""
}

output "db_master_secret_arn" {
  value = var.with_database ? aws_db_instance.main[0].master_user_secret[0].secret_arn : ""
}
