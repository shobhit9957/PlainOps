variable "project_name" {
  type        = string
  description = "PLAINOPS project name (lowercase, alphanumeric + hyphens)"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.project_name))
    error_message = "project_name must be lowercase alphanumeric/hyphens, 2-31 chars, starting with a letter."
  }
}

variable "region" {
  type = string
}

variable "cpu" {
  type    = number
  default = 256
}

variable "memory_mb" {
  type    = number
  default = 512
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "max_count" {
  type    = number
  default = 4
}

variable "with_database" {
  type    = bool
  default = false
}

variable "health_path" {
  type    = string
  default = "/"
}

variable "container_port" {
  type    = number
  default = 3000
}

variable "app_secrets" {
  type        = list(string)
  default     = []
  description = "Names of app secrets. Shells only — values are set via the AWS SDK, never through Terraform, so they never touch plan or state files."
}

variable "budget_email" {
  type    = string
  default = ""
}

variable "budget_monthly_usd" {
  type    = number
  default = 60
}

variable "bootstrap_bucket" {
  type        = string
  description = "Existing PLAINOPS bucket holding source.zip uploads"
}

variable "log_retention_days" {
  type    = number
  default = 7
}
