output "app_url" {
  value = "http://${aws_lb.main.dns_name}"
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "service_names" {
  value = { for k, s in aws_ecs_service.svc : k => s.name }
}

output "codebuild_projects" {
  value = { for k, c in aws_codebuild_project.svc : k => c.name }
}

output "log_groups" {
  value = { for k, l in aws_cloudwatch_log_group.svc : k => l.name }
}

output "mongodb_secret_arn" {
  value = var.with_database ? aws_secretsmanager_secret.mongodb[0].arn : ""
}

output "docdb_endpoint" {
  value = var.with_database ? aws_docdb_cluster.main[0].endpoint : ""
}

output "docdb_user" {
  value = var.with_database ? "appuser" : ""
}

output "docdb_password" {
  value     = var.with_database ? random_password.docdb[0].result : ""
  sensitive = true
}

output "redis_endpoint" {
  value = var.with_cache ? aws_elasticache_cluster.main[0].cache_nodes[0].address : ""
}
