'use strict';

// PlainOps desktop shell: boots the local Express server in-process and shows
// the dashboard in a window. All product logic lives in dist/src — this file
// stays a thin frame.

const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

process.env.PLAINOPS_NO_OPEN = '1';

let win = null;

async function start() {
  const bootUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'src', 'electron-boot.js')).href;
  const boot = await import(bootUrl);
  const port = await boot.startServer();

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

  await win.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(() =>
  start().catch((e) => {
    const { dialog } = require('electron');
    dialog.showErrorBox('PlainOps failed to start', String((e && e.stack) || e));
    app.quit();
  }),
);

app.on('window-all-closed', () => app.quit());
