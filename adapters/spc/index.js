'use strict';
// adapters/spc — 供应链与生产协同中台（SPC）只读接入
// 连接标准与 PLM 一致：服务端账号登录 → Bearer 令牌 → REST 只读；令牌自动续期，401 自动重登。
// 不直连数据库、不写业务数据；不可达时明确 503，若有旧缓存则返回并标 stale（不假装最新）。
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const LOCAL_CONF = path.join(__dirname, '..', '..', 'configs', 'spc.local.json');
function localConf() {
  if (process.env.SPC_DISABLED === '1') return {};
  try { return JSON.parse(fs.readFileSync(LOCAL_CONF, 'utf8')); } catch (e) { return {}; }
}
function apiBase() { if (process.env.SPC_DISABLED === '1') return ''; return (process.env.SPC_API || localConf().api || '').replace(/\/$/, ''); }
function creds() { if (process.env.SPC_DISABLED === '1') return { user: '', pass: '' }; const c = localConf(); return { user: process.env.SPC_USER || c.user || '', pass: process.env.SPC_PASS || c.pass || '' }; }

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
    } else if (o.json !== undefined) {
      body = Buffer.from(JSON.stringify(o.json));
      headers['Content-Type'] = 'application/json';
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
const etaPending = (p) => cached('eta:' + JSON.stringify(p || {}), () => getData('/api/v1/orders/eta/pending-updates', p));
const quality = (p) => cached('quality:' + JSON.stringify(p || {}), () => getData('/api/v1/exceptions/quality', p));

/**
 * SPC 状态写回（仅异常台账 / 品质处理两类有更新接口；订单/采购由 ERP 只读）。
 * 状态映射：M10 in_progress → SPC in_progress；M10 done → SPC closed。
 */
function mapStatus(s) {
  if (s === 'done' || s === 'closed') return 'closed';
  if (s === 'in_progress' || s === 'processing') return 'in_progress';
  return null;
}

async function updateStatus(kind, spcId, status) {
  const st = mapStatus(status);
  if (!st) { const e = new Error('SPC 只支持处理中/已完成两种状态'); e.status = 422; throw e; }
  if (kind === 'exception') {
    const r = await authed('PUT', '/api/v1/exceptions/' + encodeURIComponent(spcId), { json: { status: st } });
    return pick(r);
  }
  if (kind === 'quality') {
    const r = await authed('PUT', '/api/v1/exceptions/quality/' + encodeURIComponent(spcId), { json: { status: st } });
    return pick(r);
  }
  const e = new Error('该 SPC 待办（订单/采购）由 ERP 管理，请回 SPC 处理，M10 不写回');
  e.status = 409;
  throw e;
}

/**
 * SPC 待办聚合（供 M10 待办总表）：订单交付 / 采购到料 / 品质处理 / 异常台账。
 * 每类限量 50 条，只读引用；写操作回 SPC。
 */
async function listTodos(opts) {
  const d = (opts && opts.today) || new Date().toISOString().slice(0, 10);
  const web = (process.env.SPC_WEB || 'https://spc.hengyou-soft.com').replace(/\/$/, '');
  const out = [];
  const counts = { order: 0, purchase: 0, quality: 0, exception: 0 };
  const stMap = s => s === 'in_progress' || s === 'processing' ? 'in_progress' : (s === 'closed' ? 'done' : 'pending');
  const push = (kind, x, o) => {
    if (!x.id) return;
    out.push(Object.assign({
      id: kind + ':' + x.id, kind, title: '', owner: '', due: null,
      priority: 'medium', status: 'pending', domain: 'OPS', spcId: null, refs: {}, link: ''
    }, o));
  };

  try {
    const r = await orders({ page: 1, page_size: 50, status: 'open' });
    const items = (r.data && r.data.items) || [];
    counts.order = items.length;
    items.forEach(x => {
      const no = String(x.order_no || '').trim();
      const lineNo = String(x.line_no || '').trim();
      push('order', { id: no + ':' + lineNo }, {
        title: '订单交付：' + no, owner: String(x.owner || '').trim(),
        due: x.promised_date || null, priority: x.risk_level === 'red' ? 'high' : (x.risk_level === 'yellow' ? 'medium' : 'low'),
        domain: 'ORDER',
        link: web + '/orders/' + encodeURIComponent(no) + (lineNo ? '/lines/' + encodeURIComponent(lineNo) : ''),
        refs: { orderNo: no, lineNo: lineNo }
      });
    });
  } catch (e) { /* 订单待办不可用不阻断其它 */ }

  try {
    const r = await etaPending({ page: 1, page_size: 50 });
    const items = r.data.items || [];
    counts.purchase = items.length;
    items.forEach(x => {
      const no = String(x.po_no || '').trim();
      const det = String(x.detail_id || x.material_code || '').trim();
      push('purchase', { id: no + ':' + det }, {
        title: '采购到料：' + no + (x.material_name ? ' ' + String(x.material_name).trim() : ''),
        owner: String(x.owner || '').trim(), due: x.eta || null, priority: 'medium', domain: 'PURCHASE',
        link: web + '/purchase-plan?po_no=' + encodeURIComponent(no),
        refs: { poNo: no, detailId: det }
      });
    });
  } catch (e) { /* 采购待办不可用不阻断其它 */ }

  try {
    const [rOpen, rProg] = await Promise.all([
      quality({ page: 1, page_size: 50, status: 'open' }),
      quality({ page: 1, page_size: 50, status: 'in_progress' })
    ]);
    const items = [].concat((rOpen.data && rOpen.data.items) || [], (rProg.data && rProg.data.items) || []);
    counts.quality = items.length;
    items.forEach(x => {
      const no = String(x.issue_no || '').trim();
      push('quality', { id: no }, {
        title: '品质处理：' + no + (x.defect_type ? ' ' + String(x.defect_type).trim() : ''),
        owner: String(x.responsible_person || '').trim(), due: x.temporary_countermeasure_date || null,
        priority: 'high', domain: 'PRODUCTION', status: stMap(x.status),
        spcId: x.id || null, refs: { issueNo: no },
        link: web + '/quality-issues?keyword=' + encodeURIComponent(no)
      });
    });
  } catch (e) { /* 品质待办不可用不阻断其它 */ }

  try {
    const [rOpen, rProg] = await Promise.all([
      exceptions({ page: 1, page_size: 50, status: 'open' }),
      exceptions({ page: 1, page_size: 50, status: 'in_progress' })
    ]);
    const items = [].concat((rOpen.data && rOpen.data.items) || [], (rProg.data && rProg.data.items) || []);
    counts.exception = items.length;
    items.forEach(x => {
      const no = String(x.issue_no || x.id || '').trim();
      push('exception', { id: no }, {
        title: String(x.description || x.issue_no || '').slice(0, 80),
        owner: (x.owner && x.owner !== 'system') ? String(x.owner).trim() : '',
        due: x.commit_date || null,
        priority: x.risk_level === 'red' ? 'high' : (x.risk_level === 'yellow' ? 'medium' : 'low'),
        domain: 'OPS', status: stMap(x.status),
        spcId: x.id || null, refs: { issueNo: no },
        link: web + '/issues?keyword=' + encodeURIComponent(no)
      });
    });
  } catch (e) { /* 异常待办不可用不阻断其它 */ }

  return { today: d, items: out, counts };
}

module.exports = { configured, status, login, dashboard, orders, materials, exceptions, supplierRisk, etaPending, quality, listTodos, updateStatus, PARTS };
