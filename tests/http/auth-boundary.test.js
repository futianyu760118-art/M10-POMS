'use strict';

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const port = 43000 + Math.floor(Math.random() * 1000);

function request(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(1500, () => req.destroy(new Error('request timeout')));
  });
}

function postJson(pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(1500, () => req.destroy(new Error('request timeout')));
    req.end(payload);
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
  const mockPlm = http.createServer((req, res) => {
    if (req.url === '/api/auth/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: {
        userId: 'unmapped-user', username: 'unmapped-user', realName: '未登记人员', roles: ['viewer']
      } }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => mockPlm.listen(0, '127.0.0.1', resolve));
  const plmPort = mockPlm.address().port;
  const child = spawn(process.execPath, ['apps/bff/server.js'], {
    cwd: root,
    env: { ...process.env, M10_REQUIRE_AUTH: 'true', NODE_ENV: 'test', PORT: String(port), PLM_API: `http://127.0.0.1:${plmPort}` },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    assert.strictEqual(await waitForServer(), 200, 'public portal must remain reachable');
    assert.strictEqual(await request('/health'), 200, 'health endpoint must remain public');
    assert.strictEqual(await request('/api/v1/plm2/roles'), 401, 'anonymous API access must fail closed');
    assert.strictEqual(await request('/api/v1/plm2/auth/me'), 401, 'current-user endpoint must reject missing token');
    assert.strictEqual(await request('/api/v1/poms/me/workspace?person_id=p-002', { Authorization: 'Bearer valid-token' }), 401, 'unmapped token must not fall back to person_id query');
    assert.strictEqual(await postJson('/api/v1/plm2/materials/HJ202607230001/transition', { action: 'submit_review', role: 'ADMIN' }, { Authorization: 'Bearer valid-token' }), 403, 'client role must not override verified role');
    console.log('M10 BFF auth boundary: 6 checks passed');
  } finally {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 1000);
    });
    if (child.exitCode !== null && child.exitCode !== 0 && stderr) process.stderr.write(stderr);
    mockPlm.close();
  }
})().catch(err => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
