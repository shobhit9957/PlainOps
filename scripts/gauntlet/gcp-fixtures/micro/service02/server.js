const http = require('http');
const port = process.env.PORT || 8080;
http
  .createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'service02' }));
  })
  .listen(port, () => console.log(`service02 on ${port}`));
