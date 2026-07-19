terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.gcp_project
  region  = var.region
}

locals {
  name   = "po-${var.project_name}"
  labels = { "plainops-project" = var.project_name }
}

# ---------------- Required APIs ----------------

# disable_on_destroy = false: switching APIs off on teardown would break
# anything else in the user's project that happens to use them.
resource "google_project_service" "apis" {
  for_each = toset([
    "cloudfunctions.googleapis.com",
    "run.googleapis.com",
    "pubsub.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "eventarc.googleapis.com",
    "firestore.googleapis.com",
    # Cloud Functions gen2 builds the source with Cloud Build, which runs as the
    # Compute Engine default SA — enable Compute so that SA exists on fresh projects.
    "compute.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ---------------- Function source (GCS) ----------------

resource "google_storage_bucket" "src" {
  name                        = "po-src-${var.project_name}-${var.gcp_project}"
  location                    = var.region
  force_destroy               = true
  uniform_bucket_level_access = true
  labels                      = local.labels
}

# Source hash in the object name so a changed zip forces a new function build.
resource "google_storage_bucket_object" "api" {
  name   = "api-${filemd5(var.api_zip_path)}.zip"
  bucket = google_storage_bucket.src.name
  source = var.api_zip_path
}

resource "google_storage_bucket_object" "worker" {
  name   = "worker-${filemd5(var.worker_zip_path)}.zip"
  bucket = google_storage_bucket.src.name
  source = var.worker_zip_path
}

# ---------------- Queue: Pub/Sub ----------------

resource "google_pubsub_topic" "tasks" {
  name       = "${local.name}-tasks"
  labels     = local.labels
  depends_on = [google_project_service.apis]
}

# ---------------- Storage: Firestore ----------------

# Named database on purpose — "(default)" cannot be deleted, which would make
# `tofu destroy` leave residue behind.
resource "google_firestore_database" "main" {
  name                    = local.name
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_DISABLED"
  deletion_policy         = "DELETE"
  depends_on              = [google_project_service.apis]
}

# ---------------- API function (HTTP) ----------------

resource "google_cloudfunctions2_function" "api" {
  name     = "${local.name}-api"
  location = var.region
  labels   = local.labels

  build_config {
    runtime     = "nodejs20"
    entry_point = "handler"
    source {
      storage_source {
        bucket = google_storage_bucket.src.name
        object = google_storage_bucket_object.api.name
      }
    }
  }

  service_config {
    available_memory   = "256M"
    timeout_seconds    = 60
    max_instance_count = 10
    environment_variables = {
      FIRESTORE_DB = google_firestore_database.main.name
      GCP_TOPIC    = google_pubsub_topic.tasks.name
    }
  }

  depends_on = [google_project_service.apis]
}

# Gen2 functions sit on Cloud Run — public access is granted on the
# underlying run service, not through the Functions API.
resource "google_cloud_run_v2_service_iam_member" "api_public" {
  location = var.region
  name     = google_cloudfunctions2_function.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---------------- Worker function (Pub/Sub triggered) ----------------

resource "google_cloudfunctions2_function" "worker" {
  name     = "${local.name}-worker"
  location = var.region
  labels   = local.labels

  build_config {
    runtime     = "nodejs20"
    entry_point = "handler"
    source {
      storage_source {
        bucket = google_storage_bucket.src.name
        object = google_storage_bucket_object.worker.name
      }
    }
  }

  service_config {
    available_memory   = "256M"
    timeout_seconds    = 60
    max_instance_count = 10
    environment_variables = {
      FIRESTORE_DB = google_firestore_database.main.name
      GCP_TOPIC    = google_pubsub_topic.tasks.name
    }
  }

  event_trigger {
    trigger_region = var.region
    event_type     = "google.cloud.pubsub.topic.v1.messagePublished"
    pubsub_topic   = google_pubsub_topic.tasks.id
    retry_policy   = "RETRY_POLICY_RETRY"
  }

  depends_on = [google_project_service.apis]
}
