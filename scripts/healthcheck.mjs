import { request } from 'node:http';
const base = new URL(process.env.APP_URL || 'http://127.0.0.1:3000'),
  privateCheck = process.argv.includes('--unauthenticated');
// Node fetch deliberately ignores caller-supplied Host. Native HTTP is required behind this strict host boundary.
const req = request(
  {
    hostname: '127.0.0.1',
    port: process.env.PORT || 3000,
    path: privateCheck ? '/api/state' : '/api/ready',
    headers: { Host: base.host },
  },
  (res) => {
    res.resume();
    process.exit(res.statusCode === (privateCheck ? 401 : 200) ? 0 : 1);
  },
);
req.setTimeout(4000, () => req.destroy());
req.on('error', () => process.exit(1));
req.end();
