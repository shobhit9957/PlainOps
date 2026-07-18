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
  # ACR names are globally unique, 5-50 chars, alphanumeric ONLY (no hyphens).
  acr_name = substr("po${replace(var.project_name, "-", "")}${random_string.suffix.result}", 0, 50)
  # Container-app secret names allow only lowercase alphanumeric + hyphens.
  secret_name = { for s in var.app_secrets : s => lower(replace(s, "_", "-")) }
}

resource "random_string" "suffix" {
  length  = 6
  lower   = true
  upper   = false
  numeric = true
  special = false
}

# ---------------- Resource group, logs, environment ----------------

resource "azurerm_resource_group" "main" {
  name     = local.name
  location = var.region
  tags     = local.tags
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = local.name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

resource "azurerm_container_app_environment" "main" {
  name                       = local.name
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  tags                       = local.tags
}

# ---------------- Registry ----------------

resource "azurerm_container_registry" "main" {
  name                = local.acr_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Basic"
  admin_enabled       = true
  tags                = local.tags
}

# ---------------- Optional database (PostgreSQL Flexible Server) ----------------

resource "random_password" "db" {
  count   = var.with_database ? 1 : 0
  length  = 24
  special = false
}

resource "azurerm_postgresql_flexible_server" "main" {
  count                         = var.with_database ? 1 : 0
  name                          = "${local.name}-${random_string.suffix.result}"
  resource_group_name           = azurerm_resource_group.main.name
  location                      = azurerm_resource_group.main.location
  version                       = "16"
  administrator_login           = "appuser"
  administrator_password        = random_password.db[0].result
  sku_name                      = "B_Standard_B1ms"
  storage_mb                    = 32768
  backup_retention_days         = 7
  public_network_access_enabled = true
  # No high_availability block = zone redundancy off (burstable SKUs don't support it).
  tags = local.tags
  lifecycle {
    # Azure picks an availability zone at create time; don't fight it on re-apply.
    ignore_changes = [zone]
  }
}

resource "azurerm_postgresql_flexible_server_database" "appdb" {
  count     = var.with_database ? 1 : 0
  name      = "appdb"
  server_id = azurerm_postgresql_flexible_server.main[0].id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# The 0.0.0.0 rule is Azure's magic value for "allow Azure services" — it lets
# the container app reach the server without opening it to the internet at large.
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  count            = var.with_database ? 1 : 0
  name             = "allow-azure-services"
  server_id        = azurerm_postgresql_flexible_server.main[0].id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

# ---------------- Container app ----------------

resource "azurerm_container_app" "main" {
  name                         = local.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  tags                         = local.tags

  ingress {
    external_enabled = true
    target_port      = var.container_port
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "acr-password"
  }

  # ACR admin password + composed DATABASE_URL live only in local tfstate on the
  # user's machine — the accepted PLAINOPS pattern. Never surfaced as outputs.
  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }

  # App secrets are shells: placeholder values only. Real values are set later
  # via `az containerapp secret set` by the host product — never through
  # Terraform, so they never appear in plan output.
  dynamic "secret" {
    for_each = toset(var.app_secrets)
    content {
      name  = local.secret_name[secret.value]
      value = "unset"
    }
  }

  dynamic "secret" {
    for_each = var.with_database ? [1] : []
    content {
      name  = "database-url"
      value = "postgresql://appuser:${random_password.db[0].result}@${azurerm_postgresql_flexible_server.main[0].fqdn}:5432/appdb?sslmode=require"
    }
  }

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = "app"
      image  = var.image
      cpu    = var.cpu
      memory = var.memory

      env {
        name  = "PORT"
        value = tostring(var.container_port)
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      dynamic "env" {
        for_each = toset(var.app_secrets)
        content {
          name        = env.value
          secret_name = local.secret_name[env.value]
        }
      }
      dynamic "env" {
        for_each = var.with_database ? [1] : []
        content {
          name        = "DATABASE_URL"
          secret_name = "database-url"
        }
      }
    }
  }
}
