output "app_url" {
  value = google_cloud_run_v2_service.app.uri
}

output "artifact_repo_url" {
  value = "${var.region}-docker.pkg.dev/${var.gcp_project}/${google_artifact_registry_repository.app.repository_id}"
}

output "service_name" {
  value = google_cloud_run_v2_service.app.name
}

output "secret_ids" {
  value = jsonencode({ for name, s in google_secret_manager_secret.app : name => s.id })
}

output "db_instance_name" {
  value = var.with_database ? google_sql_database_instance.main[0].name : ""
}
