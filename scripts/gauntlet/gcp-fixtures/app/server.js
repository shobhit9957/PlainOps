// Minimal Cloud Run app: listens on $PORT (Cloud Run's contract), serves a marker.
const http = require('http');
const port = process.env.PORT || 8080;
const marker = process.env.APP_MARKER || 'GCP-GAUNTLET-APP';
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body><h1>${marker}</h1><p>ok</p></body></html>`);
  })
  .listen(port, () => console.log(`listening on ${port}`));
