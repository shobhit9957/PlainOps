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
