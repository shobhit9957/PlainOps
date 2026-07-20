const express = require('express');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/hello', (_req, res) => {
  res.json({
    msg: 'Hello from your app, deployed by PLAINOPS!',
    host: os.hostname(),
    time: new Date().toISOString(),
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Sample app listening on port ${PORT}`);
});
