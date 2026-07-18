variable "project_name" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,24}$", var.project_name))
    error_message = "project_name must be lowercase alphanumeric/hyphens, 2-25 chars, starting with a letter."
  }
}

variable "region" {
  type = string
}

variable "bootstrap_bucket" {
  type = string
}

# One entry per microservice. Detected automatically from the project folder.
variable "services" {
  type = map(object({
    port     = number
    public   = bool # true = the gateway, fronted by the load balancer
    needs_db = bool # true = gets MONGODB_URI injected
    cpu      = number
    memory   = number
    desired  = number
    max      = number
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

variable "health_path" {
  type    = string
  default = "/health"
}

variable "log_retention_days" {
  type    = number
  default = 7
}
