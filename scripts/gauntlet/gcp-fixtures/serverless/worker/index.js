// Cloud Functions gen2 CloudEvent function (entry point: handler), Pub/Sub triggered.
exports.handler = (cloudEvent) => {
  const data = cloudEvent && cloudEvent.data && cloudEvent.data.message ? cloudEvent.data.message.data : null;
  const decoded = data ? Buffer.from(data, 'base64').toString() : '(empty)';
  console.log('GCP-GAUNTLET-WORKER processed:', decoded);
  return;
};
