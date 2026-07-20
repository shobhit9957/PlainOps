output "gateway_url" {
  value = length(local.public_services) > 0 ? google_cloud_run_v2_service.svc[local.public_services[0]].uri : ""
}

output "service_urls" {
  value = jsonencode({ for k, s in google_cloud_run_v2_service.svc : k => s.uri })
}

output "artifact_repo_url" {
  value = "${var.region}-docker.pkg.dev/${var.gcp_project}/${google_artifact_registry_repository.main.repository_id}"
}
