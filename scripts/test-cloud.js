import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = {
  ...process.env,
  NODE_ENV: 'test',
  TRANSLATION_PROVIDER: 'mock',
  TTS_PROVIDER: 'mock-wav',
  // Empty values prevent local .env files from supplying real provider keys.
  ZAI_API_KEY: '',
  OPENAI_API_KEY: '',
  SUPERTONE_API_KEY: ''
};
const checks = [
  ['Syntax and version consistency', ['scripts/check.js']],
  ['Regression tests (local fixtures)', ['--test', 'scripts/test-regressions.js', 'scripts/test-caption-context.js', 'scripts/test-media-session.js', 'scripts/test-installer-health.js', 'scripts/test-generic-media.js', 'scripts/test-openai-modes.js', 'scripts/test-page-probe.js', 'scripts/test-popup-version.js']],
  ['Mock translation/audio contract', ['scripts/test-vercel-core.js']]
];

console.log(`Cloud checks: Node ${process.version}, ${process.platform}/${process.arch}`);
for (const [name, args] of checks) {
  console.log(`\nRunning: ${name}`);
  const result = spawnSync(process.execPath, args, {
    cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 60000
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}
if (process.platform === 'win32') {
  console.log('\nRunning: Windows installer fixtures (no installation or downloads)');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/test-windows-setup.ps1'], {
    cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 60000
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('\nPASS: cloud development checks. No real translation, TTS, STT, or YouTube browser playback was verified.');
