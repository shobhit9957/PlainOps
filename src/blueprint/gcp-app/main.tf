terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
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
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
    "cloudbuild.googleapis.com",
    # Cloud Build runs builds as the Compute Engine default service account,
    # which only exists once the Compute API is enabled — without this,
    # `gcloud builds submit` fails with PERMISSION_DENIED on a fresh project.
    "compute.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ---------------- Registry ----------------

resource "google_artifact_registry_repository" "app" {
  repository_id = local.name
  location      = var.region
  format        = "DOCKER"
  labels        = local.labels
  depends_on    = [google_project_service.apis]
}

# ---------------- Runtime service account ----------------

resource "google_service_account" "runtime" {
  account_id   = "${local.name}-sa"
  display_name = "PlainOps runtime for ${var.project_name}"
}

# ---------------- App secrets (shells only — values via SDK, never in state) ----------------

resource "google_secret_manager_secret" "app" {
  for_each  = toset(var.app_secrets)
  secret_id = "${local.name}-${each.value}"
  labels    = local.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "app" {
  for_each  = toset(var.app_secrets)
  secret_id = google_secret_manager_secret.app[each.value].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# ---------------- Optional database (Cloud SQL Postgres) ----------------

resource "random_password" "db" {
  count   = var.with_database ? 1 : 0
  length  = 24
  special = false # keeps the composed URI free of percent-encoding
}

resource "google_sql_database_instance" "main" {
  count               = var.with_database ? 1 : 0
  name                = local.name
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = false
  settings {
    tier        = var.db_tier
    user_labels = local.labels
    ip_configuration {
      ipv4_enabled = true
      # Cloud Run egress IPs are dynamic, so the instance must accept the
      # internet at large; access is gated by the generated password. Swap in
      # the Cloud SQL connector for a stricter network posture.
      authorized_networks {
        name  = "everywhere"
        value = "0.0.0.0/0"
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "appdb" {
  count    = var.with_database ? 1 : 0
  name     = "appdb"
  instance = google_sql_database_instance.main[0].name
}

resource "google_sql_user" "appuser" {
  count    = var.with_database ? 1 : 0
  name     = "appuser"
  instance = google_sql_database_instance.main[0].name
  password = random_password.db[0].result
}

# The URI embeds the generated password, so it rides in Secret Manager rather
# than a plain env var (keeps it out of console views and API responses).
resource "google_secret_manager_secret" "database_url" {
  count     = var.with_database ? 1 : 0
  secret_id = "${local.name}-DATABASE_URL"
  labels    = local.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "database_url" {
  count       = var.with_database ? 1 : 0
  secret      = google_secret_manager_secret.database_url[0].id
  secret_data = "postgresql://appuser:${random_password.db[0].result}@${google_sql_database_instance.main[0].public_ip_address}:5432/appdb"
}

resource "google_secret_manager_secret_iam_member" "database_url" {
  count     = var.with_database ? 1 : 0
  secret_id = google_secret_manager_secret.database_url[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# ---------------- Cloud Run service ----------------

resource "google_cloud_run_v2_service" "app" {
  name                = local.name
  location            = var.region
  labels              = local.labels
  deletion_protection = false # provider default is true, which blocks `tofu destroy`

  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image
      ports {
        container_port = var.container_port
      }
      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
      }

      dynamic "env" {
        for_each = toset(var.app_secrets)
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.value].secret_id
              version = "latest"
            }
          }
        }
      }

      dynamic "env" {
        for_each = var.with_database ? [1] : []
        content {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.database_url[0].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_iam_member.app,
    google_secret_manager_secret_iam_member.database_url,
    google_secret_manager_secret_version.database_url,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  location = var.region
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
