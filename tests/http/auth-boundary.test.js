'use strict';

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const port = 43000 + Math.floor(Math.random() * 1000);

function request(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(1500, () => req.destroy(new Error('request timeout')));
  });
}

async function waitForServer() {
  let last;
  for (let i = 0; i < 30; i += 1) {
    try { return await request('/'); } catch (e) { last = e; await new Promise(r => setTimeout(r, 100)); }
  }
  throw last || new Error('BFF did not start');
}

(async () => {
  const child = spawn(process.execPath, ['apps/bff/server.js'], {
    cwd: root,
    env: { ...process.env, M10_REQUIRE_AUTH: 'true', NODE_ENV: 'test', PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    assert.strictEqual(await waitForServer(), 200, 'public portal must remain reachable');
    assert.strictEqual(await request('/api/v1/plm2/roles'), 401, 'anonymous API access must fail closed');
    assert.strictEqual(await request('/api/v1/plm2/auth/me'), 401, 'current-user endpoint must reject missing token');
    console.log('M10 BFF auth boundary: 3 checks passed');
  } finally {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 1000);
    });
    if (child.exitCode !== null && child.exitCode !== 0 && stderr) process.stderr.write(stderr);
  }
})().catch(err => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
