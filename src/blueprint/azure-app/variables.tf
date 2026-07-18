variable "project_name" {
  type        = string
  description = "PLAINOPS project name (lowercase, alphanumeric + hyphens)"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,24}$", var.project_name))
    error_message = "project_name must be lowercase alphanumeric/hyphens, 2-25 chars, starting with a letter."
  }
}

variable "region" {
  type        = string
  description = "Azure location, e.g. centralindia"
}

variable "image" {
  type        = string
  default     = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
  description = "Initial image. Replaced with the project's ACR image on first deploy."
}

variable "container_port" {
  type    = number
  default = 80
}

variable "cpu" {
  type    = number
  default = 0.5
}

variable "memory" {
  type    = string
  default = "1Gi"
}

variable "min_replicas" {
  type    = number
  default = 0
}

variable "max_replicas" {
  type    = number
  default = 4
}

variable "with_database" {
  type    = bool
  default = false
}

variable "app_secrets" {
  type        = list(string)
  default     = []
  description = "Names of app secrets. Shells only — values are set via the az CLI, never through Terraform, so they never touch plan files."
}
