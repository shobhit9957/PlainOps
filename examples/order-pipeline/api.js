'use strict';

/**
 * API Lambda (behind API Gateway HTTP API, payload format 2.0).
 * Routes:
 *   GET  /                → a tiny UI to try the pipeline
 *   POST /orders          → create an order (status PENDING) + enqueue it on SQS
 *   GET  /orders          → list orders
 *   GET  /orders/{id}     → fetch one order
 *
 * Uses only AWS SDK v3 clients that ship in the Node.js 20 Lambda runtime, with
 * manual DynamoDB (un)marshalling so nothing needs bundling.
 */

const { DynamoDBClient, PutItemCommand, GetItemCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const crypto = require('crypto');

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});
const TABLE = process.env.TABLE_NAME;
const QUEUE = process.env.QUEUE_URL;

exports.handler = async (event) => {
  const method = event.requestContext && event.requestContext.http && event.requestContext.http.method;
  const rawPath = event.rawPath || '/';
  try {
    if (method === 'GET' && rawPath === '/') return html();

    if (method === 'POST' && rawPath === '/orders') {
      const body = JSON.parse(event.body || '{}');
      const id = crypto.randomUUID();
      const item = {
        id: { S: id },
        item: { S: String(body.item || 'widget') },
        quantity: { N: String(parseInt(body.quantity, 10) || 1) },
        status: { S: 'PENDING' },
        createdAt: { S: new Date().toISOString() },
      };
      await ddb.send(new PutItemCommand({ TableName: TABLE, Item: item }));
      await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE, MessageBody: JSON.stringify({ id }) }));
      return json(201, { id, status: 'PENDING', message: 'Order queued for processing.' });
    }

    if (method === 'GET' && rawPath === '/orders') {
      const out = await ddb.send(new ScanCommand({ TableName: TABLE, Limit: 50 }));
      const orders = (out.Items || []).map(unmarshal).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return json(200, orders);
    }

    if (method === 'GET' && rawPath.startsWith('/orders/')) {
      const id = rawPath.split('/')[2];
      const out = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { id: { S: id } } }));
      if (!out.Item) return json(404, { error: 'order not found' });
      return json(200, unmarshal(out.Item));
    }

    return json(404, { error: 'route not found', method, path: rawPath });
  } catch (e) {
    console.error(e);
    return json(500, { error: e.message });
  }
};

function unmarshal(item) {
  return {
    id: item.id && item.id.S,
    item: item.item && item.item.S,
    quantity: item.quantity ? Number(item.quantity.N) : undefined,
    status: item.status && item.status.S,
    createdAt: item.createdAt && item.createdAt.S,
    processedAt: item.processedAt && item.processedAt.S,
  };
}

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function html() {
  const page = `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Order Pipeline · Serverless on AWS</title>
<style>
 :root{color-scheme:dark}body{margin:0;font-family:system-ui,sans-serif;background:radial-gradient(1200px 600px at 50% -10%,#16233f,#0b1120 60%);color:#e2e8f0;min-height:100vh;padding:40px 16px}
 .w{max-width:640px;margin:0 auto}h1{margin:0 0 4px}.s{color:#94a3b8;font-size:.9rem;margin-bottom:24px}
 form{display:flex;gap:8px;margin-bottom:20px}input{flex:1;background:#131c31;border:1px solid #263354;border-radius:10px;padding:12px;color:#e2e8f0}
 button{cursor:pointer;border:none;border-radius:10px;padding:12px 18px;background:#38bdf8;color:#06121f;font-weight:600}
 ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
 li{background:#131c31;border:1px solid #263354;border-radius:10px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center}
 .badge{padding:3px 10px;border-radius:999px;font-size:.75rem}.PENDING{background:#3a2f14;color:#fbbf24}.PROCESSED{background:#12331c;color:#4ade80}
 .foot{color:#475569;font-size:.78rem;margin-top:24px;text-align:center}code{background:#131c31;padding:2px 6px;border-radius:5px;color:#7dd3fc}
</style></head><body><div class="w">
<h1>🛰️ Order Pipeline</h1>
<div class="s">Serverless on your AWS: API Gateway → Lambda → SQS → Lambda worker → DynamoDB. New orders start <code>PENDING</code>, then a worker Lambda flips them to <code>PROCESSED</code>.</div>
<form id="f"><input id="item" placeholder="Item name, e.g. blue widget" /><button>Place order</button></form>
<ul id="list"></ul>
<div class="foot">Deployed by PLAINOPS ⚓ · fully serverless, pay-per-request</div>
</div><script>
async function load(){const r=await fetch('/orders');const o=await r.json();
document.getElementById('list').innerHTML=o.map(x=>'<li><span>'+x.item+' ×'+x.quantity+'</span><span class="badge '+x.status+'">'+x.status+'</span></li>').join('');}
document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const i=document.getElementById('item');
await fetch('/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({item:i.value||'widget'})});i.value='';
load();setTimeout(load,2500);});
load();setInterval(load,4000);
</script></body></html>`;
  return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: page };
}
