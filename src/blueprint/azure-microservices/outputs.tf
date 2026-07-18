output "gateway_url" {
  value = length(local.public_services) > 0 ? "https://${azurerm_container_app.svc[local.public_services[0]].ingress[0].fqdn}" : ""
}

output "service_urls" {
  value = jsonencode({
    for k, s in var.services : k =>
    s.public ? "https://${azurerm_container_app.svc[k].ingress[0].fqdn}" : "http://${local.app_name[k]}"
  })
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
