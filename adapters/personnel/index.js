'use strict';
// adapters/personnel — 人员变动（离职/调岗）跨系统编排：M07（HLC 人事）提交 → M01（身份内核）办理
// 红线：只调官方接口，不直连库、不写专业主数据；高风险动作（离职/调岗）必须人工确认后才执行。
const http = require('http');
const https = require('https');

const HLC_TENANT = process.env.HLC_TENANT || 'HPT-00000001';
function hlcBase() { return (process.env.HLC_API || 'http://localhost:18280').replace(/\/$/, ''); }
function m01Base() { return (process.env.M01_API || 'http://127.0.0.1:3101').replace(/\/$/, ''); }
function hlcCreds() {
  return {
    email: process.env.HLC_USER || 'hlc-admin@demo.local',
    pass: process.env.HLC_PASS || 'Demo-12345678'
  };
}

let hlcToken = null, hlcAt = 0;
let m01Cookie = null, m01At = 0;
const CACHE = new Map();

function request(base, method, pathname, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(base + pathname + (o.query ? '?' + new URLSearchParams(o.query).toString() : ''));
    const lib = u.protocol === 'https:' ? https : http;
    let body = null;
    const headers = Object.assign({ Accept: 'application/json' }, o.headers || {});
    if (o.body) {
      body = Buffer.from(JSON.stringify(o.body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = body.length;
    }
    const req = lib.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method, headers, timeout: 15000
    }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => {
        const text = Buffer.concat(c).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) { /* ignore */ }
        resolve({ status: res.statusCode, body: json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

async function hlcLogin() {
  const c = hlcCreds();
  const r = await request(hlcBase(), 'POST', '/api/auth/login', { body: { identifier: c.email, password: c.pass, tenantSlug: HLC_TENANT } });
  const t = r.body && (r.body.token || (r.body.data && r.body.data.token));
  if (r.status !== 200 || !t) {
    const e = new Error('M07 登录失败(' + r.status + ')'); e.status = r.status === 200 ? 502 : r.status; throw e;
  }
  hlcToken = t; hlcAt = Date.now();
  return t;
}

async function hlcData(method, pathname, opts) {
  if (!hlcToken || Date.now() - hlcAt > 20 * 60 * 1000) await hlcLogin();
  const o = Object.assign({}, opts, { headers: Object.assign({}, (opts && opts.headers) || {}, { Authorization: 'Bearer ' + hlcToken }) });
  let r = await request(hlcBase(), method, pathname, o);
  if (r.status === 401) { hlcToken = null; await hlcLogin(); o.headers.Authorization = 'Bearer ' + hlcToken; r = await request(hlcBase(), method, pathname, o); }
  if (r.status >= 200 && r.status < 300) return r.body;
  const msg = (r.body && (r.body.error || r.body.message || r.body.detail)) || ('M07 返回 ' + r.status);
  const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)); e.status = r.status; throw e;
}

async function m01Login() {
  const r = await request(m01Base(), 'POST', '/auth/demo/login', { body: {} });
  const sc = r.headers['set-cookie'] || [];
  const cookie = (Array.isArray(sc) ? sc : [sc]).map(x => String(x).split(';')[0]).filter(Boolean).join('; ');
  if (r.status !== 200 || !cookie) {
    const e = new Error('M01 登录失败(' + r.status + ')（需要演示登录或 OIDC）'); e.status = r.status === 200 ? 502 : r.status; throw e;
  }
  m01Cookie = cookie; m01At = Date.now();
  return cookie;
}

async function m01Data(method, pathname, opts) {
  if (!m01Cookie || Date.now() - m01At > 6 * 60 * 60 * 1000) await m01Login();
  const o = Object.assign({}, opts, { headers: Object.assign({}, (opts && opts.headers) || {}, { Cookie: m01Cookie }) });
  let r = await request(m01Base(), method, pathname, o);
  if (r.status === 401) { m01Cookie = null; await m01Login(); o.headers.Cookie = m01Cookie; r = await request(m01Base(), method, pathname, o); }
  if (r.status >= 200 && r.status < 300) return r.body;
  const msg = (r.body && (r.body.error || r.body.message)) || ('M01 返回 ' + r.status);
  const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)); e.status = r.status; throw e;
}

function itemsOf(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  return res.items || res.records || res.rows || [];
}

async function lookupMaps() {
  if (CACHE.has('lookup') && Date.now() - CACHE.get('lookup').at < 60000) return CACHE.get('lookup').data;
  const [dep, pos] = await Promise.all([
    hlcData('GET', '/api/hrm/departments', { query: { page: 1, page_size: 200 } }).catch(() => ({ items: [] })),
    hlcData('GET', '/api/hrm/positions', { query: { page: 1, page_size: 200 } }).catch(() => ({ items: [] }))
  ]);
  const dmap = {}, pmap = {};
  itemsOf(dep).forEach(d => { dmap[d.id] = d.name; });
  itemsOf(pos).forEach(p => { pmap[p.id] = p.name; });
  const data = { dmap, pmap };
  CACHE.set('lookup', { at: Date.now(), data });
  return data;
}

async function status() {
  const out = { m07: { ok: false }, m01: { ok: false } };
  try { await hlcLogin(); out.m07 = { ok: true, api: hlcBase(), label: 'M07 人事（HLC）' }; }
  catch (e) { out.m07 = { ok: false, api: hlcBase(), error: e.message, label: 'M07 人事（HLC）' }; }
  try { await m01Data('GET', '/kernel/v1/status'); out.m01 = { ok: true, api: m01Base(), label: 'M01 身份内核' }; }
  catch (e) { out.m01 = { ok: false, api: m01Base(), error: e.message, label: 'M01 身份内核' }; }
  return out;
}

async function listResignations(params) {
  const { dmap, pmap } = await lookupMaps();
  const res = await hlcData('GET', '/api/hrm/resignations', { query: Object.assign({ page: 1, page_size: 50 }, params || {}) });
  return itemsOf(res).map(r => {
    const e = r.employee || {};
    return Object.assign({}, r, {
      kind: 'resignation',
      employeeName: e.name || r.employeeName || '',
      employeeNo: e.employee_no || '',
      jobTitle: e.job_title || '',
      deptName: dmap[e.department_id] || '',
      positionName: pmap[e.position_id] || '',
      statusLabel: r.status || ''
    });
  });
}

async function listEmployeeChanges(params) {
  const { dmap, pmap } = await lookupMaps();
  const res = await hlcData('GET', '/api/hrm/employee-changes', { query: Object.assign({ page: 1, page_size: 50 }, params || {}) });
  return itemsOf(res).map(r => {
    const e = r.employee || {};
    return Object.assign({}, r, {
      kind: 'change',
      employeeName: e.name || r.employeeName || '',
      jobTitle: e.job_title || '',
      deptName: dmap[e.after_department_id || e.before_department_id] || '',
      positionName: pmap[e.after_position_id || e.before_position_id] || '',
      statusLabel: r.status || ''
    });
  });
}

async function listEmployees(search) {
  const { dmap, pmap } = await lookupMaps();
  const q = { page: 1, page_size: 100 };
  if (search) q.search = search;
  const res = await hlcData('GET', '/api/hrm/employees', { query: q });
  return itemsOf(res).map(e => ({
    id: e.id, name: e.name, employeeNo: e.employee_no || '',
    jobTitle: e.job_title || '',
    deptName: dmap[e.department_id] || '',
    positionName: pmap[e.position_id] || '',
    status: e.status || ''
  }));
}

async function createResignation(input) {
  const i = input || {};
  if (!i.employeeId) { const e = new Error('请选择员工'); e.status = 400; throw e; }
  if (!i.reason) { const e = new Error('请填写离职原因'); e.status = 400; throw e; }
  const body = {
    employeeId: i.employeeId,
    applyDate: i.applyDate || new Date().toISOString().slice(0, 10),
    expectedLeaveDate: i.expectedLeaveDate || null,
    reason: i.reason,
    handoverItems: i.handoverItems || null,
    status: 'draft'
  };
  const created = await hlcData('POST', '/api/hrm/resignations', { body });
  return created;
}

async function submitResignation(id) {
  return hlcData('POST', '/api/hrm/resignations/' + encodeURIComponent(id) + '/submit', { body: {} });
}

async function pendingApprovals() {
  const res = await hlcData('GET', '/api/hrm/approvals/pending');
  return itemsOf(res);
}

async function actApproval(id, action) {
  if (!['approve', 'reject'].includes(action)) { const e = new Error('审批动作不合法'); e.status = 400; throw e; }
  return hlcData('POST', '/api/hrm/approvals/' + encodeURIComponent(id) + '/' + action, { body: {} });
}

async function m01Snapshot() {
  const s = await m01Data('GET', '/kernel/v1/status');
  return {
    master: s.master || null,
    persons: (s.persons || []).map(p => ({
      personId: p.person_id, tenantId: p.tenant_id,
      name: (p.profile && p.profile.display_name) || p.name || p.person_id,
      employeeCode: (p.profile && p.profile.employee_code) || '',
      status: p.status || ''
    })),
    approvals: s.approvals || []
  };
}

/**
 * M01 办理（离职/调岗）：高风险动作，必须 confirm===true（人工确认）才执行；
 * 走 M01 quick/person-action（内部会按策略进入审批或直接执行）。
 */
async function m01Handle(input) {
  const i = input || {};
  const map = { offboard: 'offboard', transfer: 'transfer' };
  const action = map[i.action];
  if (!action) { const e = new Error('办理事项只能是离职或调岗'); e.status = 400; throw e; }
  if (!i.personId) { const e = new Error('请选择 M01 人员'); e.status = 400; throw e; }
  if (i.confirm !== true) { const e = new Error('高风险动作需要人工确认（confirm=true）'); e.status = 428; throw e; }
  const body = { action, person_id: i.personId };
  if (i.effectiveAt) body.effective_at = i.effectiveAt;
  if (i.approvalTicket) body.approval_ticket = i.approvalTicket;
  const r = await m01Data('POST', '/kernel/v1/quick/person-action', { body });
  return {
    ok: r.ok !== false,
    decision: r.decision || 'UNKNOWN',
    traceId: r.trace_id || null,
    approval: r.approval || null,
    raw: r
  };
}

module.exports = {
  status, listResignations, listEmployeeChanges, listEmployees,
  createResignation, submitResignation, pendingApprovals, actApproval,
  m01Snapshot, m01Handle
};
