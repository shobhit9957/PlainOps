// Live proof of stale-PATH discovery: run detectClouds() with NO env
// overrides in a shell whose PATH is missing gcloud/az. The old resolver
// reported "not found"; the well-known-location fallback must find both.
delete process.env.PLAINOPS_GCLOUD_PATH;
delete process.env.PLAINOPS_AZ_PATH;
delete process.env.PLAINOPS_AWS_PATH;

const { spawnSync } = await import('node:child_process');
for (const tool of ['aws', 'gcloud', 'az']) {
  const res = spawnSync('where', [tool], { encoding: 'utf8', shell: false });
  console.log(`where ${tool}: ${res.status === 0 ? res.stdout.trim().split(/\r?\n/)[0] : 'NOT ON THIS SHELL\'S PATH'}`);
}

const { resolveCloudBin, detectClouds } = await import('../../src/clouds/cloudcli.ts');
console.log('resolved gcloud →', resolveCloudBin('gcp'));
console.log('resolved az     →', resolveCloudBin('azure'));
const status = await detectClouds();
console.log('detectClouds.gcp   :', status.gcp.installed ? `installed (${status.gcp.detail})` : 'NOT FOUND ✗');
console.log('detectClouds.azure :', status.azure.installed ? `installed (${status.azure.detail})` : 'NOT FOUND ✗');
if (!status.gcp.installed || !status.azure.installed) {
  throw new Error('fallback discovery failed');
}
console.log('STALE-PATH DISCOVERY PROOF: both CLIs found without PATH or env overrides ✓');
