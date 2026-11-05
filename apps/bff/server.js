'use strict';
// apps/bff — POMS 代理与服务端授权（M04 统一认证过渡适配器）。
// 纯 Node http 实现，无第三方依赖，可直接 `npm start` 运行。
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn, execFileSync } = require('child_process');
const circuit = require('../../packages/circuit');

const ROOT = path.join(__dirname, '..', '..');
const assembly = require('../../packages/assembly');
const capture = require('../../packages/capture');
const m01 = require('../../adapters/m01');
const m07 = require('../../adapters/m07');
const hlc = require('../../adapters/hlc');
const org = require('../../adapters/org');
const plm2 = require('../../adapters/plm2');
const plmSync = require('../../adapters/plm2/sync');
const meetingAdapter = require('../../adapters/meeting');
const spc = require('../../adapters/spc');
const crm = require('../../adapters/crm');
const ebms = require('../../adapters/ebms');
const personnel = require('../../adapters/personnel');
const taskhub = require('../../packages/taskhub');
const TOOLS = require('../../configs/tools.json');
const SKILLS = require('../../configs/skills.json');
const hub = require('../../adapters/hub');
const { defaultPersonLifecycleService } = require('./person-lifecycle');
const {
  JsonlLeadOutbox,
  PUBLIC_LEAD_PATH,
  createHttpPublisher,
  createPublicLeadConfig,
  createPublicLeadService,
  allowedOrigin
} = require('./public-leads');

const publicLeadConfig = createPublicLeadConfig(process.env, { allowMissing: true });
const publicLeadOutbox = new JsonlLeadOutbox(publicLeadConfig);
const publicLeadService = createPublicLeadService({
  config: publicLeadConfig,
  outbox: publicLeadOutbox,
  publisher: createHttpPublisher(publicLeadConfig)
});
const publicLeadFlushTimer = setInterval(() => {
  publicLeadService.flush().catch(() => {});
}, 5000);
publicLeadFlushTimer.unref();

/* ---- M10 统一认证（与 M04 PLM 同一账号/令牌/角色） ---- */
const ROLE_PRIORITY = ['ADMIN', 'admin', 'gm', 'rd_manager', 'engineer', 'project_manager', 'sales_director', 'sales_manager', 'purchase', 'finance', 'cw1', 'sales', 'sales_user', 'viewer', 'QUALITY', 'hr_manager'];
const ROLE_MAP = { ADMIN: 'ADMIN', admin: 'ADMIN', gm: 'GM', rd_manager: 'RD_LEAD', engineer: 'ENGINEER', project_manager: 'PROJECT_MANAGER', sales_director: 'SALES_MANAGER', sales_manager: 'SALES_MANAGER', purchase: 'PURCHASE', finance: 'FINANCE', cw1: 'FINANCE', sales: 'SALES', sales_user: 'SALES', viewer: 'VIEWER', hr_manager: 'VIEWER', QUALITY: 'QUALITY', ENGINEER: 'ENGINEER', SALES: 'SALES' };
const authCache = new Map(); // token -> { exp, session, vo }
const REQUIRE_AUTH = ['1', 'true', 'yes', 'on'].includes(String(process.env.M10_REQUIRE_AUTH || '').toLowerCase())
  || String(process.env.NODE_ENV || '').toLowerCase() === 'production';

function deriveRole(roleCodeStr) {
  const rs = String(roleCodeStr || '').split(',').map(s => s.trim()).filter(Boolean);
  const primary = ROLE_PRIORITY.find(p => rs.includes(p));
  return ROLE_MAP[primary] || 'VIEWER';
}
const TASKHUB_REVIEWER_ROLES = ['ADMIN', 'admin', 'gm', 'rd_manager', 'project_manager', 'hr_manager', 'cw1', 'sales_director', 'sales_manager'];
/* ---- 手机号绑定登录（首次用手机号+PLM 账号密码绑定，之后本机自动登录，全程留痕） ---- */
const MOBILE_AUTH_FILE = path.join(ROOT, 'configs', 'mobile-auth.local.json');
const ROLE_POSITION = {
  ADMIN: '系统管理员', GM: '总经理', RD_LEAD: '研发经理', ENGINEER: '工程师',
  PROJECT_MANAGER: '项目经理', QUALITY: '质检员', SALES_MANAGER: '销售经理',
  SALES: '销售', PURCHASE: '采购', FINANCE: '财务', HR_MANAGER: '人事主管', VIEWER: '一般员工'
};
function mobileAuthLoad() {
  try {
    const j = JSON.parse(fs.readFileSync(MOBILE_AUTH_FILE, 'utf8'));
    return { bindings: j.bindings || {}, devices: j.devices || {}, logins: Array.isArray(j.logins) ? j.logins : [] };
  } catch (e) { return { bindings: {}, devices: {}, logins: [] }; }
}
function mobileAuthSave(db) {
  db.logins = db.logins.slice(-300);
  fs.writeFileSync(MOBILE_AUTH_FILE, JSON.stringify(db, null, 2) + '\n', 'utf8');
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
}
function mobileProfile(username, realName, role) {
  const people = plm2.getPeople();
  const p = people.find(x => x.name === realName) || people.find(x => x.username === username);
  let dept = (p && p.dept) || '';
  try {
    const dp = plm2.getDepartments().find(d => d.code === dept || d.name === dept);
    if (dp) dept = dp.name;
  } catch (e) { /* 组织不可用则保留原值 */ }
  return {
    username, name: realName || username, role: role || '',
    position: ROLE_POSITION[role] || '员工',
    dept,
    personId: p ? p.id : null
  };
}
function logMobile(db, entry) { db.logins.push(Object.assign({ at: new Date().toISOString() }, entry)); }
function mobileDevice(req) {
  const token = cookieOf(req, 'mdev');
  if (!token) return null;
  const db = mobileAuthLoad();
  const d = db.devices[token];
  return d ? { token, device: d, db } : null;
}

// 手机端「只看与本人相关」：人员变动只对人事/管理员开放
function personnelIdentity(req) {
  const d = mobileDevice(req);
  if (d) return { name: d.device.name, role: d.device.role, dept: d.device.dept, via: 'mobile' };
  const s = ssoSession(req);
  if (s && s.user) return { name: s.user.name, role: s.user.role, dept: '', via: 'sso' };
  return null;
}
function isHrAdmin(who) {
  if (!who) return false;
  const roles = ['ADMIN', 'admin', 'GM', 'gm', 'HR_MANAGER', 'hr_manager'];
  if (roles.includes(who.role)) return true;
  return /人事|行政/.test(who.dept || '');
}

const crypto = require('crypto');
/* ---- 统一登录（服务端代登录各系统，浏览器只拿 M10 会话） ---- */
const SSO_SESSIONS = new Map();
const SSO_TTL = 8 * 60 * 60 * 1000;
function cookieOf(req, name) {
  const h = req.headers.cookie || '';
  const m = h.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
function ssoSession(req) {
  const sid = cookieOf(req, 'm10sess');
  if (!sid) return null;
  const s = SSO_SESSIONS.get(sid);
  if (!s) return null;
  if (Date.now() - s.at > SSO_TTL) { SSO_SESSIONS.delete(sid); return null; }
  s.at = Date.now();
  return s;
}
async function ssoLogin(username, password) {
  const systems = {};
  let user = { name: username };
  let plmToken = '';
  try {
    const x = await plmSync.loginWith(username, password);
    plmToken = x.token || '';
    const vo = x.vo || {};
    systems.plm = { ok: true, name: vo.realName || username, role: vo.roleCode || (vo.roles && vo.roles[0]) || '' };
    user = { name: vo.realName || username, role: vo.roleCode || (vo.roles && vo.roles[0]) || '', userId: vo.userId || null, roles: vo.roles || [] };
  } catch (e) { systems.plm = { ok: false, error: e.message }; }

  try {
    const x = await hub.loginWith(username, password);
    systems.hub = { ok: !!x.ok, error: x.error || '' };
  } catch (e) { systems.hub = { ok: false, error: e.message }; }

  try {
    // 会议助手按中文姓名登录：先用账号，失败再用 PLM 返回的真实姓名重试
    let x = await meetingAdapter.loginAs(username);
    if (!x.ok && user.name && user.name !== username) {
      const y = await meetingAdapter.loginAs(user.name);
      if (y.ok) x = y;
    }
    systems.meeting = { ok: !!x.ok, configured: x.configured !== false, error: x.error || '', role: x.role || '' };
  } catch (e) { systems.meeting = { ok: false, error: e.message }; }

  if (plmToken) {
    try {
      const s = await hlc.exchangePlm(plmToken);
      systems.hlc = { ok: !!s, role: (s && s.role) || '' };
    } catch (e) { systems.hlc = { ok: false, error: e.message }; }
  } else {
    systems.hlc = { ok: false, error: '需要先用 PLM 账号登录' };
  }

  try {
    await spc.login(username, password);
    systems.spc = { ok: true };
  } catch (e) { systems.spc = { ok: false, configured: spc.configured(), error: e.message }; }

  return { user, systems, plmToken };
}
function taskhubReviewer(name) {
  if (!name) return null;
  const p = plm2.getPeople().find(x => x.name === name || x.username === name);
  if (!p) return null;
  const roles = p.realRoles && p.realRoles.length ? p.realRoles : [p.role].filter(Boolean);
  return roles.some(r => TASKHUB_REVIEWER_ROLES.includes(r)) ? p : null;
}
const TASKHUB_SSE = new Set();
let SYSTEMS_CACHE = null;
function taskhubBroadcast(kind, payload) {
  const line = 'data: ' + JSON.stringify({ kind, payload: payload || {}, at: Date.now() }) + '\n\n';
  for (const c of [...TASKHUB_SSE]) { try { c.write(line); } catch (e) { TASKHUB_SSE.delete(c); } }
}

// PLM → 总库 轮询：只看总库 PLM 条目涉及的项目（默认 60s，PLM_POLL_MS=0 关闭）
function startPlmPoller() {
  const ms = Number(process.env.PLM_POLL_MS == null ? 60000 : process.env.PLM_POLL_MS);
  if (!(ms > 0)) return;
  let running = false;
  let skipLeft = 0; // PLM 连续不可用时降频，避免每分钟重复登录失败
  setInterval(async () => {
    if (running) return;
    if (skipLeft > 0) { skipLeft--; return; }
    running = true;
    try {
      const st = plm2.syncStatus();
      if (st.lastOk === false) { skipLeft = 9; return; } // 上次拉取失败：退避 10 个周期
      const before = taskhub.list({}).items.filter(x => x.source === 'PLM2');
      const projects = [...new Set(before.map(x => x.refs && x.refs.projectNo).filter(Boolean))];
      if (!projects.length) return;
      for (const pn of projects) {
        try { await plm2.getProjectAsync(pn, { fresh: true }); } catch (e) { /* PLM 不可达：保留本地快照 */ }
      }
      const r = await taskhub.refresh({});
      const after = taskhub.list({}).items.filter(x => x.source === 'PLM2');
      const sig = (arr) => arr.map(x => x.id + ':' + x.status).sort().join('|');
      const changed = sig(before) !== sig(after);
      if (changed) taskhubBroadcast('plm-sync', { poll: true, changed, total: r.total });
    } catch (e) { /* 轮询失败不阻塞服务 */ } finally { running = false; }
  }, ms).unref();
}
function mapPerson(vo) {
  const ppl = plm2.getPeople();
  const byUser = ppl.find(p => p.username === vo.username);
  const byName = ppl.find(p => p.name === vo.realName);
  const person = byUser || byName || null;
  return person ? person.id : null;
}
function mapM01Person(vo) {
  const people = Object.values(m01.PERSONS || {});
  const person = people.find(p => p.name === vo.realName);
  return person ? person.person_id : null;
}
function authSession(vo) {
  const roleCodes = vo.roles && vo.roles.length ? vo.roles : [];
  const demoRoles = [...new Set(roleCodes.map(r => ROLE_MAP[r] || 'VIEWER'))];
  const primary = deriveRole(roleCodes.join(','));
  // 兼岗：合并所有角色的模块权限
  let mergedPerms = [];
  try { demoRoles.forEach(r => { mergedPerms = mergedPerms.concat(plm2.getManifest(r).permission_matrix || []); }); mergedPerms = [...new Set(mergedPerms)]; } catch(e) { mergedPerms = []; }
  return {
    userId: vo.userId, username: vo.username, realName: vo.realName,
    roleCode: roleCodes.join(','),
    roles: demoRoles,
    role: primary,
    permissions: mergedPerms,
    personId: mapPerson(vo),
    m01PersonId: mapM01Person(vo),
    legacyActorId: /^u-/.test(String(vo.userId || '')) ? vo.userId : null
  };
}
function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function requestPersonId(req, supplied) {
  return req.aeosSession ? req.aeosSession.m01PersonId : supplied;
}

function requestPlmPersonId(req, supplied) {
  return req.aeosSession ? req.aeosSession.personId : supplied;
}

function requiredPlmPersonId(req, supplied) {
  const id = requestPlmPersonId(req, supplied);
  if (REQUIRE_AUTH && !id) throw Object.assign(new Error('当前账号尚未绑定 PLM 人员'), { status: 403 });
  return id;
}

function requestRole(req, supplied) {
  return req.aeosSession ? req.aeosSession.roles.join(',') : supplied;
}

function requestLegacyActorId(req, supplied) {
  if (req.aeosSession) {
    if (!req.aeosSession.legacyActorId) throw Object.assign(new Error('当前账号尚未绑定 M01 演示操作人'), { status: 403 });
    return req.aeosSession.legacyActorId;
  }
  return supplied;
}

async function getRequestSession(req, options = {}) {
  const required = options.required !== undefined ? options.required : REQUIRE_AUTH;
  const fresh = options.fresh === true;
  if (req.aeosSession && !fresh) return req.aeosSession;
  if (fresh) req.aeosSession = null;
  const tok = bearerToken(req);
  if (!tok) {
    if (required) throw Object.assign(new Error('需要登录后访问 M10 BFF'), { status: 401 });
    return null;
  }
  const hit = authCache.get(tok);
  if (!fresh && hit && hit.exp > Date.now()) {
    req.aeosSession = hit.session;
    return hit.session;
  }
  let vo;
  try { vo = await plmSync.infoWith(tok); } catch (e) {
    throw Object.assign(new Error('令牌无效或已过期（M04 统一认证）'), { status: 401 });
  }
  const session = authSession(vo);
  authCache.set(tok, { exp: Date.now() + 30000, session, vo });
  req.aeosSession = session;
  return session;
}

// 写操作鉴权：认证请求必须以服务端验证出的角色和人员为准；仅 L0 开发模式允许无令牌演示。
async function guardWriteRole(req, body) {
  const s = await getRequestSession(req, { required: REQUIRE_AUTH, fresh: true });
  if (!s) return; // 仅开发环境 L0 演示模式
  body.role = s.roles.join(',');
  body.__aeos_person_id = s.personId;
}

const PORT = process.env.PORT || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers));
  if (Buffer.isBuffer(body)) return res.end(body);
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    req.on('data', c => {
      if (settled) return;
      data += c;
      if (Buffer.byteLength(data, 'utf8') > maxBytes) {
        settled = true;
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (settled) return;
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(Object.assign(e, { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyPersonLifecycleSignature(req, raw) {
  const keyId = String(req.headers['x-aeos-key-id'] || '');
  const timestamp = String(req.headers['x-aeos-timestamp'] || '');
  const supplied = String(req.headers['x-aeos-signature'] || '').replace(/^sha256=/, '');
  const configuredKeyId = process.env.AEOS_PERSON_LIFECYCLE_KEY_ID || 'm01-kernel';
  const secret = process.env.AEOS_PERSON_LIFECYCLE_SECRET || process.env.M10_PERSON_LIFECYCLE_SECRET || '';
  const timestampMs = Number(timestamp);
  if (!keyId || keyId !== configuredKeyId || !timestamp || !Number.isInteger(timestampMs) || !supplied || !secret) return false;
  const maxSkew = Number(process.env.AEOS_PERSON_LIFECYCLE_MAX_SKEW_SECONDS || 300) * 1000;
  if (Math.abs(Date.now() - timestampMs) > maxSkew) return false;
  const expected = require('crypto').createHmac('sha256', secret).update(timestamp).update('.').update(raw).digest('hex');
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && require('crypto').timingSafeEqual(expectedBytes, suppliedBytes);
}

function publicLeadCorsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Captcha-Token',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
    'Cache-Control': 'no-store'
  };
}

function allowedActions(person, req) {
  const a = [];
  if (req.state === 'DRAFT' || req.state === 'SUBMITTED') a.push('acknowledge');
  if (person.capabilities.includes('hlc:request:assign') && ['SUBMITTED', 'TRIAGED', 'NEEDS_INFO'].includes(req.state)) a.push('assign');
  if (person.capabilities.includes('hlc:request:execute') && req.state === 'ASSIGNED') a.push('execute');
  if (req.state === 'AWAITING_ACCEPTANCE' && person.capabilities.includes('hlc:request:verify')) a.push('verify');
  if (person.capabilities.includes('hlc:request:approve') && req.state === 'APPROVAL_PENDING') a.push('approve');
  return a;
}

function filterVisibleRequests(list, personId) {
  if (!personId) return [];
  const person = m01.getPerson(personId);
  if (person.capabilities.includes('hlc:request:read')) return list;
  return list.filter(r => r.requester === personId || r.assignee === personId);
}

function serveStatic(reqPath, res) {
  let file = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  if (file === '/' || file === '') file = '/index.html';
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    const ext = path.extname(full).toLowerCase();
    send(res, 200, buf, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const q = parsed.query;

  try {
    // 静态页面入口
    if (pathname === '/' || pathname === '/portal') return serveStatic('/demo/portal.html', res);
    if (pathname === '/org' || pathname === '/org/') return serveStatic('/demo/index.html', res);
    if (pathname === '/demo') return serveStatic('/demo/index.html', res);
    if (pathname === '/mobile' || pathname === '/mobile/') return serveStatic('/apps/mobile-web/index.html', res);
    if (pathname === '/simple' || pathname === '/simple/') return serveStatic('/apps/simple/index.html', res);
    if (pathname === '/plm2' || pathname === '/plm2/') return serveStatic('/demo/plm2.html', res);
    if (pathname === '/hlc' || pathname === '/hlc/') return serveStatic('/demo/hlc.html', res);
    if (pathname === '/taskhub' || pathname === '/taskhub/') return serveStatic('/demo/taskhub.html', res);
    if (pathname === '/spc' || pathname === '/spc/') return serveStatic('/demo/spc.html', res);
    /* ---- SPC（供应链与生产协同中台）只读接入，标准同 PLM ---- */
    if (pathname === '/api/v1/spc/status' && req.method === 'GET') {
      return send(res, 200, await spc.status());
    }
    if (pathname === '/api/v1/spc/dashboard' && req.method === 'GET') {
      try { return send(res, 200, await spc.dashboard()); }
      catch (e) { return send(res, e.status || 503, { error: e.message, configured: spc.configured() }); }
    }
    const spcList = pathname.match(/^\/api\/v1\/spc\/(orders|materials|exceptions|supplier-risk)$/);
    if (spcList && req.method === 'GET') {
      const params = { page: q.page || 1, page_size: q.page_size || 20 };
      if (q.risk_level) params.risk_level = q.risk_level;
      if (q.owner) params.owner = q.owner;
      if (q.keyword) params.keyword = q.keyword;
      if (q.status) params.status = q.status;
      if (q.supplier) params.supplier = q.supplier;
      if (q.shortage_only === '1') params.shortage_only = true;
      const fn = spcList[1] === 'orders' ? spc.orders
        : spcList[1] === 'materials' ? spc.materials
        : spcList[1] === 'exceptions' ? spc.exceptions : spc.supplierRisk;
      try { return send(res, 200, await fn(params)); }
      catch (e) { return send(res, e.status || 503, { error: e.message, configured: spc.configured() }); }
    }
    /* ---- CRM（M05）只读接入 ---- */
    if (pathname === '/api/v1/crm/status' && req.method === 'GET') return send(res, 200, await crm.status());
    const crmApi = pathname.match(/^\/api\/v1\/crm\/(dashboard|leads|customers|opportunities|tasks|orders|approvals)$/);
    if (crmApi && req.method === 'GET') {
      const fn = crmApi[1] === 'dashboard' ? crm.dashboard
        : crmApi[1] === 'leads' ? crm.leads
        : crmApi[1] === 'customers' ? crm.customers
        : crmApi[1] === 'opportunities' ? crm.opportunities
        : crmApi[1] === 'tasks' ? crm.tasksMine
        : crmApi[1] === 'orders' ? crm.orders
        : crmApi[1] === 'approvals' ? (q.count === '1' ? crm.approvalsCount : crm.approvals)
        : crm.approvalsCount;
      const crmParams = { page: q.page || 1, page_size: q.page_size || 20 };
      if (q.status) crmParams.status = q.status;
      if (q.keyword) crmParams.keyword = q.keyword;
      try { return send(res, 200, await fn(crmParams)); }
      catch (e) { return send(res, e.status || 503, { error: e.message, configured: crm.configured() }); }
    }
    /* CRM 处理动作（经 CRM 官方接口，服务端令牌） */
    const crmWrite = pathname.match(/^\/api\/v1\/crm\/(opportunities|tasks|approvals|leads)\/([^/]+)\/(stage|complete|approve|reject|assign)$/);
    if (crmWrite && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const kind = crmWrite[1], id = decodeURIComponent(crmWrite[2]), act = crmWrite[3];
        let r;
        if (kind === 'opportunities' && act === 'stage') r = await crm.advanceStage(id, { stage: body.stage, lost_reason: body.lost_reason, won_amount: body.won_amount });
        else if (kind === 'tasks' && act === 'complete') r = await crm.completeTask(id);
        else if (kind === 'approvals' && act === 'approve') r = await crm.approve(id, body.comment);
        else if (kind === 'approvals' && act === 'reject') r = await crm.reject(id, body.comment);
        else if (kind === 'leads' && act === 'assign') r = await crm.assignLead(id, body.owner_id);
        else return send(res, 404, { error: '不支持的操作' });
        taskhubBroadcast('crm', { action: act });
        return send(res, 200, { ok: true, data: r });
      } catch (e) {
        return send(res, e.status || 502, { error: e.message, source: 'CRM' });
      }
    }
    /* ---- EBMS（M03）只读接入 ---- */
    if (pathname === '/api/v1/ebms/status' && req.method === 'GET') return send(res, 200, await ebms.status());
    const ebmsApi = pathname.match(/^\/api\/v1\/ebms\/(system|workspace|work-items|results)$/);
    if (ebmsApi && req.method === 'GET') {
      const personId = q.person_id || 1;
      const fn = ebmsApi[1] === 'system' ? ebms.systemStatus
        : ebmsApi[1] === 'workspace' ? () => ebms.workspace(personId)
        : ebmsApi[1] === 'work-items' ? () => ebms.workItems(personId)
        : () => ebms.results(personId);
      try { return send(res, 200, await fn()); }
      catch (e) { return send(res, e.status || 503, { error: e.message, configured: ebms.configured() }); }
    }
    /* ---- 人员变动（离职/调岗）：M07 提交 → M01 办理 ---- */
    // 只对「本人相关」：人员变动属于人事/管理层职责，其他人不呈现也不可访问
    if (pathname.startsWith('/api/v1/personnel/')) {
      const who = personnelIdentity(req);
      if (!who) return send(res, 401, { error: '请先在微系统登录' });
      if (!isHrAdmin(who)) return send(res, 403, { error: '人员变动只对人事/管理员开放' });
    }
    if (pathname === '/api/v1/personnel/status' && req.method === 'GET') {
      return send(res, 200, await personnel.status());
    }
    if (pathname === '/api/v1/personnel/changes' && req.method === 'GET') {
      const out = { resignations: [], employeeChanges: [], errors: {} };
      try { out.resignations = await personnel.listResignations({ page: q.page || 1, page_size: q.page_size || 50 }); }
      catch (e) { out.errors.resignations = e.message; }
      try { out.employeeChanges = await personnel.listEmployeeChanges({ page: q.page || 1, page_size: q.page_size || 50 }); }
      catch (e) { out.errors.employeeChanges = e.message; }
      return send(res, 200, out);
    }
    if (pathname === '/api/v1/personnel/employees' && req.method === 'GET') {
      try { return send(res, 200, { items: await personnel.listEmployees(q.search) }); }
      catch (e) { return send(res, e.status || 503, { error: e.message }); }
    }
    if (pathname === '/api/v1/personnel/m01/persons' && req.method === 'GET') {
      try { return send(res, 200, await personnel.m01Snapshot()); }
      catch (e) { return send(res, e.status || 503, { error: e.message }); }
    }
    if (pathname === '/api/v1/personnel/resignations' && req.method === 'POST') {
      const body = await readBody(req);
      const actor = taskhubReviewer(body.actor) || plm2.getPeople().find(x => x.name === body.actor);
      if (!actor) return send(res, 403, { error: '只有人事/管理员可以提交离职（请填写操作人）' });
      try {
        const created = await personnel.createResignation(body);
        let submitted = null;
        if (body.submit !== false) {
          const id = created.id || (created.resignation && created.resignation.id);
          if (id) { try { submitted = await personnel.submitResignation(id); } catch (e) { submitted = { error: e.message }; } }
        }
        return send(res, 201, { ok: true, created, submitted, actor: actor.name });
      } catch (e) { return send(res, e.status || 503, { error: e.message }); }
    }
    const resignSubmit = pathname.match(/^\/api\/v1\/personnel\/resignations\/([^/]+)\/submit$/);
    if (resignSubmit && req.method === 'POST') {
      const body = await readBody(req);
      const actor = taskhubReviewer(body.actor) || plm2.getPeople().find(x => x.name === body.actor);
      if (!actor) return send(res, 403, { error: '只有人事/管理员可以提交审批（请填写操作人）' });
      try { return send(res, 200, { ok: true, result: await personnel.submitResignation(decodeURIComponent(resignSubmit[1])), actor: actor.name }); }
      catch (e) { return send(res, e.status || 503, { error: e.message }); }
    }
    if (pathname === '/api/v1/personnel/approvals' && req.method === 'GET') {
      try { return send(res, 200, { items: await personnel.pendingApprovals() }); }
      catch (e) { return send(res, e.status || 503, { error: e.message }); }
    }
    const persAppr = pathname.match(/^\/api\/v1\/personnel\/approvals\/([^/]+)\/(approve|reject)$/);
    if (persAppr && req.method === 'POST') {
      const body = await readBody(req);
      const actor = taskhubReviewer(body.actor) || plm2.getPeople().find(x => x.name === body.actor);
      if (!actor) return send(res, 403, { error: '只有人事/管理员可以审批（请填写操作人）' });
      try { return send(res, 200, { ok: true, result: await personnel.actApproval(decodeURIComponent(persAppr[1]), persAppr[2]), actor: actor.name }); }
      catch (e) { return send(res, e.status || 503, { error: e.message }); }
    }
    if (pathname === '/api/v1/personnel/m01/handle' && req.method === 'POST') {
      const body = await readBody(req);
      const actor = taskhubReviewer(body.actor) || plm2.getPeople().find(x => x.name === body.actor);
      if (!actor) return send(res, 403, { error: '只有人事/管理员可以办理（请填写操作人）' });
      try {
        const r = await personnel.m01Handle({
          personId: body.personId, action: body.action, effectiveAt: body.effectiveAt,
          approvalTicket: body.approvalTicket, confirm: body.confirm === true
        });
        return send(res, 200, Object.assign({ actor: actor.name }, r));
      } catch (e) { return send(res, e.status || 503, { error: e.message }); }
    }
    /* ---- 全部系统连接总览（30s 缓存） ---- */
    if (pathname === '/api/v1/systems' && req.method === 'GET') {
      if (!SYSTEMS_CACHE || Date.now() - SYSTEMS_CACHE.at > 30000) {
        const one = async (fn, extra) => {
          try { const s = await fn(); return Object.assign({ ok: !!(s && s.connected) }, extra || {}, s || {}); }
          catch (e) { return Object.assign({ ok: false, error: e.message }, extra || {}); }
        };
        const [plm, meeting, hubSt, spcSt, crmSt, ebmsSt, hlcSt] = await Promise.all([
          one(async () => { await plmSync.login(); return { connected: true, api: plmSync.apiBase() }; }),
          one(async () => { const a = meetingAdapter.listAll(); return { connected: a.items.length > 0, items: a.items.length, updatedAt: a.updatedAt, live: a.live }; }, { label: '会议助手' }),
          one(() => hub.status(), { label: 'Hub 经营中心' }),
          one(() => spc.status(), { label: 'SPC 供应链' }),
          one(() => crm.status(), { label: 'CRM 销售' }),
          one(() => ebms.status(), { label: 'EBMS 经营' }),
          one(() => hlc.status(), { label: 'HLC 人事后勤' })
        ]);
        SYSTEMS_CACHE = {
          at: Date.now(),
          data: {
            plm: Object.assign({ label: 'PLM 研发' }, plm),
            meeting, hub: hubSt, spc: spcSt, crm: crmSt, ebms: ebmsSt, hlc: hlcSt,
            fac: { label: 'FAC 财经', ok: false, configured: false, error: '未接入（未部署）' },
            edp: { label: 'EDP 数据证据', ok: false, configured: false, error: '未接入（未部署）' }
          }
        };
      }
      return send(res, 200, { checkedAt: new Date(SYSTEMS_CACHE.at).toISOString(), systems: SYSTEMS_CACHE.data });
    }
    if (pathname === '/login' || pathname === '/login/') return serveStatic('/apps/login/index.html', res);
    if (pathname === '/m' || pathname === '/m/') return serveStatic('/apps/mobile-web/role.html', res);
    if (pathname === '/m/login' || pathname === '/m/login/') return serveStatic('/apps/mobile-web/login.html', res);
    if (pathname === '/m/spc' || pathname === '/m/spc/') return serveStatic('/apps/mobile-web/spc.html', res);

    if (pathname === '/m/crm' || pathname === '/m/crm/') return serveStatic('/apps/mobile-web/crm.html', res);
    if (pathname === '/m/ebms' || pathname === '/m/ebms/') return serveStatic('/apps/mobile-web/ebms.html', res);
    if (pathname === '/m/personnel' || pathname === '/m/personnel/') return serveStatic('/apps/mobile-web/personnel.html', res);
    if (pathname === '/personnel' || pathname === '/personnel/') return serveStatic('/apps/mobile-web/personnel.html', res);
    if (pathname === '/wechat' || pathname === '/wechat/') return serveStatic('/apps/mobile-web/wechat.html', res);
    /* ---- 手机号绑定登录 ---- */
    if (pathname === '/api/v1/mobile/bind' && req.method === 'POST') {
      const body = await readBody(req);
      const phone = String(body.phone || '').replace(/\s/g, '');
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const ip = clientIp(req);
      const ua = String(req.headers['user-agent'] || '').slice(0, 120);
      if (!/^1[3-9]\d{9}$/.test(phone)) return send(res, 400, { error: '请输入正确的 11 位手机号' });
      if (!username || !password) return send(res, 400, { error: '请输入 PLM 账号和密码' });
      const db = mobileAuthLoad();
      try {
        const x = await plmSync.loginWith(username, password);
        const vo = x.vo || {};
        const role = vo.roleCode || (vo.roles && vo.roles[0]) || '';
        const profile = mobileProfile(username, vo.realName, role);
        const prev = db.bindings[phone];
        db.bindings[phone] = { username, name: profile.name, boundAt: new Date().toISOString() };
        const token = crypto.randomBytes(24).toString('hex');
        db.devices[token] = Object.assign({ phone, at: new Date().toISOString(), ua }, profile);
        logMobile(db, {
          kind: prev && prev.username !== username ? 'switch' : 'bind',
          ok: true, phone, username, name: profile.name, ip, ua
        });
        mobileAuthSave(db);
        res.setHeader('Set-Cookie', 'mdev=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=15552000');
        return send(res, 200, { ok: true, user: Object.assign({ phone }, profile) });
      } catch (e) {
        logMobile(db, { kind: 'bind', ok: false, phone, username, error: e.message, ip, ua });
        mobileAuthSave(db);
        return send(res, 401, { error: 'PLM 账号或密码不正确（手机号已记录本次尝试）' });
      }
    }
    if (pathname === '/api/v1/mobile/me' && req.method === 'GET') {
      const d = mobileDevice(req);
      if (!d) return send(res, 200, { loggedIn: false });
      return send(res, 200, {
        loggedIn: true,
        user: {
          phone: d.device.phone, username: d.device.username, name: d.device.name,
          role: d.device.role, position: d.device.position, dept: d.device.dept, personId: d.device.personId
        }
      });
    }
    if (pathname === '/api/v1/mobile/logout' && req.method === 'POST') {
      const d = mobileDevice(req);
      if (d) {
        logMobile(d.db, { kind: 'logout', ok: true, phone: d.device.phone, username: d.device.username, name: d.device.name, ip: clientIp(req) });
        delete d.db.devices[d.token];
        mobileAuthSave(d.db);
      }
      res.setHeader('Set-Cookie', 'mdev=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return send(res, 200, { ok: true });
    }
    if (pathname === '/api/v1/mobile/logins' && req.method === 'GET') {
      const d = mobileDevice(req);
      if (!d) return send(res, 401, { error: '请先登录' });
      const list = (d.db.logins || []).filter(x => x.phone === d.device.phone).slice(-20).reverse()
        .map(x => ({ at: x.at, kind: x.kind, ok: x.ok, username: x.username, name: x.name, error: x.error || '' }));
      return send(res, 200, { phone: d.device.phone, logins: list });
    }
    /* ---- 统一登录：一个登录页连接各系统（服务端代登录） ---- */
    if (pathname === '/api/v1/sso/login' && req.method === 'POST') {
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) return send(res, 400, { error: '请填写账号和密码' });
      const r = await ssoLogin(username, password);
      const anyOk = Object.values(r.systems).some(x => x.ok);
      if (!anyOk) return send(res, 401, { error: '账号或密码不正确：各系统都没有通过', systems: r.systems });
      const sid = crypto.randomBytes(16).toString('hex');
      SSO_SESSIONS.set(sid, { at: Date.now(), user: r.user, systems: r.systems });
      res.setHeader('Set-Cookie', 'm10sess=' + sid + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800');
      return send(res, 200, { ok: true, user: r.user, systems: r.systems });
    }
    if (pathname === '/api/v1/sso/status' && req.method === 'GET') {
      const s = ssoSession(req);
      return send(res, 200, { loggedIn: !!s, user: s ? s.user : null, systems: s ? s.systems : null });
    }
    if (pathname === '/api/v1/sso/logout' && req.method === 'POST') {
      const sid = cookieOf(req, 'm10sess');
      if (sid) SSO_SESSIONS.delete(sid);
      res.setHeader('Set-Cookie', 'm10sess=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return send(res, 200, { ok: true });
    }
    if (pathname.startsWith('/demo/') || pathname.startsWith('/apps/') || pathname.startsWith('/vendor/')) return serveStatic(pathname, res);
    if (pathname.startsWith('/favicon')) return send(res, 204, '');
    if (pathname === '/health' && req.method === 'GET') {
      return send(res, 200, { status: 'ok', service: 'm10-poms-bff', auth_mode: REQUIRE_AUTH ? 'strict' : 'l0-demo' });
    }

    // 官网公开线索入口：独立来源校验、限流、CAPTCHA、持久 Outbox；不经过内部登录态，
    // 也不返回 CRM 对象或任何 PII。目标投递失败由 Outbox 定时重试并最终进入 DLQ。
    if (pathname === PUBLIC_LEAD_PATH && req.method === 'OPTIONS') {
      const origin = String(req.headers.origin || '');
      if (!allowedOrigin(origin, publicLeadConfig.allowedOrigins)) throw Object.assign(new Error('来源不被允许'), { status: 403 });
      return send(res, 204, '', publicLeadCorsHeaders(origin));
    }
    if (pathname === PUBLIC_LEAD_PATH && req.method === 'POST') {
      if (publicLeadConfig.disabled) return send(res, 503, { error: publicLeadConfig.reason || '官网公开线索入口未配置' });
      const origin = String(req.headers.origin || '');
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
        throw Object.assign(new Error('仅支持 application/json'), { status: 415 });
      }
      const body = await readBody(req, 32 * 1024);
      const result = await publicLeadService.submit({
        body,
        origin,
        clientKey: req.socket.remoteAddress || 'unknown',
        captchaToken: Array.isArray(req.headers['x-captcha-token']) ? req.headers['x-captcha-token'][0] : req.headers['x-captcha-token'],
        idempotencyKey: Array.isArray(req.headers['idempotency-key']) ? req.headers['idempotency-key'][0] : req.headers['idempotency-key']
      });
      return send(res, 202, { lead_reference: result.lead_reference }, publicLeadCorsHeaders(origin));
    }

    // M01 → POMS 人员状态同步。该入口只接受 AEOS HMAC 签名，不接受浏览器会话。
    if (pathname === '/internal/aeos/person-lifecycle') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      const raw = await readRawBody(req, 256 * 1024);
      if (!verifyPersonLifecycleSignature(req, raw)) return send(res, 401, { error: '人员同步签名无效' });
      let body;
      try { body = JSON.parse(raw.toString('utf8')); }
      catch { return send(res, 400, { error: '人员同步请求不是有效 JSON' }); }
      try {
        const result = defaultPersonLifecycleService.apply(body);
        const rawStatus = String(result.status || 'failed').toLowerCase();
        const status = rawStatus === 'stale' ? 'skipped' : rawStatus === 'scheduled' ? 'pending_confirmation' : ['synced', 'skipped', 'pending_confirmation', 'retrying', 'failed'].includes(rawStatus) ? rawStatus : 'failed';
        return send(res, 200, {
          ...result,
          event_id: result.event_id || body.event_id,
          target_system: 'M10_POMS',
          status,
          changed: result.changed || { closed_items: (result.closed_items || []).length, reassigned_tasks: (result.reassigned_tasks || []).length },
          received_at: new Date().toISOString(),
        });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    // 生产默认 fail-closed；开发环境可显式关闭以保留 L0 演示。登录和当前用户查询是唯一公开认证入口。
    const isApi = pathname.startsWith('/api/') || pathname.startsWith('/poms/');
    const isPublicAuth = pathname === '/api/v1/plm2/auth/login' || pathname === '/api/v1/plm2/auth/me';
    if (isApi && !isPublicAuth) await getRequestSession(req, { required: REQUIRE_AUTH });

    // ---- API (proposal only) ----
    if (pathname === '/poms/v1/me/manifest' && req.method === 'GET') {
      const actorId = requestLegacyActorId(req, q.actor_id);
      const manifest = assembly.assemble({
        actor_id: actorId,
        product_family: q.product_family,
        model_id: q.model_id,
        process_revision: q.process_revision,
        device_capabilities: { camera: q.camera !== '0', mic: q.mic !== '0' },
        context_revision: q.context_revision
      });
      return send(res, 200, manifest);
    }

    if (pathname === '/poms/v1/me/actions' && req.method === 'GET') {
      const actorId = requestLegacyActorId(req, q.actor_id);
      const actions = m01.getDEHActions(actorId);
      return send(res, 200, { actor_id: actorId, actions });
    }

    if (pathname === '/poms/v1/captures' && req.method === 'POST') {
      const body = await readBody(req);
      await getRequestSession(req, { required: REQUIRE_AUTH, fresh: true });
      const actorId = requestLegacyActorId(req, body.actor_id);
      const result = capture.submitCapture({ ...body, actor_id: actorId, idempotency_key: req.headers['idempotency-key'] || body.idempotency_key });
      return send(res, 202, result);
    }

    if (pathname === '/poms/v1/agents' && req.method === 'GET') {
      return send(res, 200, { agents: hub.listAgents(), hub_connected: hub.HUB_CONNECTED });
    }

    const sessionMatch = pathname.match(/^\/poms\/v1\/agents\/([^/]+)\/sessions$/);
    if (sessionMatch && req.method === 'POST') {
      await getRequestSession(req, { required: REQUIRE_AUTH, fresh: true });
      const session = hub.openSession(sessionMatch[1]);
      return send(res, 201, session);
    }

    // ---- PLM-2 研发中心（真实数据接入，来自 PLM2 仓库） ----
    if (pathname === '/api/v1/plm2/roles' && req.method === 'GET') {
      return send(res, 200, { roles: plm2.getRoles(), departments: plm2.getDepartments(), modules: plm2.getModules() });
    }
    if (pathname === '/api/v1/plm2/people' && req.method === 'GET') {
      return send(res, 200, { people: plm2.getPeople(requestRole(req, q.role)) });
    }
    if (pathname === '/api/v1/plm2/dicts' && req.method === 'GET') {
      return send(res, 200, { dicts: plm2.getDicts(), lifecycle: plm2.getLifecycle() });
    }
    if (pathname === '/api/v1/plm2/me/manifest' && req.method === 'GET') {
      return send(res, 200, plm2.getManifest(requestRole(req, q.role)));
    }
    if (pathname === '/api/v1/plm2/me/overview' && req.method === 'GET') {
      return send(res, 200, plm2.overview(requiredPlmPersonId(req, q.user)));
    }
    if (pathname === '/api/v1/plm2/me/todos' && req.method === 'GET') {
      const userId = requiredPlmPersonId(req, q.user);
      const u = plm2.getPeople().find(p => p.id === Number(userId));
      const plmTodos = plm2.todosFor(u ? u.name : '');
      // 会议助手待办（并入「我的待办」）
      let meeting = { source: 'meeting-assistant', live: false, connected: false, items: [], counts: { total: 0, overdue: 0, todo: 0, done: 0, anomaly: 0 } };
    try { meeting = meetingAdapter.listMine(u ? { name: u.name, username: u.username } : { name: '' }, { meetingBase: process.env.MEETING_WEB || '' }); } catch (e) { meeting.error = e.message; }
    // 总库输出的个人待办（总库自有条目，可在此直接更新状态）
    let personal = { owner: u ? u.name : '', dept: '', items: [], counts: { total: 0 } };
    try { personal = taskhub.forPerson(u ? u.name : '', {}); } catch (e) { personal.error = e.message; }
      return send(res, 200, Object.assign({ realName: u ? u.name : userId }, plmTodos, { meeting, taskhub: personal }));
    }
    if (pathname === '/api/v1/plm2/me/dept-todos' && req.method === 'GET') {
      const userId = requiredPlmPersonId(req, q.user);
      const base = plm2.deptTodos(userId);
      // 为每个部门附加总库自有条目计数（明细走 /api/v1/tasks/dept）
      try {
        (base.departments || []).forEach(dp => {
          const t = taskhub.forDept(dp.deptName || dp.deptCode, {});
          dp.taskhub = { total: t.counts.total, overdue: t.counts.overdue || 0, items: [] };
        });
      } catch (e) { base.taskhubError = e.message; }
      return send(res, 200, base);
    }
    if (pathname === '/api/v1/plm2/work-items' && req.method === 'GET') {
      const userId = requiredPlmPersonId(req, q.user);
      const wsTodos = plm2.listApprovalTodos(userId).filter(t => t.status === 'OPEN');
      return send(res, 200, { items: [...wsTodos, ...plm2.listWorkItems(userId)] });
    }
    if (pathname === '/api/v1/plm2/materials' && req.method === 'GET') {
      let list = plm2.listMaterials(requestRole(req, q.role));
      // 模糊查找：料号/名称包含即命中（手机端选料用）
      if (q.q) {
        const k = String(q.q).trim().toLowerCase();
        list = list.filter(x => (String(x.partNo || '') + ' ' + String(x.name || '')).toLowerCase().includes(k));
      }
      return send(res, 200, { materials: list, matched: list.length, keyword: q.q || '' });
    }
    if (pathname === '/api/v1/plm2/ecns' && req.method === 'GET') {
      return send(res, 200, { ecns: plm2.listEcns(requestRole(req, q.role)) });
    }
    if (pathname === '/api/v1/plm2/process-routes' && req.method === 'GET') {
      return send(res, 200, { routes: plm2.listProcessRoutes() });
    }
    const stepDone = pathname.match(/^\/api\/v1\/plm2\/process-routes\/([^/]+)\/steps\/(\d+)\/complete$/);
    if (stepDone && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      return send(res, 200, plm2.completeStep(stepDone[1], stepDone[2], body));
    }
    if (pathname === '/api/v1/plm2/projects' && req.method === 'GET') {
      return send(res, 200, { projects: plm2.listProjects(), gates: plm2.getGates() });
    }
    if (pathname === '/api/v1/plm2/tools' && req.method === 'GET') {
      return send(res, 200, { tools: TOOLS.tools });
    }
    /* ---- 总任务库（引用索引 + 本地短期库；不写专业库）---- */
    if (pathname === '/api/v1/tasks' && req.method === 'GET') {
      let s = taskhub.list({
        owner: q.owner, domain: q.domain, source: q.source, status: q.status,
        q: q.q, activeOnly: q.active === '1'
      });
      // 首次访问自动归集一次（本地短期库为空时），避免入口空白
      if (s.total === 0 && !s.updatedAt) {
        try { await taskhub.refresh({}); } catch (e) { /* 源不可用由 sources 健康度体现 */ }
        s = taskhub.list({
          owner: q.owner, domain: q.domain, source: q.source, status: q.status,
          q: q.q, activeOnly: q.active === '1'
        });
      }
      return send(res, 200, s);
    }
    if (pathname === '/api/v1/tasks/refresh' && req.method === 'POST') {
      const r = await taskhub.refresh({});
      taskhubBroadcast('refresh', { total: r.total });
      return send(res, 200, r);
    }
    if (pathname === '/api/v1/tasks/extract' && req.method === 'POST') {
      const body = await readBody(req);
      const r = taskhub.extractCandidates({ text: body.text, actor: body.actor });
      if (r.produced) taskhubBroadcast('extract', { produced: r.produced });
      return send(res, 200, r);
    }
    /* 个人待办 / 部门待办输出（总库 → 个人/部门，即时读） */
    if (pathname === '/api/v1/tasks/person' && req.method === 'GET') {
      if (!q.name) return send(res, 400, { error: '请填写姓名' });
      return send(res, 200, taskhub.forPerson(q.name, {}));
    }
    if (pathname === '/api/v1/tasks/dept' && req.method === 'GET') {
      if (!q.dept) return send(res, 400, { error: '请选择部门' });
      return send(res, 200, taskhub.forDept(q.dept, {}));
    }
    if (pathname === '/api/v1/tasks/activities' && req.method === 'GET') {
      return send(res, 200, { activities: taskhub.activities(Number(q.limit) || 50) });
    }
    /* 总库 ↔ PLM 双向同步：拉取 PLM 变更 → 重建总库 → SSE 推送 */
    if (pathname === '/api/v1/tasks/plm-sync' && req.method === 'POST') {
      const body = await readBody(req);
      const pull = await plm2.syncPull(body.person || null);
      const r = await taskhub.refresh({});
      taskhubBroadcast('plm-sync', { pulled: pull.pulled, failed: pull.failed, total: r.total });
      return send(res, 200, { pull, taskhub: { total: r.total, updatedAt: r.updatedAt }, plm: plm2.syncStatus() });
    }
    /* 变更实时推送（SSE）：总库/个人/部门页面收到后立即重载 */
    if (pathname === '/api/v1/tasks/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 3000\n\n');
      res.write('data: ' + JSON.stringify({ kind: 'hello', at: Date.now() }) + '\n\n');
      TASKHUB_SSE.add(res);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 25000);
      req.on('close', () => { clearInterval(hb); TASKHUB_SSE.delete(res); });
      return;
    }
    if (pathname === '/api/v1/tasks/candidates' && req.method === 'GET') {
      const s = taskhub.list({});
      return send(res, 200, { total: s.candidates.length, candidates: s.candidates, engine: 'rule-based', reviewRequired: true });
    }
    const candReview = pathname.match(/^\/api\/v1\/tasks\/candidates\/([^/]+)\/(confirm|reject)$/);
    if (candReview && req.method === 'POST') {
      const body = await readBody(req);
      const reviewer = taskhubReviewer(body.reviewer);
      if (!reviewer) return send(res, 403, { error: '只有有权限的管理员才能确认；请检查姓名或权限' });
      const r = candReview[2] === 'confirm'
        ? taskhub.confirmCandidate(decodeURIComponent(candReview[1]), { reviewer: reviewer.name, ownerName: body.ownerName, due: body.due, bizDomain: body.bizDomain })
        : taskhub.rejectCandidate(decodeURIComponent(candReview[1]), { reviewer: reviewer.name, reason: body.reason });
      if (r.status === 200) taskhubBroadcast('candidate', { action: candReview[2] });
      return send(res, r.status, r.body);
    }
    const taskProgress = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/progress$/);
    if (taskProgress && req.method === 'POST') {
      const body = await readBody(req);
      // 责任人本人可直接更新；其他需管理角色（服务端校验，不信任前端）
      const actorPerson = plm2.getPeople().find(x => x.name === body.actor || x.username === body.actor);
      if (!actorPerson) return send(res, 403, { error: '操作人必须是系统里已有的人员' });
      const r = await taskhub.updateProgress(decodeURIComponent(taskProgress[1]), { status: body.status, actor: actorPerson.name, note: body.note });
      if (r.status === 200) taskhubBroadcast('progress', { id: r.body.item.id, status: r.body.item.status, actor: actorPerson.name });
      return send(res, r.status, r.body);
    }
    const taskAssign = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/assign$/);
    if (taskAssign && req.method === 'POST') {
      const body = await readBody(req);
      const reviewer = taskhubReviewer(body.reviewer);
      if (!reviewer) return send(res, 403, { error: '只有有权限的管理员才能分配；请检查姓名或权限' });
      const r = taskhub.assignItem(decodeURIComponent(taskAssign[1]), { ownerName: body.ownerName, reviewer: reviewer.name });
      if (r.status === 200) taskhubBroadcast('assign', { id: r.body.item.id, ownerName: r.body.item.ownerName });
      return send(res, r.status, r.body);
    }
    if (pathname === '/api/v1/skills' && req.method === 'GET') {
      const skill = q.id ? SKILLS.skills.find(s => s.id === q.id) : null;
      if (q.id && !skill) return send(res, 404, { error: 'skill not found' });
      return send(res, 200, q.id ? skill : {
        pack: SKILLS.skillPack, version: SKILLS.version, description: SKILLS.description,
        count: SKILLS.skills.length, skills: SKILLS.skills, plmRealAgents: SKILLS.plmRealAgents, usage: SKILLS.usage
      });
    }
    const toolLaunch = pathname.match(/^\/api\/v1\/plm2\/tools\/([^/]+)\/launch$/);
    if (toolLaunch && req.method === 'POST') {
      await getRequestSession(req, { required: REQUIRE_AUTH, fresh: true });
      const id = toolLaunch[1];
      const tool = TOOLS.tools.find(t => t.id === id);
      if (!tool || tool.type !== 'desktop') return send(res, 404, { ok: false, error: '工具不存在或非桌面工具' });
      const bin = tool.bin;
      if (!bin || !fs.existsSync(bin)) return send(res, 503, { ok: false, installed: false, error: tool.name + ' 未安装（未配置可执行文件）' });
      try {
        const child = spawn(bin, [], { cwd: path.dirname(bin), detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        return send(res, 200, { ok: true, id, name: tool.name, pid: child.pid, launched: true });
      } catch (e) {
        return send(res, 500, { ok: false, launched: false, error: '启动失败：' + e.message });
      }
    }
    const kicadGen = pathname.match(/^\/api\/v1\/plm2\/tools\/kicad\/generate$/);
    if (kicadGen && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      let r;
      if (body.params && Array.isArray(body.params.components)) {
        r = circuit.generate({ supply: body.params.supply, components: body.params.components });
      } else {
        const text = String(body.text || body.prompt || '').trim();
        if (!text) return send(res, 422, { ok: false, error: '请输入电路需求描述（通俗语言）或元件参数' });
        r = circuit.generate(text);
      }
      const outDir = process.env.KICAD_OUT_DIR || 'D:/KiCad/generated';
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const base = 'gen_' + Date.now().toString(36);
      const schPath = path.join(outDir, base + '.kicad_sch').replace(/\\/g, '/');
      const pcbPath = path.join(outDir, base + '.kicad_pcb').replace(/\\/g, '/');
      fs.writeFileSync(schPath, r.sch, 'utf8');
      fs.writeFileSync(pcbPath, r.pcb, 'utf8');
      fs.writeFileSync(path.join(outDir, base + '.kicad_pro'), JSON.stringify({ board: {}, meta: { filename: base + '.kicad_pro', version: 0 } }, null, 2), 'utf8');
      return send(res, 200, {
        ok: true,
        title: r.circuit.title,
        supply: r.circuit.supply,
        components: r.circuit.components,
        nets: r.circuit.nets,
        schPath, pcbPath
      });
    }
    const kicadGenAi = pathname.match(/^\/api\/v1\/plm2\/tools\/kicad\/generate-ai$/);
    if (kicadGenAi && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      let structure;
      const deepseek = require('../../packages/circuit/deepseek');
      const schComplex = require('../../packages/circuit/sch-complex');
      if (body.structure && Array.isArray(body.structure.components)) {
        if (body.edit && String(body.edit).trim()) {
          structure = await deepseek.editStructure(body.structure, body.edit);
        } else {
          structure = body.structure;
        }
      } else {
        const text = String(body.text || body.prompt || '').trim();
        if (!text) return send(res, 422, { ok: false, error: '请输入电路需求/BOM 描述' });
        structure = await deepseek.analyze(text);
      }
      const sch = schComplex.genComplexSch(structure);
      const pcb = schComplex.genComplexPcb(structure);
      const outDir = process.env.KICAD_OUT_DIR || 'D:/KiCad/generated';
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const base = 'ai_' + Date.now().toString(36);
      const schPath = path.join(outDir, base + '.kicad_sch').replace(/\\/g, '/');
      const pcbPath = path.join(outDir, base + '.kicad_pcb').replace(/\\/g, '/');
      fs.writeFileSync(schPath, sch, 'utf8');
      fs.writeFileSync(pcbPath, pcb, 'utf8');
      fs.writeFileSync(path.join(outDir, base + '.kicad_pro'), JSON.stringify({ board: {}, meta: { filename: base + '.kicad_pro', version: 0 } }, null, 2), 'utf8');
      return send(res, 200, {
        ok: true,
        title: structure.title,
        topology: structure.topology,
        components: structure.components,
        connections: structure.connections,
        schPath, pcbPath
      });
    }
    const kicadOpen = pathname.match(/^\/api\/v1\/plm2\/tools\/kicad\/open$/);
    if (kicadOpen && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      const file = path.normalize(String(body.file || ''));
      const outDir = path.normalize(process.env.KICAD_OUT_DIR || 'D:/KiCad/generated');
      if (!file.startsWith(outDir)) return send(res, 403, { ok: false, error: '只能打开生成目录内的文件' });
      const bin = (TOOLS.tools.find(t => t.id === 'kicad') || {}).bin;
      if (!bin || !fs.existsSync(bin)) return send(res, 503, { ok: false, error: 'KiCad 未安装' });
      // kicad.exe 是项目管理器：按扩展名路由到对应编辑器（pcb→pcbnew，sch→eeschema）
      const ext = path.extname(file).toLowerCase();
      const exe = ext === '.kicad_pcb' ? 'pcbnew.exe' : ext === '.kicad_sch' ? 'eeschema.exe' : path.basename(bin);
      const binExe = path.join(path.dirname(bin), exe);
      if (!fs.existsSync(binExe)) return send(res, 500, { ok: false, error: '未找到 ' + exe });
      const child = spawn(binExe, [file], { cwd: path.dirname(bin), detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return send(res, 200, { ok: true, file, exe, pid: child.pid });
    }
    const kicadPreview = pathname.match(/^\/api\/v1\/plm2\/tools\/kicad\/preview$/);
    if (kicadPreview && req.method === 'GET') {
      const file = path.normalize(String(q.file || ''));
      const outDir = path.normalize(process.env.KICAD_OUT_DIR || 'D:/KiCad/generated');
      if (!file.startsWith(outDir)) return send(res, 403, { ok: false, error: '只能预览生成目录内的文件' });
      if (!fs.existsSync(file)) return send(res, 404, { ok: false, error: '文件不存在' });
      const bin = (TOOLS.tools.find(t => t.id === 'kicad') || {}).bin;
      if (!bin || !fs.existsSync(bin)) return send(res, 503, { ok: false, error: 'KiCad 未安装' });
      const kicadCli = path.join(path.dirname(bin), 'kicad-cli.exe');
      const ext = path.extname(file).toLowerCase();
      const sub = ext === '.kicad_sch' ? 'sch' : 'pcb';
      const baseDir = fs.mkdtempSync(path.join(path.dirname(file), '_pv_'));
      const posix = (p) => p.replace(/\\/g, '/');
      try {
        let svg;
        if (sub === 'pcb') {
          // pcb export svg：-o 是输出文件本身（直接读取该文件）
          const outFile = path.join(baseDir, 'out.svg');
          execFileSync(kicadCli, ['pcb', 'export', 'svg', '-l', 'F.Cu,Edge.Cuts,F.SilkS,F.Fab', '-o', posix(outFile), posix(file)], { stdio: 'ignore', timeout: 60000, windowsHide: true });
          svg = fs.readFileSync(outFile, 'utf8');
        } else {
          // sch export svg：-o 是输出目录（kicad 自建并写入 <名>.svg）
          const outDir2 = path.join(baseDir, 'out');
          execFileSync(kicadCli, ['sch', 'export', 'svg', '-o', posix(outDir2), posix(file)], { stdio: 'ignore', timeout: 60000, windowsHide: true });
          const svgFile = fs.readdirSync(outDir2).find(f => f.endsWith('.svg'));
          if (!svgFile) throw new Error('SVG 导出失败');
          svg = fs.readFileSync(path.join(outDir2, svgFile), 'utf8');
        }
        if (!svg.includes('<svg')) throw new Error('SVG 内容无效');
        fs.rmSync(baseDir, { recursive: true, force: true });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(svg);
      } catch (e) {
        fs.rmSync(baseDir, { recursive: true, force: true });
        return send(res, 500, { ok: false, error: '预览生成失败：' + e.message });
      }
    }
    if (pathname === '/api/v1/plm2/worksheet-types' && req.method === 'GET') {
      return send(res, 200, { defs: plm2.getWorksheetDefs(), nodeMap: plm2.getNodeWorksheetMap() });
    }
    if (pathname === '/api/v1/plm2/worksheets' && req.method === 'GET') {
      return send(res, 200, { worksheets: plm2.listWorksheets(q.projectNo, q.nodeCode) });
    }
    if (pathname === '/api/v1/plm2/worksheets' && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      return send(res, 201, plm2.submitWorksheet(body));
    }
    if (pathname === '/api/v1/plm2/ws-templates' && req.method === 'GET') {
      return send(res, 200, { templates: plm2.getWsTemplates(), nodeMap: plm2.getNodeWorksheetMap() });
    }
    if (pathname === '/api/v1/plm2/ws-history' && req.method === 'GET') {
      return send(res, 200, await plm2.getWorksheetHistory({ projectNo: q.projectNo, nodeCode: q.nodeCode }));
    }
    if (pathname === '/api/v1/plm2/ws-v2' && req.method === 'GET') {
      if (q.approvals === '1') return send(res, 200, { items: plm2.listWorksheetApprovals() });
      return send(res, 200, { items: plm2.listWorksheetsV2(q) });
    }
    if (pathname === '/api/v1/plm2/ws-v2' && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      return send(res, 200, plm2.makeWorksheet(body));
    }
    const wsAppr = pathname.match(/^\/api\/v1\/plm2\/ws-v2\/([^/]+)\/(approve|reject)$/);
    if (wsAppr && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      const fn = wsAppr[2] === 'approve' ? plm2.approveWorksheet : plm2.rejectWorksheet;
      const r = fn(wsAppr[1], body);
      const syncResults = await plm2.flushSync();
      return send(res, 200, Object.assign(r, { plmSync: syncResults[0] || null }));
    }
    if (pathname === '/api/v1/plm2/ecns' && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      return send(res, 201, plm2.createEcn(body));
    }
    const projMatch = pathname.match(/^\/api\/v1\/plm2\/projects\/([^/]+)$/);
    if (projMatch && req.method === 'GET') {
      return send(res, 200, await plm2.getProjectAsync(decodeURIComponent(projMatch[1]), { fresh: q.fresh === '1' }));
    }
    if (pathname === '/api/v1/plm2/auth/revoke' && req.method === 'POST') {
      const s = await getRequestSession(req, { required: REQUIRE_AUTH, fresh: true });
      if (s && !s.roles.includes('ADMIN')) throw Object.assign(new Error('仅管理员可撤销 BFF 令牌缓存'), { status: 403 });
      authCache.clear();
      return send(res, 200, { revoked: true, clearedAt: new Date().toISOString(), note: '已清空令牌缓存，下次写操作将重新经 PLM /auth/info 验证（令牌无效则 401）' });
    }
    if (pathname === '/api/v1/plm2/initiations' && req.method === 'GET') {
      return send(res, 200, { items: plm2.listInitiations(q) });
    }
    if (pathname === '/api/v1/plm2/initiations' && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      return send(res, 201, plm2.createInitiation(body));
    }
    const initTrans = pathname.match(/^\/api\/v1\/plm2\/initiations\/([^/]+)\/transition$/);
    if (initTrans && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      return send(res, 200, plm2.transitionInitiation(initTrans[1], body.action, body));
    }
    if (pathname === '/api/v1/plm2/sync-status' && req.method === 'GET') {
      return send(res, 200, plm2.syncStatus());
    }
    if (pathname === '/api/v1/plm2/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { token, vo } = await plmSync.loginWith(body.username, body.password);
        return send(res, 200, Object.assign({ token }, authSession(vo)));
      } catch (e) {
        return send(res, e.status === 401 ? 401 : (e.status || 502), { error: e.message });
      }
    }
    if (pathname === '/api/v1/plm2/auth/me' && req.method === 'GET') {
      const h = req.headers['authorization'] || '';
      const m = h.match(/^Bearer\s+(.+)$/i);
      if (!m) return send(res, 401, { error: '未登录' });
      try {
        const vo = await plmSync.infoWith(m[1]);
        return send(res, 200, authSession(vo));
      } catch (e) {
        return send(res, 401, { error: e.message });
      }
    }
    if (pathname === '/api/v1/plm2/sync' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      await guardWriteRole(req, body);
      return send(res, 200, await plm2.syncPull(requiredPlmPersonId(req, body.person) || null));
    }
    const prjStatusM = pathname.match(/^\/api\/v1\/plm2\/projects\/([^/]+)\/status$/);
    if (prjStatusM && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      return send(res, 200, plm2.updateProjectStatus(prjStatusM[1], body.status, body.role));
    }
    const nodeUpd = pathname.match(/^\/api\/v1\/plm2\/projects\/([^/]+)\/nodes\/([^/]+)$/);
    if (nodeUpd && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      const r = plm2.updateNode(decodeURIComponent(nodeUpd[1]), decodeURIComponent(nodeUpd[2]), body);
      const syncResults = await plm2.flushSync();
      return send(res, 200, Object.assign(r, { plmSync: syncResults[0] || null }));
    }
    const prjEdit = pathname.match(/^\/api\/v1\/plm2\/projects\/([^/]+)\/edit$/);
    if (prjEdit && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      const r = plm2.updateProject(decodeURIComponent(prjEdit[1]), body, body.role);
      const syncResults = await plm2.flushSync();
      return send(res, 200, Object.assign(r, { plmSync: syncResults[0] || null }));
    }
    const matEdit = pathname.match(/^\/api\/v1\/plm2\/materials\/([^/]+)\/edit$/);
    if (matEdit && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      return send(res, 200, plm2.updateMaterial(decodeURIComponent(matEdit[1]), body, body.role));
    }
    if (pathname === '/api/v1/plm2/capture-types' && req.method === 'GET') {
      return send(res, 200, { captureTypes: plm2.getCaptureTypes(requestRole(req, q.role)) });
    }
    if (pathname === '/api/v1/plm2/captures' && req.method === 'GET') {
      return send(res, 200, { captures: plm2.listCaptures(requiredPlmPersonId(req, q.operator)) });
    }
    if (pathname === '/api/v1/plm2/captures' && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      const result = plm2.submitCapture({ ...body, idempotency_key: req.headers['idempotency-key'] || body.idempotency_key });
      return send(res, result.replay ? 200 : 201, result);
    }
    const matTrans = pathname.match(/^\/api\/v1\/plm2\/materials\/([^/]+)\/transition$/);
    if (matTrans && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      const r = plm2.transitionMaterial(matTrans[1], body.action, body.role);
      return send(res, 200, r);
    }
    const ecnTrans = pathname.match(/^\/api\/v1\/plm2\/ecns\/([^/]+)\/transition$/);
    if (ecnTrans && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      const r = plm2.ecnTransition(ecnTrans[1], body.action, body.role);
      return send(res, 200, r);
    }
    const wiDone = pathname.match(/^\/api\/v1\/plm2\/work-items\/([^/]+)\/done$/);
    if (wiDone && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      const r = plm2.completeWorkItem(wiDone[1], body.role);
      return send(res, 200, r);
    }

    // ---- 组织/岗位装配（公司→部门→岗位→职责/任务/能力包） ----
    if (pathname === '/api/v1/org/companies' && req.method === 'GET') {
      return send(res, 200, { companies: org.listCompanies() });
    }
    if (pathname === '/api/v1/org/departments' && req.method === 'GET') {
      return send(res, 200, { departments: org.listDepartments(q.company) });
    }
    if (pathname === '/api/v1/org/positions' && req.method === 'GET') {
      return send(res, 200, { positions: org.listPositions(q.company, q.department) });
    }
    if (pathname === '/api/v1/org/assemble' && req.method === 'GET') {
      const result = org.assemble({ company: q.company, department: q.department, position: q.position });
      return send(res, 200, result);
    }

    // ---- 恒剑 M07+M10 契约（来自《AEOS_M07_M10_可开发资料包 V1.0》03 章，候选） ----
    if (pathname === '/api/v1/poms/me/workspace' && req.method === 'GET') {
      const personId = requestPersonId(req, q.person_id);
      if (!personId) throw Object.assign(new Error('缺少当前人员身份'), { status: 401 });
      const p = m01.getPerson(personId);
      const widgets = ['future_todos', 'past_results', 'personal_agent'].map(id => ({ id, visible: true }));
      if (!p) {
        // 真实业务身份（PLM 令牌）→ 按 HLC 角色派生 actions（服务端仍终审）
        const rawAuth = req.headers['authorization'] || '';
        const m = rawAuth.match(/^Bearer\s+(.+)$/i);
        if (!m) return send(res, 401, { error: 'person not found' });
        const sess = await hlc.exchangePlm(m[1]);
        const actions = ['hlc.service_request.create'];
        if (['hr_admin', 'admin'].includes(sess.role)) actions.push('hlc.request.assign', 'hlc.request.approve', 'hlc.request.verify', 'hlc.request.read');
        else if (['manager', 'executive', 'finance'].includes(sess.role)) actions.push('hlc.request.approve', 'hlc.request.verify', 'hlc.request.read');
        return send(res, 200, {
          tenant_id: 'HPT-00000001',
          person_id: sess.personId,
          name: sess.name,
          positions: ['PLM 统一认证'],
          policy_version: 'candidate-v1',
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          industry_pack_ref: 'lighting_demo',
          widgets,
          actions,
          source: 'hlc-rest'
        });
      }
      const actions = [];
      if (p.capabilities.includes('hlc:request:create')) actions.push('hlc.service_request.create');
      if (p.capabilities.includes('hlc:request:assign')) actions.push('hlc.request.assign');
      if (p.capabilities.includes('hlc:request:approve')) actions.push('hlc.request.approve');
      if (p.capabilities.includes('hlc:request:verify')) actions.push('hlc.request.verify');
      return send(res, 200, {
        tenant_id: p.tenant_id,
        person_id: p.person_id,
        name: p.name,
        positions: p.positions,
        policy_version: 'candidate-v1',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        industry_pack_ref: 'lighting_demo',
        widgets,
        actions
      });
    }

    if (pathname === '/api/v1/poms/me/work-items' && req.method === 'GET') {
      const personId = requestPersonId(req, q.person_id);
      if (!personId) throw Object.assign(new Error('缺少当前人员身份'), { status: 401 });
      const p = m01.getPerson(personId);
      const who = p || { person_id: personId, tenant_id: 'HPT-00000001', capabilities: [] };
      const isAdmin = who.capabilities.includes('hlc:request:read');
      let all, source = 'm07-mock';
      try { all = await hlc.listRequests({ ...q, requester: personId }, personId); source = 'hlc-rest'; }
      catch (e) { all = filterVisibleRequests(m07.listRequests({ ...q, requester: personId }), personId); source = 'm07-mock-fallback'; }
      const items = all
        .filter(r => isAdmin || r.requester === who.person_id || r.assignee === who.person_id)
        .filter(r => ['CLOSED', 'ARCHIVED', 'REJECTED', 'CANCELLED'].indexOf(r.state) < 0)
        .map(r => ({
          work_item_id: 'wi_' + r.id,
          tenant_id: who.tenant_id,
          assignee_person_id: who.person_id,
          source_system: 'M07',
          source_object_type: r.type === 'leave' ? 'LeaveRequest' : 'LogisticsRequest',
          source_object_id: r.id,
          title: r.subject,
          display_status: r.state.toLowerCase(),
          due_at: r.sla && /^\d{4}/.test(r.sla) ? r.sla : (r.sla ? '2026-' + r.sla + 'T09:00:00+08:00' : null),
          allowed_action_refs: allowedActions(who, r)
        }));
      return send(res, 200, { items, source });
    }

    if (pathname === '/api/v1/poms/me/results' && req.method === 'GET') {
      const personId = requestPersonId(req, q.person_id);
      if (!personId) throw Object.assign(new Error('缺少当前人员身份'), { status: 401 });
      const p = m01.getPerson(personId);
      let all, source = 'm07-mock';
      try { all = await hlc.listRequests({ ...q, requester: personId }, personId); source = 'hlc-rest'; }
      catch (e) { all = filterVisibleRequests(m07.listRequests({ ...q, requester: personId }), personId); source = 'm07-mock-fallback'; }
      const results = all
        .filter(r => r.state === 'CLOSED' || r.state === 'ARCHIVED')
        .map(r => ({ result_id: r.result_ref || 'res_' + r.id, source_system: 'M07', source_object_id: r.id, verification: r.verified_by ? 'verified' : 'pending', evidence_refs: r.evidence_refs, verified_by: r.verified_by, verified_at: r.verified_at }));
      return send(res, 200, { results, source });
    }

    if (pathname === '/api/v1/hlc/status' && req.method === 'GET') {
      return send(res, 200, await hlc.status());
    }

    if (pathname === '/api/v1/hlc/people' && req.method === 'GET') {
      const people = m07.getPeople();
      const st = await hlc.status();
      // 标注哪些演示演员已映射真实 HLC 账号（未映射的写操作走服务账号）
      people.forEach(p => { p.hlc_real = !!hlc.ACTORS[p.person_id]; });
      // 合并已登录的真实 PLM 身份（令牌交换后的 M04 账号）
      const extra = hlc.plmPeople();
      return send(res, 200, { people: [...people, ...extra], source: st.connected ? 'hlc-rest' : 'm07-mock', hlc: st });
    }

    // M04 PLM 统一认证登录 → HLC 令牌（真实业务身份入口）
    if (pathname === '/api/v1/hlc/auth/plm-login' && req.method === 'POST') {
      const body = await readBody(req);
      const { token: plmToken, vo } = await plmSync.loginWith(body.username, body.password);
      const sess = await hlc.exchangePlm(plmToken);
      return send(res, 200, {
        plmToken,
        hlcToken: sess.token,
        plm: { userId: vo.userId, username: vo.username, realName: vo.realName, roles: vo.roles },
        hlcUser: { id: sess.userId, name: sess.name, role: sess.role, personId: sess.personId },
        provisioned: sess.provisioned
      });
    }

    // 当前登录身份（Authorization: Bearer <PLM 令牌>）
    if (pathname === '/api/v1/hlc/auth/me' && req.method === 'GET') {
      const h = req.headers['authorization'] || '';
      const m = h.match(/^Bearer\s+(.+)$/i);
      if (!m) return send(res, 401, { error: '未登录' });
      const sess = await hlc.exchangePlm(m[1]);
      return send(res, 200, { hlcUser: { id: sess.userId, name: sess.name, role: sess.role, personId: sess.personId } });
    }

    if (pathname === '/api/v1/hlc/service-requests' && req.method === 'POST') {
      const body = await readBody(req);
      await getRequestSession(req, { required: REQUIRE_AUTH, fresh: true });
      const requester = requestPersonId(req, body.requester);
      if (!requester) throw Object.assign(new Error('缺少申请人身份'), { status: 401 });
      const idempotency_key = req.headers['idempotency-key'] || body.idempotency_key;
      const auth = req.headers['authorization'] || null;
      try {
        const created = await hlc.createRequest({ ...body, requester, idempotency_key, auth }); // 真实 HLC：DRAFT
        if (!created.replay) await hlc.submitRequest(created.id, requester, auth);
        const full = await hlc.getRequest(created.id, requester, auth);
        return send(res, created.replay ? 200 : 201, { ...full, history: undefined, replay: created.replay, source: 'hlc-rest' });
      } catch (e) {
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 401) throw e; // 业务错误如实上抛
        // HLC 不可达 → 降级 mock（与 PLM 读透降级同策略）
        const created = m07.createRequest({ ...body, requester, idempotency_key });
        if (!created.replay) m07.submitRequest(created.id, requester);
        return send(res, created.replay ? 200 : 201, { ...m07.getRequest(created.id), history: undefined, replay: created.replay, source: 'm07-mock-fallback', hlc_error: e.message });
      }
    }
    if (pathname === '/api/v1/hlc/service-requests' && req.method === 'GET') {
      const personId = requestPersonId(req, q.person_id);
      if (REQUIRE_AUTH && !personId) throw Object.assign(new Error('当前账号尚未绑定 M01 人员'), { status: 403 });
      const requestFilter = { ...q, requester: personId, person_id: personId };
      try {
        return send(res, 200, { requests: await hlc.listRequests(requestFilter, personId), source: 'hlc-rest' });
      } catch (e) {
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 401) throw e;
        return send(res, 200, { requests: filterVisibleRequests(m07.listRequests(requestFilter), personId), source: 'm07-mock-fallback', hlc_error: e.message });
      }
    }

    let srMatch = pathname.match(/^\/api\/v1\/hlc\/service-requests\/([^/]+)$/);
    if (srMatch && req.method === 'GET') {
      const personId = requestPersonId(req, q.person_id);
      if (REQUIRE_AUTH && !personId) throw Object.assign(new Error('当前账号尚未绑定 M01 人员'), { status: 403 });
      try {
        return send(res, 200, await hlc.getRequest(srMatch[1], personId, req.headers['authorization'] || null));
      } catch (e) {
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 401) throw e;
        const record = m07.getRequest(srMatch[1]);
        if (!filterVisibleRequests([record], personId).length) throw Object.assign(new Error('permission denied'), { status: 403 });
        return send(res, 200, record);
      }
    }

    let trMatch = pathname.match(/^\/api\/v1\/hlc\/service-requests\/([^/]+)\/transitions$/);
    if (trMatch && req.method === 'POST') {
      const body = await readBody(req);
      const rawAuth = req.headers['authorization'] || null;
      const next = body.next_state;
      // 真实身份模式（PLM 令牌）跳过 mock 演员校验，由真实 HLC 服务端鉴权；
      // 演示演员模式沿用 M01 能力预校验（UI 隐藏 ≠ 权限控制）。
      if (!rawAuth) {
        const actor = m01.getPerson(body.actor);
        if (['TRIAGED', 'ASSIGNED'].includes(next) && !actor.capabilities.includes('hlc:request:assign')) throw Object.assign(new Error('permission denied'), { status: 403 });
        if (['APPROVED', 'REJECTED', 'POLICY_CHECKED'].includes(next) && !actor.capabilities.includes('hlc:request:approve')) throw Object.assign(new Error('permission denied'), { status: 403 });
      }
      try {
        const updated = await hlc.transition(trMatch[1], next, { actor: body.actor, note: body.note, assignee: body.assignee, evidence_ref: body.evidence_ref, verifier: body.verifier, sla: body.sla, scope: body.scope, expectedVersion: body.expected_version, auth: rawAuth });
        return send(res, 200, { ...updated, source: 'hlc-rest' });
      } catch (e) {
        if (rawAuth || (e.status && e.status >= 400 && e.status < 500 && e.status !== 401)) throw e;
        const updated = m07.transition(trMatch[1], next, { actor: body.actor, note: body.note, assignee: body.assignee, evidence_ref: body.evidence_ref, verifier: body.verifier, sla: body.sla });
        return send(res, 200, { ...updated, source: 'm07-mock-fallback', hlc_error: e.message });
      }
    }

    if (pathname === '/api/v1/agents/personal/sessions' && req.method === 'POST') {
      const body = await readBody(req);
      await getRequestSession(req, { required: REQUIRE_AUTH, fresh: true });
      const session = hub.openSession(body.agent_id);
      return send(res, 201, session);
    }

    return send(res, 404, { error: 'not found', hint: '见 docs/V2.3_20261023/API_OPENAPI.yaml' });
  } catch (e) {
    const status = e.status || 500;
    return send(res, status, { error: e.message || 'internal error' });
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  const os = require('os');
  const lanIps = Object.values(os.networkInterfaces()).flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal)
    .map(n => n.address);
  const hlcSt = await hlc.status().catch(() => ({ connected: false }));
  console.log('M10 POMS BFF 已启动: http://localhost:' + PORT);
  lanIps.forEach(ip => console.log('  局域网访问:  http://' + ip + ':' + PORT + '/'));
  console.log('  系统门户:   http://localhost:' + PORT + '/');
  console.log('  岗位装配:   http://localhost:' + PORT + '/org');
  console.log('  PLM-2 研发中心: http://localhost:' + PORT + '/plm2');
  console.log('  M07+M10 双端: http://localhost:' + PORT + '/hlc');
  console.log('  HLC 真实后端: ' + (hlcSt.connected ? '已连接 ' + hlcSt.api + '（/api/v1/hlc/* 走真实接口）' : '未连接（降级 mock，' + (hlcSt.error || 'HLC_API 未配置或不可达') + '）'));
  console.log('  恒剑 M07+M10: http://localhost:' + PORT + '/api/v1/poms/me/workspace?person_id=p-002');
  console.log('  API 示例:   http://localhost:' + PORT + '/poms/v1/me/manifest?actor_id=u-1001&product_family=led-light');
  console.log('  契约测试:   npm test');
  console.log('  Hub 连接:   ' + (hub.HUB_CONNECTED ? '已连接' : (hub.configured() ? 'HTTP 模式（经营事项/收件箱待办）' : '未连接（模拟模式，HUB_CONNECTED=1 可开启）')));
  startPlmPoller();
});
