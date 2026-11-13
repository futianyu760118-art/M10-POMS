'use strict';
// adapters/ebms — EBMS 企业经营管理（M03）只读接入
// 连接标准与 PLM/SPC/CRM 一致：服务端账号登录 → Bearer → REST 只读；401 自动重登；失败明确 503。
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const LOCAL_CONF = path.join(__dirname, '..', '..', 'configs', 'ebms.local.json');
function localConf() {
  if (process.env.EBMS_DISABLED === '1') return {};
  try { return JSON.parse(fs.readFileSync(LOCAL_CONF, 'utf8')); } catch (e) { return {}; }
}
function apiBase() {
  if (process.env.EBMS_DISABLED === '1') return '';
  return (process.env.EBMS_API || localConf().api || 'http://127.0.0.1:3010').replace(/\/$/, '');
}
function creds() {
  if (process.env.EBMS_DISABLED === '1') return { user: '', pass: '' };
  const c = localConf();
  return { user: process.env.EBMS_USER || c.user || 'admin', pass: process.env.EBMS_PASS || c.pass || 'admin123' };
}

let token = null, tokenAt = 0;
const CACHE = new Map();

function request(method, pathname, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(apiBase() + pathname + (o.query ? '?' + new URLSearchParams(o.query).toString() : ''));
    const lib = u.protocol === 'https:' ? https : http;
    let body = null;
    const headers = { Accept: 'application/json' };
    if (o.body) {
      body = Buffer.from(JSON.stringify(o.body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = body.length;
    }
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = lib.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method, headers, timeout: 12000
    }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => {
        const text = Buffer.concat(c).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) { /* ignore */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('EBMS 请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

function configured() { const c = creds(); return !!(apiBase() && c.user && c.pass); }

async function login(username, password) {
  const c = creds();
  const user = username || c.user, pass = password || c.pass;
  if (!apiBase()) { const e = new Error('未配置 EBMS 地址（EBMS_API）'); e.status = 503; throw e; }
  if (!user || !pass) { const e = new Error('未配置 EBMS 账号'); e.status = 503; throw e; }
  const r = await request('POST', '/api/users/login', { body: { username: user, password: pass } });
  const t = r.body && r.body.token;
  if (r.status !== 200 || !t) {
    const e = new Error((r.body && (r.body.error || r.body.message)) || ('EBMS 登录失败(' + r.status + ')'));
    e.status = r.status === 200 ? 502 : r.status;
    throw e;
  }
  token = t; tokenAt = Date.now();
  return t;
}

async function getData(pathname, params) {
  if (!token || Date.now() - tokenAt > 20 * 60 * 1000) await login();
  let r = await request('GET', pathname, { query: params });
  if (r.status === 401) { token = null; await login(); r = await request('GET', pathname, { query: params }); }
  if (r.status === 200 && r.body) return r.body;
  const e = new Error((r.body && (r.body.error || r.body.message)) || ('EBMS 返回 ' + r.status));
  e.status = r.status === 200 ? 502 : r.status;
  throw e;
}

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
  if (!configured()) return { connected: false, configured: false, api: apiBase() || null, error: '未配置 EBMS 地址或账号' };
  try {
    await login();
    return { connected: true, configured: true, api: apiBase(), checkedAt: new Date().toISOString() };
  } catch (e) {
    return { connected: false, configured: true, api: apiBase(), error: e.message, checkedAt: new Date().toISOString() };
  }
}

const systemStatus = () => cached('ebms-status', () => getData('/api/m10/status'));
const workspace = (personId) => cached('ws:' + personId, () => getData('/api/m10/me/workspace', { person_id: personId }));
const workItems = (personId) => cached('wi:' + personId, () => getData('/api/m10/me/work-items', { person_id: personId }));
const results = (personId) => cached('res:' + personId, () => getData('/api/m10/me/results', { person_id: personId }));

// EBMS 待办（M10 契约：/api/m10/me/work-items 待办 + /api/m10/me/results 待验收）→ 总表统一归集
async function listTodos(opts) {
  const o = opts || {};
  const out = [];
  const counts = { work_item: 0, result: 0 };
  const push = (o2) => { if (o2.id) out.push(o2); };

  // 待办工作项
  try {
    const wi = await getData('/api/m10/me/work-items', {});
    const items = (wi && wi.items) || [];
    counts.work_item = items.length;
    items.forEach(x => push({
      id: 'ebms:wi:' + (x.id || x.code || x.work_item_id || ''),
      kind: 'work_item',
      title: x.title || x.name || x.summary || 'EBMS 待办',
      owner: x.owner || x.assignee || '',
      due: x.due_at ? String(x.due_at).slice(0, 10) : (x.dueAt ? String(x.dueAt).slice(0, 10) : null),
      priority: 'medium',
      status: x.status === 'in_progress' ? 'in_progress' : 'pending',
      domain: 'OPS',
      refs: { kind: 'work_item', status: x.status }
    }));
  } catch (e) { /* 待办不可达不阻断其它 */ }

  // 待验收结果
  try {
    const res = await getData('/api/m10/me/results', {});
    const list = (res && res.results) || [];
    const pending = list.filter(r => !r.verification || r.verification === 'pending');
    counts.result = pending.length;
    pending.forEach(x => push({
      id: 'ebms:res:' + (x.result_id || x.source_object_id || ''),
      kind: 'result',
      title: '待验收：' + (x.title || '结果'),
      owner: x.verified_by || '',
      due: x.occurred_at ? String(x.occurred_at).slice(0, 10) : null,
      priority: 'medium',
      status: 'pending',
      domain: 'OPS',
      refs: { kind: 'result', resultId: x.result_id, sourceObjectId: x.source_object_id, verification: x.verification }
    }));
  } catch (e) { /* 结果不可达不阻断其它 */ }

  return { source: 'ebms', today: o.today || new Date().toISOString().slice(0, 10), items: out, counts };
}

module.exports = { configured, status, login, systemStatus, workspace, workItems, results, listTodos };
