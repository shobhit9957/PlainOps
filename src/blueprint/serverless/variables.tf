variable "project_name" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.project_name))
    error_message = "project_name must be lowercase alphanumeric/hyphens, 2-31 chars, starting with a letter."
  }
}

variable "region" {
  type = string
}

variable "api_zip_path" {
  type        = string
  description = "Absolute path to the zipped API Lambda handler."
}

variable "worker_zip_path" {
  type        = string
  description = "Absolute path to the zipped SQS worker Lambda handler."
}

variable "api_handler" {
  type    = string
  default = "api.handler"
}

variable "worker_handler" {
  type    = string
  default = "worker.handler"
}

variable "log_retention_days" {
  type    = number
  default = 7
}
