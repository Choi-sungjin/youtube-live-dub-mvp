if (process.env.CLAUDE_CODE_REMOTE !== 'true') process.exit(0);

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error('YouTube Live Dub requires Node.js >=20; Node.js 22 is recommended.');
  process.exit(1);
}
console.log('YouTube Live Dub cloud development environment is ready.');
console.log(`Runtime: Node ${process.version}, ${process.platform}/${process.arch}. No npm dependencies to install.`);
console.log('Read CLAUDE.md. Run npm run test:cloud before and after changes.');
console.log('Tests use local fixtures and mock providers. Windows SAPI, Chrome playback and real API validation remain local checks.');
