const { execFile } = require('node:child_process');
const bin = String.raw`C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`;
const run = (label, file) =>
  new Promise((res) =>
    execFile(file, ['config', 'get-value', 'project'], { shell: true, windowsHide: true, timeout: 30000 }, (e, so, se) => {
      console.log(label, '→', e ? 'FAIL: ' + String(se || e).split('\n')[0] : 'OK: ' + so.trim());
      res();
    }),
  );
(async () => {
  await run('unquoted', bin);
  await run('quoted  ', `"${bin}"`);
})();
