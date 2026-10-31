'use strict';
// adapters/hlc — M07 HLC 真实后端适配（恒聘通 Flask API，模式对齐 adapters/plm2/sync）。
// 目标：M10 BFF 的 /api/v1/hlc/* 从 mock(adapters/m07) 升级为真实 HLC REST，
// 与 PLM-2 接入同一套路：环境变量配置、令牌缓存续期、写透/读透、优雅降级。
// HLC 侧契约：backend-python/routes/hlc.py（/api/v1/hlc/service-requests，action 驱动状态机）。
const http = require('http');

const API_BASE = process.env.HLC_API || 'http://localhost:18280';
const _u = API_BASE.replace(/^https?:\/\//, '');
const HOST = _u.split(':')[0];
const PORT = Number(_u.split(':')[1] || 80);
const TENANT = process.env.HLC_TENANT || 'HPT-00000001';
// 服务账号（无演员映射时的兜底；与 PLM_USER/PLM_PASS 同风格）
const USER = process.env.HLC_USER || 'hlc-admin@demo.local';
const PASS = process.env.HLC_PASS || 'Demo-12345678';
// M10 person_id → HLC 真实账号映射（演示：p-002 人事行政专员=hr_admin，p-003 验收人=manager）
let ACTORS = { 'p-002': { email: 'hlc-p002@demo.local', password: 'Demo-12345678' },
               'p-003': { email: 'hlc-p003@demo.local', password: 'Demo-12345678' } };
try { if (process.env.HLC_ACTORS) ACTORS = JSON.parse(process.env.HLC_ACTORS); } catch (e) { /* 保留默认 */ }

// person_id / 'service' → { token, userId, name, exp }
const tokens = new Map();
// person_id(UUID) → person_id(M10) 反查
const realToPerson = new Map();
Object.keys(ACTORS).forEach(pid => { if (ACTORS[pid].personId) realToPerson.set(ACTORS[pid].personId, pid); });
// 幂等重放标记（真实 HLC 重复 key 返回原资源，这里本地记 key→id 以还原 replay 语义）
const idemSeen = new Map();

function enabled() { return true; } // HLC_API 有默认值；不可达时由 BFF 逐请求降级

function call(method, apiPath, body, token, extraHeaders) {
  return new Promise((resolve, reject) => {
    const s = body ? JSON.stringify(body) : null;
    const o = { host: HOST, port: PORT, path: apiPath, method, headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}) };
    if (token) o.headers.Authorization = 'Bearer ' + token;
    if (s) o.headers['Content-Length'] = Buffer.byteLength(s);
    const q = http.request(o, x => {
      const c = []; x.on('data', d => c.push(d));
      x.on('end', () => {
        const txt = Buffer.concat(c).toString('utf8');
        let j = null; try { j = JSON.parse(txt); } catch (e) { /* non-json */ }
        resolve({ status: x.statusCode, body: j, raw: txt });
      });
    });
    q.on('error', reject);
    q.setTimeout(8000, () => q.destroy(new Error('HLC API 超时')));
    if (s) q.write(s);
    q.end();
  });
}

async function loginAs(email, password) {
  const r = await call('POST', '/api/auth/login', { identifier: email, password: password, tenantSlug: TENANT });
  const d = r.body || {};
  const t = d.token || (d.access_token);
  if (r.status === 200 && t && d.user) {
    return { token: t, userId: d.user.id, name: d.user.name, role: d.user.role, email };
  }
  throw Object.assign(new Error((d.error) || ('HLC 登录失败(' + r.status + ')')), { status: r.status === 200 ? 401 : r.status });
}

/** 取某 M10 演员的 HLC 令牌；未映射演员回退服务账号。缓存 25 分钟。 */
async function tokenFor(personId) {
  const key = ACTORS[personId] ? personId : 'service';
  const hit = tokens.get(key);
  if (hit && hit.exp > Date.now()) return hit;
  const cred = key === 'service' ? { email: USER, password: PASS } : ACTORS[personId];
  const s = await loginAs(cred.email, cred.password);
  s.exp = Date.now() + 25 * 60 * 1000;
  s.personId = key === 'service' ? null : personId;
  tokens.set(key, s);
  if (s.personId) realToPerson.set(s.userId, s.personId);
  return s;
}

async function authed(personId, method, apiPath, body, extraHeaders) {
  let s = await tokenFor(personId);
  let r = await call(method, apiPath, body, s.token, extraHeaders);
  if (r.status === 401) { // 令牌失效重登一次
    tokens.delete(ACTORS[personId] ? personId : 'service');
    s = await tokenFor(personId);
    r = await call(method, apiPath, body, s.token, extraHeaders);
  }
  return r;
}

/* ---------- 契约映射：HLC camelCase ↔ M10 snake_case ---------- */

function toPersonId(realUserId) { return realToPerson.get(realUserId) || realUserId; }

/** 真实 HLC 用户 id（用于派单 assigneeId） */
async function realUserIdOf(personId) {
  if (!personId) return null;
  const s = await tokenFor(personId); // 登录即缓存 userId
  return s.userId;
}

function mapRequest(r) {
  if (!r) return null;
  return {
    id: r.id,
    type: r.requestType,
    subject: r.subject,
    description: r.description,
    requester: toPersonId(r.requesterId),
    requester_name: r.requesterName || null,
    assignee: toPersonId(r.assigneeId),
    assignee_name: r.assigneeName || null,
    sla: r.slaDueAt || null,
    scope: r.scope || null,
    state: r.status,
    result_ref: r.resultRef || null,
    evidence_refs: r.evidenceRefs || [],
    verified_by: r.verifiedBy ? toPersonId(r.verifiedBy) : null,
    verified_at: r.verifiedAt || null,
    object_version: r.stateVersion,
    created_at: r.createdAt,
    history: undefined
  };
}

/** SLA 宽松解析：'10-17' → 今年10月17；'3 天' → now+3d；ISO 直通 */
function parseSla(sla) {
  if (!sla) return null;
  const s = String(sla).trim();
  let m = s.match(/^(\d{2})-(\d{2})$/);
  if (m) return new Date().getFullYear() + '-' + s + 'T09:00:00';
  m = s.match(/^(\d+)\s*天/);
  if (m) { const d = new Date(Date.now() + Number(m[1]) * 864e5); return d.toISOString().slice(0, 19); }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 19);
  const d = new Date(Date.now() + 3 * 864e5); return d.toISOString().slice(0, 19);
}

/** M10 的 next_state（状态目标式）→ HLC 的 action（动作式） */
function resolveAction(current, next) {
  const map = {
    SUBMITTED: 'submit',
    TRIAGED: current === 'NEEDS_INFO' ? 'provide_info' : 'triage',
    ASSIGNED: current === 'ASSIGNED' ? 'reassign' : 'assign',
    IN_PROGRESS: 'start',
    AWAITING_ACCEPTANCE: 'submit_resolution',
    CLOSED: 'close',
    NEEDS_INFO: 'needs_info',
    REJECTED: 'reject',
    CANCELLED: 'cancel',
    REOPENED: 'reopen'
  };
  const leave = ['POLICY_CHECKED', 'APPROVAL_PENDING', 'APPROVED', 'APPLIED', 'ARCHIVED'];
  if (leave.includes(next)) {
    throw Object.assign(new Error('真实 HLC 暂未实现请假流程（' + next + '），候选 Backlog S6'), { status: 422 });
  }
  const action = map[next];
  if (!action) throw Object.assign(new Error('未知目标状态: ' + next), { status: 422 });
  return action;
}

async function createRequest(input) {
  const { type, subject, description, requester, idempotency_key, attachments, site_ref } = input || {};
  if (!idempotency_key) throw Object.assign(new Error('Idempotency-Key required'), { status: 400 });
  const body = { type: type || 'logistics_repair', subject, description: description || '' };
  if (attachments && attachments.length) body.attachments = attachments;
  if (site_ref) body.siteRef = site_ref;
  const r = await authed(requester, 'POST', '/api/v1/hlc/service-requests', body, { 'Idempotency-Key': idempotency_key });
  if (r.status === 201 && r.body && r.body.id) {
    const prev = idemSeen.get(idempotency_key);
    if (prev === undefined) idemSeen.set(idempotency_key, r.body.id);
    return Object.assign(mapRequest(r.body), { replay: prev === r.body.id });
  }
  throw Object.assign(new Error((r.body && r.body.error) || ('创建失败(' + r.status + ')')), { status: r.status });
}

async function submitRequest(id, actor) {
  return transition(id, 'SUBMITTED', { actor });
}

async function getRequest(id, actor) {
  const r = await authed(actor || 'service', 'GET', '/api/v1/hlc/service-requests/' + encodeURIComponent(id));
  if (r.status !== 200 || !r.body || !r.body.id) {
    throw Object.assign(new Error((r.body && r.body.error) || ('request not found(' + r.status + ')')), { status: r.status === 404 ? 404 : r.status });
  }
  const mapped = mapRequest(r.body);
  mapped.history = (r.body.transitions || []).map(t => ({ from: t.fromStatus, to: t.toStatus, at: t.createdAt, actor: toPersonId(t.actorId), note: t.action + (t.remark ? '：' + t.remark : '') }));
  return mapped;
}

async function listRequests(filter, actor) {
  const qs = new URLSearchParams();
  if (filter && filter.state) qs.set('status', String(filter.state).toUpperCase());
  if (filter && filter.type) qs.set('type', filter.type);
  if (filter && filter.page) qs.set('page', filter.page);
  if (filter && filter.pageSize) qs.set('pageSize', filter.pageSize);
  const path = '/api/v1/hlc/service-requests' + (qs.toString() ? '?' + qs.toString() : '');
  const who = (filter && filter.requester) || actor || 'service';
  const r = await authed(who, 'GET', path);
  if (r.status === 200 && r.body && Array.isArray(r.body.items)) return r.body.items.map(mapRequest);
  throw Object.assign(new Error((r.body && r.body.error) || ('列表拉取失败(' + r.status + ')')), { status: r.status });
}

/** M10 式 transition(id, next_state, {actor, note, assignee, evidence_ref, verifier, sla}) → HLC action */
async function transition(id, nextState, opts) {
  opts = opts || {};
  const cur = await getRequest(id, opts.actor); // 读当前状态以解析 action
  const action = resolveAction(cur.state, nextState);
  const body = { action };
  if (opts.note) body.remark = opts.note;
  if (opts.expectedVersion) body.expectedVersion = opts.expectedVersion;

  if (action === 'assign' || action === 'reassign') {
    if (!opts.assignee) throw Object.assign(new Error('ASSIGNED requires assignee and sla'), { status: 422 });
    body.assigneeId = await realUserIdOf(opts.assignee);
    if (!body.assigneeId) throw Object.assign(new Error('执行人未映射 HLC 账号: ' + opts.assignee), { status: 422 });
    body.slaDueAt = parseSla(opts.sla);
    body.scope = opts.scope || 'M10 派单';
  }
  if (action === 'submit_resolution') {
    if (!opts.evidence_ref) throw Object.assign(new Error('AWAITING_ACCEPTANCE requires evidence_ref'), { status: 422 });
    body.resolutionSummary = opts.note || '处理完成';
    body.evidenceRefs = [opts.evidence_ref];
  }
  if (action === 'reopen') {
    if (!opts.evidence_ref) throw Object.assign(new Error('REOPENED requires evidence_ref'), { status: 422 });
    if (!opts.note) throw Object.assign(new Error('REOPENED requires remark'), { status: 422 });
    body.evidenceRefs = [opts.evidence_ref];
  }
  if (action === 'close') {
    const verifier = opts.verifier || opts.actor;
    if (verifier && cur.assignee && verifier === cur.assignee && verifier !== cur.requester) {
      // 与 mock 同口径提示（真实 HLC 也会以 maker-checker 拒绝）
      throw Object.assign(new Error('executor cannot self-verify (done != verified)'), { status: 403 });
    }
  }
  const r = await authed(opts.actor, 'POST', '/api/v1/hlc/service-requests/' + encodeURIComponent(id) + '/transitions', body);
  if (r.status === 200 && r.body && r.body.id) return mapRequest(r.body);
  throw Object.assign(new Error((r.body && r.body.error) || ('转换失败(' + r.status + ')')), { status: r.status });
}

async function status() {
  try {
    const s = await tokenFor('service');
    return { connected: true, api: API_BASE, tenant: TENANT, serviceUser: USER, mappedActors: Object.keys(ACTORS) };
  } catch (e) {
    return { connected: false, api: API_BASE, error: e.message };
  }
}

module.exports = {
  enabled, call, tokenFor, realUserIdOf,
  createRequest, submitRequest, getRequest, listRequests, transition,
  mapRequest, parseSla, resolveAction, status,
  API_BASE, ACTORS
};
