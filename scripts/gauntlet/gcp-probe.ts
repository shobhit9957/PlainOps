// Live read-path proof for GCP without billable resources: run the estate
// scanner and a gated read command against the real project.
import { scanGcpEstate } from '../../src/clouds/estate.ts';
import { runCloudCli, classifyCloud } from '../../src/clouds/cloudcli.ts';

const project = process.argv[2] ?? 'green-dispatch-487909-g5';
const region = process.argv[3] ?? 'asia-south1';

// 1. A gated read command through the product's own classifier + runner.
const cls = classifyCloud('gcp', ['projects', 'describe', project]);
console.log(`classify "gcloud projects describe" → ${cls.kind}`);
const desc = await runCloudCli('gcp', ['projects', 'describe', project, '--format=value(projectId,projectNumber,lifecycleState)'], 30_000);
console.log(`live read (exit ${desc.code}): ${(desc.stdout || desc.stderr).trim().split(/\r?\n/)[0]}`);

// 2. The full estate/diagnosis sweep — proves every gcloud call path executes
//    live (this is what runs the Windows spaced-path + filter-quoting fixes).
console.log('\n=== scanGcpEstate (live) ===');
console.log(await scanGcpEstate(project, region));
