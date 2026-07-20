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
  # Container Apps names: lowercase alphanumeric + hyphens, max 32 chars.
  # The app name doubles as the internal DNS label, so sanitize the service key.
  app_name = { for k in keys(var.services) : k => substr(replace(lower(k), "_", "-"), 0, 32) }
  # Native discovery: every app in one environment reaches every other at
  # http://<app-name> (the environment's internal proxy routes to its target
  # port). No per-URL resources needed, no circularity — just computed strings.
  peer_env = { for k in keys(var.services) : k => {
    for other in keys(var.services) :
    "${upper(replace(other, "-", "_"))}_URL" => "http://${local.app_name[other]}" if other != k
  } }
  # Deterministic gateway pick: first public service in key order.
  public_services = sort([for k, s in var.services : k if s.public])
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

# ---------------- Shared registry ----------------

resource "azurerm_container_registry" "main" {
  name                = local.acr_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Basic"
  admin_enabled       = true
  tags                = local.tags
}

# ---------------- MongoDB (Cosmos DB, serverless) ----------------

resource "azurerm_cosmosdb_account" "main" {
  count               = var.with_database ? 1 : 0
  name                = "${local.name}-${random_string.suffix.result}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  offer_type          = "Standard"
  kind                = "MongoDB"
  mongo_server_version = "6.0"
  tags                = local.tags

  capabilities {
    name = "EnableMongo"
  }
  capabilities {
    name = "EnableServerless"
  }

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = azurerm_resource_group.main.location
    failover_priority = 0
  }
}

resource "azurerm_cosmosdb_mongo_database" "appdb" {
  count               = var.with_database ? 1 : 0
  name                = "appdb"
  resource_group_name = azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.main[0].name
}

# ---------------- Cache (Azure Cache for Redis) ----------------

resource "azurerm_redis_cache" "main" {
  count               = var.with_cache ? 1 : 0
  name                = "${local.name}-${random_string.suffix.result}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  capacity            = 0
  family              = "C"
  sku_name            = "Basic"
  minimum_tls_version = "1.2"
  tags                = local.tags
}

# ---------------- Container apps (one per service) ----------------

resource "azurerm_container_app" "svc" {
  for_each                     = var.services
  name                         = local.app_name[each.key]
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  tags                         = local.tags

  # Public services get an internet-facing FQDN; the rest stay environment-only
  # but still get ingress so http://<app-name> routes to their port.
  ingress {
    external_enabled = each.value.public
    target_port      = each.value.port
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

  # ACR password + connection strings live only in local tfstate on the user's
  # machine — the accepted PLAINOPS pattern. Never surfaced as outputs.
  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }

  dynamic "secret" {
    for_each = var.with_database ? [1] : []
    content {
      name  = "mongodb-uri"
      value = azurerm_cosmosdb_account.main[0].primary_mongodb_connection_string
    }
  }

  dynamic "secret" {
    for_each = var.with_cache ? [1] : []
    content {
      name  = "redis-url"
      value = "rediss://:${azurerm_redis_cache.main[0].primary_access_key}@${azurerm_redis_cache.main[0].hostname}:6380"
    }
  }

  template {
    min_replicas = 1
    max_replicas = 4

    container {
      name   = local.app_name[each.key]
      image  = each.value.image
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "PORT"
        value = tostring(each.value.port)
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      # Declared env + a <PEER>_URL for every other service.
      dynamic "env" {
        for_each = merge(each.value.env, local.peer_env[each.key])
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.with_database ? [1] : []
        content {
          name        = "MONGODB_URI"
          secret_name = "mongodb-uri"
        }
      }
      dynamic "env" {
        for_each = var.with_cache ? [1] : []
        content {
          name        = "REDIS_URL"
          secret_name = "redis-url"
        }
      }
    }
  }
}
