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

data "google_project" "current" {}

locals {
  name   = "po-${var.project_name}"
  labels = { "plainops-project" = var.project_name }
  # Every service gets every service's URL injected. Referencing each run
  # service's `uri` attribute from every other service's env would be circular
  # (A's env needs B, B's env needs A), so we compute the DETERMINISTIC
  # Cloud Run v2 URL instead:
  #   https://<service-name>-<project-number>.<region>.run.app
  # The `uri` attribute is only read in outputs, where no cycle is possible.
  url_env = {
    for sname, s in var.services :
    "${upper(replace(sname, "-", "_"))}_URL" => "https://${local.name}-${sname}-${data.google_project.current.number}.${var.region}.run.app"
  }
  # for-expressions walk maps in sorted key order, so element [0] is the
  # alphabetically-first public service — deterministic across runs.
  public_services = [for k, v in var.services : k if v.public]
}

# ---------------- Required APIs ----------------

# Superset for all toggles — enabling an API is free and idempotent, and
# disable_on_destroy = false keeps teardown from breaking the user's project.
resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
    "redis.googleapis.com",
    "compute.googleapis.com",
    # Images build via `gcloud builds submit` — needs the Cloud Build API too.
    "cloudbuild.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ---------------- Registry (shared) ----------------

resource "google_artifact_registry_repository" "main" {
  repository_id = local.name
  location      = var.region
  format        = "DOCKER"
  labels        = local.labels
  depends_on    = [google_project_service.apis]
}

# ---------------- Runtime service account (shared) ----------------

resource "google_service_account" "runtime" {
  account_id   = "${local.name}-sa"
  display_name = "PlainOps runtime for ${var.project_name}"
}

# ---------------- Optional database (shared Cloud SQL Postgres) ----------------

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
    tier        = "db-f1-micro"
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

# ---------------- Optional cache (Memorystore Redis) ----------------

resource "google_redis_instance" "main" {
  count          = var.with_cache ? 1 : 0
  name           = local.name
  tier           = "BASIC"
  memory_size_gb = 1
  region         = var.region
  labels         = local.labels
  depends_on     = [google_project_service.apis]
}

# ---------------- Cloud Run services ----------------

resource "google_cloud_run_v2_service" "svc" {
  for_each            = var.services
  name                = "${local.name}-${each.key}"
  location            = var.region
  labels              = local.labels
  deletion_protection = false # provider default is true, which blocks `tofu destroy`

  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 0
      max_instance_count = 4
    }

    containers {
      image = each.value.image
      ports {
        container_port = each.value.port
      }

      dynamic "env" {
        for_each = each.value.env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.url_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.with_cache ? [1] : []
        content {
          name  = "REDIS_URL"
          value = "redis://${google_redis_instance.main[0].host}:${google_redis_instance.main[0].port}"
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

    # Memorystore only has a private IP on the default VPC — direct VPC egress
    # makes REDIS_URL actually reachable from Cloud Run.
    dynamic "vpc_access" {
      for_each = var.with_cache ? [1] : []
      content {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network = "default"
        }
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_iam_member.database_url,
    google_secret_manager_secret_version.database_url,
  ]
}

# Internet-facing services get the public invoker; the rest stay IAM-gated.
resource "google_cloud_run_v2_service_iam_member" "public" {
  for_each = { for k, v in var.services : k => v if v.public }
  location = var.region
  name     = google_cloud_run_v2_service.svc[each.key].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Sibling services call the private ones with ID tokens minted from the shared
# runtime SA, so grant it invoker there.
resource "google_cloud_run_v2_service_iam_member" "internal" {
  for_each = { for k, v in var.services : k => v if !v.public }
  location = var.region
  name     = google_cloud_run_v2_service.svc[each.key].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.runtime.email}"
}
