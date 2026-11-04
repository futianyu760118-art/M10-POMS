'use strict';

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..', '..');
const port = 44000 + Math.floor(Math.random() * 1000);
const origin = 'https://public.example';

function request(method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers }
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.setTimeout(1500, () => req.destroy(new Error('request timeout')));
    req.end(payload);
  });
}

async function waitForServer() {
  let last;
  for (let i = 0; i < 30; i += 1) {
    try { return await request('GET', '/health'); } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw last || new Error('BFF did not start');
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm10-public-leads-http-'));
  const child = spawn(process.execPath, ['apps/bff/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      M10_REQUIRE_AUTH: 'true',
      PORT: String(port),
      PUBLIC_BFF_ALLOWED_ORIGINS: origin,
      PUBLIC_BFF_CAPTCHA_MODE: 'disabled',
      PUBLIC_BFF_OUTBOX_FILE: path.join(dir, 'outbox.jsonl'),
      PUBLIC_BFF_DLQ_FILE: path.join(dir, 'dlq.jsonl')
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    assert.equal((await waitForServer()).status, 200);
    const preflight = await request('OPTIONS', '/api/v1/public/leads', undefined, { Origin: origin });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], origin);

    const payload = {
      name: '官网客户', phone: '13800138000', interest: '工业照明', message: '请联系我',
      consent: { granted: true, version: 'privacy-v1', purpose: '业务联系' }
    };
    const first = await request('POST', '/api/v1/public/leads', payload, { Origin: origin, 'Idempotency-Key': 'http-001' });
    assert.equal(first.status, 202);
    assert.match(first.body.lead_reference, /^lead_/);
    const duplicate = await request('POST', '/api/v1/public/leads', payload, { Origin: origin, 'Idempotency-Key': 'http-001' });
    assert.deepEqual(duplicate.body, first.body);
    assert.equal((await request('POST', '/api/v1/public/leads', payload, { Origin: 'https://evil.example', 'Idempotency-Key': 'http-evil' })).status, 403);
    assert.equal((await request('POST', '/api/v1/public/leads', payload, { Origin: origin, 'Idempotency-Key': 'http-no-content-type', 'Content-Type': '' })).status, 415);
    assert.equal((await request('POST', '/api/v1/public/leads', { name: '无同意', phone: '13800138000', interest: 'x' }, { Origin: origin, 'Idempotency-Key': 'http-invalid' })).status, 400);
    console.log('Public Lead BFF HTTP boundary: 8 checks passed');
  } finally {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 1000);
    });
    if (child.exitCode !== null && child.exitCode !== 0 && stderr) process.stderr.write(stderr);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
