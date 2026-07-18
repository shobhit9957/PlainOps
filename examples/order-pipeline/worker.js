'use strict';

/**
 * Worker Lambda — triggered by SQS. For each queued order it does the "work"
 * (here: a simple status transition) and marks the order PROCESSED in DynamoDB.
 * Throwing on failure lets SQS retry, and after maxReceiveCount the message
 * lands in the dead-letter queue.
 */

const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;

exports.handler = async (event) => {
  for (const record of event.Records || []) {
    const { id } = JSON.parse(record.body);
    // (Real pipelines would do actual work here — charge a card, render a file, etc.)
    await ddb.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: { id: { S: id } },
        UpdateExpression: 'SET #s = :s, processedAt = :p',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s': { S: 'PROCESSED' },
          ':p': { S: new Date().toISOString() },
        },
      }),
    );
    console.log('Processed order', id);
  }
  return { batchItemFailures: [] };
};
