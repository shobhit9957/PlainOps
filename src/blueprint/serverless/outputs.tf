output "api_url" {
  value = aws_apigatewayv2_stage.default.invoke_url
}

output "orders_table" {
  value = aws_dynamodb_table.orders.name
}

output "queue_url" {
  value = aws_sqs_queue.processing.url
}

output "dlq_url" {
  value = aws_sqs_queue.dlq.url
}

output "api_function" {
  value = aws_lambda_function.api.function_name
}

output "worker_function" {
  value = aws_lambda_function.worker.function_name
}
