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

# One entry per microservice. Detected automatically from the project folder.
variable "services" {
  type = map(object({
    image  = string
    port   = number
    public = bool # true = gets the allUsers invoker (internet-facing)
    env    = map(string)
  }))
}

variable "with_database" {
  type    = bool
  default = false
}

variable "with_cache" {
  type    = bool
  default = false
}
