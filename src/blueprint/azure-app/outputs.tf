output "app_url" {
  value = "https://${azurerm_container_app.main.ingress[0].fqdn}"
}

output "acr_login_server" {
  value = azurerm_container_registry.main.login_server
}

output "acr_name" {
  value = azurerm_container_registry.main.name
}

output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "db_fqdn" {
  value = var.with_database ? azurerm_postgresql_flexible_server.main[0].fqdn : ""
}
