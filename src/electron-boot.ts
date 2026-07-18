import type { AddressInfo } from 'node:net';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

/**
 * Boot the PlainOps server inside the Electron main process and report the
 * port. If the configured port is taken (e.g. a dev `npm start` is running),
 * fall back to an ephemeral port so the desktop app always opens.
 */
export async function startServer(): Promise<number> {
  const cfg = loadConfig();
  const app = createServer();
  return new Promise((resolve, reject) => {
    const srv = app.listen(cfg.port, '127.0.0.1', () => resolve(cfg.port));
    srv.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        const s2 = app.listen(0, '127.0.0.1', () => resolve((s2.address() as AddressInfo).port));
        s2.on('error', reject);
      } else {
        reject(e);
      }
    });
  });
}
