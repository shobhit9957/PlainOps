output "function_app_name" {
  value = azurerm_linux_function_app.main.name
}

output "api_base_url" {
  value = "https://${azurerm_linux_function_app.main.default_hostname}"
}

output "queue_name" {
  value = azurerm_storage_queue.tasks.name
}

output "storage_account_name" {
  value = azurerm_storage_account.main.name
}

output "resource_group" {
  value = azurerm_resource_group.main.name
}
