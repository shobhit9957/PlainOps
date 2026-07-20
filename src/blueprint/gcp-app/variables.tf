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

variable "image" {
  type    = string
  default = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "container_port" {
  type    = number
  default = 8080
}

variable "cpu" {
  type    = string
  default = "1"
}

variable "memory" {
  type    = string
  default = "512Mi"
}

variable "min_instances" {
  type    = number
  default = 0
}

variable "max_instances" {
  type    = number
  default = 4
}

variable "with_database" {
  type    = bool
  default = false
}

variable "db_tier" {
  type    = string
  default = "db-f1-micro"
}

variable "app_secrets" {
  type        = list(string)
  default     = []
  description = "Names of app secrets. Shells only — values are set via the GCP SDK, never through Terraform, so they never touch plan or state files."
}
