// Cloud Run gateway: fans out to the internal services via their injected
// <SERVICE>_URL env vars (the blueprint computes deterministic run.app URLs).
const http = require('http');
const port = process.env.PORT || 8080;

// GCP service-to-service auth: internal Cloud Run services are IAM-gated, so
// mint an ID token from the metadata server (audience = the target URL) and
// send it as a Bearer token. The service runs as the shared runtime SA, which
// has run.invoker on the internal services.
async function idToken(audience) {
  const r = await fetch(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) },
  );
  return r.text();
}

async function proxy(name, path) {
  const base = process.env[`${name.toUpperCase()}_URL`];
  if (!base) return { error: `${name}_URL not set` };
  const token = await idToken(base);
  const r = await fetch(base + path, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  return r.json();
}

http
  .createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', service: 'gateway' }));
    if (req.url === '/api/services') return res.end(JSON.stringify(['service01', 'service02']));
    const m = req.url.match(/^\/api\/(service0[12])(\/.*)?$/);
    if (m) {
      try {
        res.end(JSON.stringify(await proxy(m[1], m[2] || '/health')));
      } catch (e) {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
      }
      return;
    }
    res.end(JSON.stringify({ service: 'gateway', hint: 'try /api/service01/health' }));
  })
  .listen(port, () => console.log(`gateway on ${port}`));
