const http = require('http');
const port = process.env.PORT || 8080;
http
  .createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'service01' }));
  })
  .listen(port, () => console.log(`service01 on ${port}`));
