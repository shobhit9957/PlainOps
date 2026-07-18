'use strict';

// PlainOps desktop shell: boots the local Express server in-process and shows
// the dashboard in a window. All product logic lives in dist/src — this file
// stays a thin frame.

const { app, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

process.env.PLAINOPS_NO_OPEN = '1';

// Many founders run Windows in a VM or over RDP, where Electron's GPU process
// can wedge the whole app at startup (observed here: intermittent freezes
// before the window appears). The dashboard needs no GPU — turn it off.
app.disableHardwareAcceleration();

// Boot log for support: every launch appends its milestones, so "the app
// won't open" always comes with evidence. Lives next to the rest of the data.
const LOG = path.join(process.env.PLAINOPS_HOME || path.join(os.homedir(), '.plainops'), 'desktop.log');
function bootLog(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {
    /* logging must never break the app */
  }
}
bootLog(`--- launch v${app.getVersion()} ---`);

let win = null;

async function start() {
  bootLog('start()');
  const bootUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'src', 'electron-boot.js')).href;
  const boot = await import(bootUrl);
  bootLog('engine loaded');
  const port = await boot.startServer();
  bootLog(`server listening on ${port}`);

  // Cold starts on VMs (antivirus rescans after install, slow disks) have
  // produced windows that navigate before the server answers. Don't load the
  // window until the server provably serves HTTP.
  let verified = false;
  for (let i = 0; i < 20 && !verified; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2000) });
      verified = res.ok;
    } catch {
      /* not up yet */
    }
    if (!verified) await new Promise((r) => setTimeout(r, 500));
  }
  bootLog(verified ? 'server verified over HTTP' : 'server DID NOT verify after 10s — loading anyway');

  win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0F1519',
    autoHideMenuBar: true,
    title: 'PlainOps',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Live app URLs and docs open in the user's real browser, not inside the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`) && !url.startsWith(`http://localhost:${port}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // A failed first navigation must not kill the app — retry, then surface.
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await win.loadURL(`http://127.0.0.1:${port}`);
      bootLog(`dashboard loaded (attempt ${attempt})`);
      return;
    } catch (e) {
      lastErr = e;
      bootLog(`loadURL attempt ${attempt} failed: ${(e && e.message) || e}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

app.whenReady().then(() =>
  start().catch((e) => {
    bootLog(`FATAL: ${String((e && e.stack) || e)}`);
    const { dialog } = require('electron');
    dialog.showErrorBox('PlainOps failed to start', String((e && e.stack) || e) + `\n\nLog: ${LOG}`);
    app.quit();
  }),
);

app.on('window-all-closed', () => app.quit());
