// Cloud Functions gen2 HTTP function (entry point: handler). Publishes a job to
// Pub/Sub so the worker processes it — the GCP mirror of the AWS order pipeline.
const { PubSub } = require('@google-cloud/pubsub');
const pubsub = new PubSub();

exports.handler = async (req, res) => {
  if (req.method === 'GET') {
    res.status(200).json({ status: 'ok', service: 'gcp-api' });
    return;
  }
  const body = req.body || {};
  try {
    const topic = process.env.GCP_TOPIC;
    await pubsub.topic(topic).publishMessage({ json: { item: body.item || 'widget', at: Date.now() } });
    res.status(201).json({ status: 'PENDING', message: 'Order queued for processing.' });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
};
