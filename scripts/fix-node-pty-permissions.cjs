const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');

if (!fs.existsSync(root)) process.exit(0);

for (const platformDir of fs.readdirSync(root)) {
  const helper = path.join(root, platformDir, 'spawn-helper');
  if (!fs.existsSync(helper)) continue;
  fs.chmodSync(helper, 0o755);
}
