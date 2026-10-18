// The worker reloads itself when CODE_VERSION in background.js differs from
// manifest.json, so the two must be bumped together or every install would
// reload in a loop. Run: node extension/test/version.test.js
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;
const src = fs.readFileSync(path.join(dir, 'background.js'), 'utf8');
const m = /const CODE_VERSION = '([^']+)'/.exec(src);

if (!m) {
  console.error('FAIL: background.js has no CODE_VERSION constant');
  process.exit(1);
}
if (m[1] !== manifest) {
  console.error('FAIL: background.js CODE_VERSION is ' + m[1] + ' but manifest.json says ' + manifest);
  process.exit(1);
}
console.log('ok   CODE_VERSION and manifest.json agree on ' + manifest);
