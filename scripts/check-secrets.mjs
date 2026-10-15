import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
const patterns = [
  new RegExp('s' + 'k-(?:proj-)?[A-Za-z0-9_-]{30,}'),
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----(?:\r?\n|\\n)[A-Za-z0-9+/=]{40,}/,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/,
];
const bad = [];
for (const file of files) {
  const secretFile = /(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.example');
  if (secretFile || /(^|\/)(data|backups|secrets|node_modules)\//.test(file)) {
    bad.push(file);
    continue;
  }
  try {
    if (patterns.some((p) => p.test(readFileSync(file, 'utf8')))) bad.push(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
if (process.argv.includes('--build')) {
  try {
    loadEnvFile('.env.local');
  } catch {}
  const secret = process.env.OPENAI_API_KEY,
    dist = process.env.NEXT_DIST_DIR || '.next';
  function scan(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        scan(file);
        continue;
      }
      const content = readFileSync(file, 'utf8');
      if ((secret && content.includes(secret)) || patterns.some((p) => p.test(content)))
        bad.push(file);
      if (file.endsWith('.nft.json')) {
        const traced = JSON.parse(content).files || [];
        if (
          traced.some(
            (p) =>
              !p.includes('node_modules') &&
              /(?:^|\/)(?:\.env(?:\.|$)|data\/|backups\/|\.git\/|\.tools\/)/.test(p),
          )
        )
          bad.push(file);
      }
    }
  }
  scan(join(dist, 'static'));
  scan(join(dist, 'server'));
}
if (bad.length) {
  console.error('Potential secrets or private artifacts in: ' + [...new Set(bad)].join(', '));
  process.exit(1);
}
console.log(
  'No secret patterns or private artifacts found' +
    (process.argv.includes('--build')
      ? ' in source or deployable build files.'
      : ' in project files.'),
);
