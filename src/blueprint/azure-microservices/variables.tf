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

# One entry per microservice. Detected automatically from the project folder.
variable "services" {
  type = map(object({
    image  = string
    port   = number
    public = bool # true = internet-facing ingress; false = environment-internal
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
