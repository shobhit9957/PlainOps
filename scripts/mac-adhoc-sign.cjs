// Ad-hoc sign the macOS app after packing. Apple Silicon refuses to run
// UNSIGNED binaries at all (the "damaged and can't be opened" dialog), so
// every mac build must carry at least an ad-hoc signature. This does not —
// cannot — remove Gatekeeper's browser-download warning (that needs an Apple
// Developer ID + notarization); it makes the app RUN once quarantine is
// absent (terminal installs) or lifted (xattr -cr / "Open Anyway").
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${appName} (${path.basename(context.appOutDir)})`);
};
