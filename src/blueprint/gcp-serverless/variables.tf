variable "project_name" {
  type        = string
  description = "PLAINOPS project name (lowercase, alphanumeric + hyphens)"
  validation {
    condition     = can(regex("^[a-z]([a-z0-9-]{0,19}[a-z0-9])$", var.project_name))
    error_message = "project_name must be lowercase alphanumeric/hyphens, 2-21 chars, starting with a letter and ending alphanumeric."
  }
}

variable "gcp_project" {
  type        = string
  description = "GCP project id to deploy into"
}

variable "region" {
  type = string
}

variable "api_zip_path" {
  type        = string
  description = "Absolute path to the zipped HTTP API function source."
}

variable "worker_zip_path" {
  type        = string
  description = "Absolute path to the zipped Pub/Sub worker function source."
}
