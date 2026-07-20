import open from 'open';
import { loadConfig, isDemoMode } from './config.js';
import { createServer, preflight, maybeStartDemo } from './server.js';
import { startWatchers } from './cicd.js';
import { initFollowups } from './followups.js';
import { runTurn } from './agent/loop.js';

const BANNER = `
  ⚓  PLAINOPS — your self-hosted AI DevOps engineer
      Runs on your machine. Deploys to your cloud. Your credentials stay home.
`;

async function main() {
  console.log(BANNER);
  const cfg = loadConfig();

  const pf = await preflight();
  console.log('  Preflight:');
  console.log(`    Node ≥20 ......... ${pf.node ? 'OK' : 'MISSING'}`);
  console.log(`    git .............. ${pf.git ? 'OK' : 'MISSING'}`);
  console.log(`    OpenTofu/Terraform ${pf.tofu ? 'OK' : 'will auto-download on first use'}`);
  console.log(`    AWS credentials .. ${pf.aws.ok ? `OK (account ${pf.aws.accountId})` : 'NOT FOUND — run `aws configure`'}`);
  console.log(`    Anthropic API key  ${pf.anthropicKey ? 'OK' : 'add it in the dashboard'}`);
  if (isDemoMode()) console.log('\n  DEMO MODE — no AWS or API calls will be made.\n');

  maybeStartDemo();
  if (!isDemoMode()) {
    startWatchers();
    initFollowups((projectName, text) => runTurn(projectName, text));
  }

  const app = createServer();
  const server = app.listen(cfg.port, () => {
    const url = `http://localhost:${cfg.port}`;
    console.log(`\n  Dashboard ready → ${url}\n`);
    if (process.env.PLAINOPS_NO_OPEN !== '1') {
      open(url).catch(() => console.log(`  Open ${url} in your browser.`));
    }
  });

  process.on('SIGINT', () => {
    server.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('Failed to start PLAINOPS:', e);
  process.exit(1);
});
