output "api_url" {
  value = google_cloudfunctions2_function.api.url
}

output "topic_name" {
  value = google_pubsub_topic.tasks.name
}

output "worker_name" {
  value = google_cloudfunctions2_function.worker.name
}

output "source_bucket" {
  value = google_storage_bucket.src.name
}
