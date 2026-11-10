import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const files = [];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full);
    else if (/\.[cm]?js$/.test(entry.name)) files.push(full);
  }
}
for (const dir of ['api', 'backend', 'extension', 'lib', 'native-host', 'scripts']) await collect(dir);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
if (pkg.version !== manifest.version) throw new Error('Package and extension versions differ.');
console.log(`Syntax OK: ${files.length} JavaScript files; extension v${manifest.version}`);
