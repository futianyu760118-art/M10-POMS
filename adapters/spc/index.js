'use strict';
// adapters/spc — 供应链与生产协同中台（SPC）只读接入
// 连接标准与 PLM 一致：服务端账号登录 → Bearer 令牌 → REST 只读；令牌自动续期，401 自动重登。
// 不直连数据库、不写业务数据；不可达时明确 503，若有旧缓存则返回并标 stale（不假装最新）。
const http = require('http');
const https = require('https');

function apiBase() { return (process.env.SPC_API || '').replace(/\/$/, ''); }
function creds() { return { user: process.env.SPC_USER || '', pass: process.env.SPC_PASS || '' }; }

let token = null, tokenAt = 0;
const CACHE = new Map(); // key -> {at, data}
const TTL = Number(process.env.SPC_CACHE_MS || 60000);

function request(method, pathname, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const base = apiBase();
    const u = new URL(base + pathname + (o.query ? '?' + new URLSearchParams(o.query).toString() : ''));
    const lib = u.protocol === 'https:' ? https : http;
    let body = null;
    const headers = { Accept: 'application/json' };
    if (o.form) {
      body = Buffer.from(new URLSearchParams(o.form).toString());
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = body.length;
    }
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = lib.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method, headers, timeout: 12000
    }, res => {
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) { /* non-json */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('SPC 请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

function configured() { const c = creds(); return !!(apiBase() && c.user && c.pass); }

async function login(username, password) {
  const user = username || creds().user;
  const pass = password || creds().pass;
  if (!apiBase()) { const e = new Error('未配置 SPC 地址（SPC_API）'); e.status = 503; throw e; }
  if (!user || !pass) { const e = new Error('未配置 SPC 账号（SPC_USER/SPC_PASS）'); e.status = 503; throw e; }
  const r = await request('POST', '/api/v1/basicdata/auth/login', {
    form: { username: user, password: pass, login_type: 'employee', channel: 'web' }
  });
  const t = r.body && r.body.data && r.body.data.access_token;
  if (r.status !== 200 || !t) {
    const msg = (r.body && (r.body.detail || r.body.message)) || ('SPC 登录失败(' + r.status + ')');
    const e = new Error(typeof msg === 'string' ? msg : 'SPC 登录失败');
    e.status = r.status === 200 ? 502 : r.status;
    throw e;
  }
  token = t; tokenAt = Date.now();
  return t;
}

async function authed(method, pathname, opts) {
  if (!token || Date.now() - tokenAt > 20 * 60 * 1000) await login();
  let r = await request(method, pathname, opts);
  if (r.status === 401) { token = null; await login(); r = await request(method, pathname, opts); }
  return r;
}

function pick(r) {
  // SPC 统一返回 {code, message, data}
  if (r.status === 200 && r.body && r.body.data !== undefined) return r.body.data;
  const msg = (r.body && (r.body.detail || r.body.message)) || ('SPC 返回 ' + r.status);
  const e = new Error(typeof msg === 'string' ? msg : 'SPC 请求失败');
  e.status = r.status === 200 ? 502 : r.status;
  throw e;
}

async function getData(pathname, params) {
  const r = await authed('GET', pathname, { query: params });
  return pick(r);
}

/** 带短期缓存与降级的读取：失败时返回旧数据并标 stale */
async function cached(key, fn) {
  const hit = CACHE.get(key);
  try {
    const data = await fn();
    CACHE.set(key, { at: Date.now(), data });
    return { ok: true, stale: false, cachedAt: new Date().toISOString(), data };
  } catch (e) {
    if (hit) return { ok: true, stale: true, cachedAt: new Date(hit.at).toISOString(), data: hit.data, warning: e.message };
    throw e;
  }
}

async function status() {
  if (!configured()) {
    return { connected: false, configured: false, api: apiBase() || null, error: '未配置 SPC 地址或账号（SPC_API/SPC_USER/SPC_PASS）' };
  }
  try {
    await login();
    return { connected: true, configured: true, api: apiBase(), checkedAt: new Date().toISOString() };
  } catch (e) {
    return { connected: false, configured: true, api: apiBase(), error: e.message, checkedAt: new Date().toISOString() };
  }
}

const PARTS = {
  summary: '/api/v1/dashboard/summary',
  today: '/api/v1/dashboard/today-overview',
  rollingRisk: '/api/v1/dashboard/rolling-risk',
  riskDistribution: '/api/v1/dashboard/order-risk-distribution',
  closure: '/api/v1/dashboard/closure-achievement'
};

async function dashboard() {
  const out = {};
  const errors = {};
  await Promise.all(Object.keys(PARTS).map(async k => {
    try { out[k] = await cached('dashboard:' + k, () => getData(PARTS[k])); }
    catch (e) { out[k] = null; errors[k] = e.message; }
  }));
  if (Object.keys(errors).length === Object.keys(PARTS).length) {
    const e = new Error('SPC 控制塔读取失败：' + Object.values(errors)[0]);
    e.status = 503;
    throw e;
  }
  return { parts: out, errors, stale: Object.values(out).some(x => x && x.stale) };
}

const orders = (p) => cached('orders:' + JSON.stringify(p || {}), () => getData('/api/v1/dashboard/orders', p));
const materials = (p) => cached('materials:' + JSON.stringify(p || {}), () => getData('/api/v1/dashboard/materials', p));
const exceptions = (p) => cached('exceptions:' + JSON.stringify(p || {}), () => getData('/api/v1/exceptions', p));
const supplierRisk = (p) => cached('supplier-risk:' + JSON.stringify(p || {}), () => getData('/api/v1/materials/supplier-risk', p));

module.exports = { configured, status, login, dashboard, orders, materials, exceptions, supplierRisk, PARTS };
