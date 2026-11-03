'use strict';
// adapters/crm — CRM 销售自治中心（M05）只读接入
// 连接标准与 PLM/SPC 一致：服务端账号登录 → Bearer 令牌 → REST 只读；401 自动重登；失败明确 503。
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const LOCAL_CONF = path.join(__dirname, '..', '..', 'configs', 'crm.local.json');
function localConf() {
  if (process.env.CRM_DISABLED === '1') return {};
  try { return JSON.parse(fs.readFileSync(LOCAL_CONF, 'utf8')); } catch (e) { return {}; }
}
function apiBase() {
  if (process.env.CRM_DISABLED === '1') return '';
  return (process.env.CRM_API || localConf().api || 'http://127.0.0.1:8000').replace(/\/$/, '');
}
function creds() {
  if (process.env.CRM_DISABLED === '1') return { user: '', pass: '' };
  const c = localConf();
  return { user: process.env.CRM_USER || c.user || 'admin', pass: process.env.CRM_PASS || c.pass || 'admin123' };
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
    req.setTimeout(12000, () => req.destroy(new Error('CRM 请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

function configured() { const c = creds(); return !!(apiBase() && c.user && c.pass); }

async function login(username, password) {
  const c = creds();
  const user = username || c.user, pass = password || c.pass;
  if (!apiBase()) { const e = new Error('未配置 CRM 地址（CRM_API）'); e.status = 503; throw e; }
  if (!user || !pass) { const e = new Error('未配置 CRM 账号（CRM_USER/CRM_PASS）'); e.status = 503; throw e; }
  const r = await request('POST', '/api/v1/auth/login', { body: { username: user, password: pass } });
  const t = r.body && r.body.data && r.body.data.access_token;
  if (r.status !== 200 || !t) {
    const e = new Error((r.body && r.body.message) || ('CRM 登录失败(' + r.status + ')'));
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
  if (r.status === 200 && r.body && r.body.data !== undefined) return r.body.data;
  const e = new Error((r.body && (r.body.message || r.body.detail)) || ('CRM 返回 ' + r.status));
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
  if (!configured()) return { connected: false, configured: false, api: apiBase() || null, error: '未配置 CRM 地址或账号' };
  try {
    await login();
    return { connected: true, configured: true, api: apiBase(), checkedAt: new Date().toISOString() };
  } catch (e) {
    return { connected: false, configured: true, api: apiBase(), error: e.message, checkedAt: new Date().toISOString() };
  }
}

const dashboard = () => cached('dashboard', () => getData('/api/v1/dashboard'));
const leads = (p) => cached('leads:' + JSON.stringify(p || {}), () => getData('/api/v1/leads', p));
const customers = (p) => cached('customers:' + JSON.stringify(p || {}), () => getData('/api/v1/customers', p));
const opportunities = (p) => cached('opps:' + JSON.stringify(p || {}), () => getData('/api/v1/opportunities', p));
const tasksMine = (p) => cached('tasks:' + JSON.stringify(p || {}), () => getData('/api/v1/tasks/mine', p));
const orders = (p) => cached('orders:' + JSON.stringify(p || {}), () => getData('/api/v1/orders', p));
const approvalsCount = () => cached('approvals', () => getData('/api/v1/approvals/count'));
const approvals = (p) => cached('approvals-list:' + JSON.stringify(p || {}), () => getData('/api/v1/approvals', p));

/** 写操作：经 CRM 官方接口执行（服务端令牌，前端不接触） */
async function sendData(method, pathname, body) {
  if (!token || Date.now() - tokenAt > 20 * 60 * 1000) await login();
  let r = await request(method, pathname, { body });
  if (r.status === 401) { token = null; await login(); r = await request(method, pathname, { body }); }
  if (r.status >= 200 && r.status < 300) {
    ['leads:', 'opps:', 'orders:', 'tasks:', 'approvals'].forEach(k => { for (const key of [...CACHE.keys()]) if (key.startsWith(k)) CACHE.delete(key); });
    return r.body && r.body.data !== undefined ? r.body.data : (r.body || {});
  }
  const e = new Error((r.body && (r.body.message || r.body.detail)) || ('CRM 返回 ' + r.status));
  e.status = r.status;
  throw e;
}
const advanceStage = (oppId, body) => sendData('PATCH', '/api/v1/opportunities/' + encodeURIComponent(oppId) + '/stage', body || {});
const completeTask = (taskId) => sendData('POST', '/api/v1/tasks/' + encodeURIComponent(taskId) + '/complete', {});
const approve = (id, comment) => sendData('POST', '/api/v1/approvals/' + encodeURIComponent(id) + '/approve', { comment: comment || null });
const reject = (id, comment) => sendData('POST', '/api/v1/approvals/' + encodeURIComponent(id) + '/reject', { comment: comment || null });
const assignLead = (leadId, ownerId) => sendData('POST', '/api/v1/leads/' + encodeURIComponent(leadId) + '/assign', { owner_id: ownerId });

module.exports = {
  configured, status, login, dashboard, leads, customers, opportunities, tasksMine, orders,
  approvalsCount, approvals, advanceStage, completeTask, approve, reject, assignLead
};
