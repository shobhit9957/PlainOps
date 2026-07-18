terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
  # 4.x replacement for skip_provider_registration: PLAINOPS registers nothing.
  resource_provider_registrations = "none"
}

locals {
  name = "po-${var.project_name}"
  tags = {
    "managed-by"       = "plainops"
    "plainops-project" = var.project_name
  }
  # Storage account names: globally unique, 3-24 chars, lowercase alphanumeric
  # ONLY. Trim the project part so the 6-char random suffix always survives.
  storage_name = "po${substr(replace(var.project_name, "-", ""), 0, 16)}${random_string.suffix.result}"
}

resource "random_string" "suffix" {
  length  = 6
  lower   = true
  upper   = false
  numeric = true
  special = false
}

# ---------------- Resource group ----------------

resource "azurerm_resource_group" "main" {
  name     = local.name
  location = var.region
  tags     = local.tags
}

# ---------------- Storage: account, queue, table ----------------

resource "azurerm_storage_account" "main" {
  name                     = local.storage_name
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  tags                     = local.tags
}

resource "azurerm_storage_queue" "tasks" {
  name                 = "tasks"
  storage_account_name = azurerm_storage_account.main.name
}

resource "azurerm_storage_table" "items" {
  name                 = "items"
  storage_account_name = azurerm_storage_account.main.name
}

# ---------------- Function app (consumption plan) ----------------

resource "azurerm_service_plan" "main" {
  name                = local.name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = "Y1"
  tags                = local.tags
}

# The platform only: function code is zip-deployed later by the host product
# via `az functionapp deployment source config-zip`.
resource "azurerm_linux_function_app" "main" {
  name                = "${local.name}-${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  service_plan_id     = azurerm_service_plan.main.id
  tags                = local.tags

  storage_account_name       = azurerm_storage_account.main.name
  storage_account_access_key = azurerm_storage_account.main.primary_access_key

  site_config {
    application_stack {
      node_version = "20"
    }
  }

  app_settings = {
    QUEUE_NAME = azurerm_storage_queue.tasks.name
    TABLE_NAME = azurerm_storage_table.items.name
  }
}
