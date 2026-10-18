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
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{40,}/,
  /hf_[A-Za-z0-9]{30,}/,
  /AIza[A-Za-z0-9_-]{30,}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
];
const personalPaths = /(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]+Users[\\/]+)(?!user\b|example\b|runner\b)[A-Za-z0-9_.-]+/;
function privateArtifact(file) {
  return (
    ((/(^|\/)\.env(?:\.|$)/.test(file)) && !file.endsWith('.example')) ||
    /(^|\/)(data|backups|secrets|node_modules|\.tools|\.aws|\.ssh)\//.test(file) ||
    /\.(?:sqlite(?:3)?|db|jks|keystore|p12|pfx|key|safetensors|litertlm|gguf|apk)(?:$|-)/i.test(file)
  );
}
const bad = [];
for (const file of files) {
  if (privateArtifact(file)) {
    bad.push(file);
    continue;
  }
  try {
    const content = readFileSync(file, 'utf8');
    if (patterns.some((p) => p.test(content)) || personalPaths.test(content)) bad.push(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
if (process.argv.includes('--history')) {
  const objects = execFileSync('git', ['rev-list', '--objects', '--all'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  for (const row of objects) {
    const space = row.indexOf(' ');
    if (space < 0) continue;
    const oid = row.slice(0, space), file = row.slice(space + 1);
    const type = execFileSync('git', ['cat-file', '-t', oid], { encoding: 'utf8' }).trim();
    if (type !== 'blob') continue;
    const content = execFileSync('git', ['cat-file', 'blob', oid], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (privateArtifact(file) || personalPaths.test(content) || patterns.some((p) => p.test(content)))
      bad.push(`history:${file}@${oid.slice(0, 12)}`);
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
      : process.argv.includes('--history') ? ' in project files and reachable Git history.' : ' in project files.'),
);
