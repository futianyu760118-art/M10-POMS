'use strict';
// adapters/m07 — M07 HLC 人力/后勤自治中心 mock adapter（Owner M07）。
// 首条 MVP 闭环：员工 M10 发起报修/请假 → M01 Guard → M07 受理/派单/审批 → M07 写结果 → M02 归档 → M10 查看报告。
// 状态机与契约来自《AEOS_M07_M10_可开发资料包 V1.0》02/03 章（候选，未冻结）。
const crypto = require('crypto');

/* ---------- 组织与人员（演示样本，非生产档案） ---------- */
const PEOPLE = [
  { person_id: 'p-001', name: '包跃',   dept: '研发中心',   position: '研发工程师',       roles: ['employee'] },
  { person_id: 'p-002', name: '马雅雯', dept: '人事行政部', position: '人事行政专员',     roles: ['hr', 'logistics'] },
  { person_id: 'p-003', name: '王栌鑫', dept: '研发中心',   position: '研发工程师/验收', roles: ['employee', 'verifier'] },
  { person_id: 'p-004', name: '赵采购', dept: '供应链中心', position: '采购',             roles: ['employee'] }
];

/* ---------- 状态机（候选） ---------- */
// 后勤维修：DRAFT → SUBMITTED → TRIAGED → ASSIGNED → IN_PROGRESS → AWAITING_ACCEPTANCE → CLOSED
const LOGISTICS_TRANSITIONS = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['TRIAGED', 'NEEDS_INFO', 'REJECTED', 'CANCELLED'],
  TRIAGED: ['ASSIGNED', 'REJECTED'],
  ASSIGNED: ['IN_PROGRESS', 'NEEDS_INFO'],
  IN_PROGRESS: ['AWAITING_ACCEPTANCE', 'NEEDS_INFO'],
  AWAITING_ACCEPTANCE: ['CLOSED', 'NEEDS_INFO', 'REOPENED'],
  CLOSED: ['REOPENED'],
  NEEDS_INFO: ['TRIAGED', 'ASSIGNED', 'IN_PROGRESS'],
  REJECTED: ['REOPENED'],
  REOPENED: ['ASSIGNED', 'IN_PROGRESS'],
  CANCELLED: []
};
// 请假：DRAFT → SUBMITTED → POLICY_CHECKED → APPROVAL_PENDING → APPROVED/REJECTED → APPLIED → ARCHIVED
const LEAVE_TRANSITIONS = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['POLICY_CHECKED'],
  POLICY_CHECKED: ['APPROVAL_PENDING', 'REJECTED'],
  APPROVAL_PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: ['APPLIED'],
  APPLIED: ['ARCHIVED'],
  REJECTED: [],
  ARCHIVED: []
};
const TRANSITIONS = {
  logistics_repair: LOGISTICS_TRANSITIONS,
  logistics: LOGISTICS_TRANSITIONS,
  leave: LEAVE_TRANSITIONS
};

/* ---------- 内存存储 + 种子数据 ---------- */
const STORE = new Map();
const IDEM = new Map(); // idempotency_key -> request_id

function seed() {
  add({ id: 'LR-26001', type: 'logistics_repair', subject: '车间照明设施维修申请', description: '现场照明灯不亮，等待检查', requester: 'p-003', state: 'ASSIGNED', assignee: 'p-002', sla: '10-17', evidence: null, history: [] });
  add({ id: 'LR-26002', type: 'leave', subject: '请假申请', description: '年假 2 天', requester: 'p-001', state: 'APPROVAL_PENDING', assignee: null, sla: '10-19', evidence: null, history: [] });
  add({ id: 'LR-26003', type: 'logistics_repair', subject: '办公用品申请', description: '打印纸与硒鼓补充', requester: 'p-004', state: 'AWAITING_ACCEPTANCE', assignee: 'p-002', sla: '10-18', evidence: 'EVD-DEMO-101', history: [] });
}
function add(r) {
  if (!r.history) r.history = [];
  if (!r.created_at) r.created_at = new Date().toISOString();
  if (!r.object_version) r.object_version = 1;
  STORE.set(r.id, r);
  return r;
}

/* ---------- 服务 ---------- */
function getPeople() { return PEOPLE.map(p => ({ ...p })); }

function createRequest(input) {
  const { type, subject, description, requester, idempotency_key, attachments } = input || {};
  if (!idempotency_key) throw Object.assign(new Error('Idempotency-Key required'), { status: 400 });
  if (IDEM.has(idempotency_key)) return { ...STORE.get(IDEM.get(idempotency_key)), replay: true };
  if (!type || !subject || !requester) throw Object.assign(new Error('missing required fields'), { status: 422 });
  if (!TRANSITIONS[type]) throw Object.assign(new Error('unknown request type'), { status: 422 });

  const id = (type === 'leave' ? 'LV' : 'LR') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const req = {
    id,
    type,
    subject,
    description: description || '',
    requester,
    attachments: attachments || [],
    assignee: null,
    sla: null,
    state: 'DRAFT',
    result_ref: null,
    evidence_refs: [],
    created_at: new Date().toISOString(),
    object_version: 1,
    history: [{ state: 'DRAFT', at: new Date().toISOString(), actor: requester, note: '创建草稿' }]
  };
  IDEM.set(idempotency_key, id);
  add(req);
  return { ...req };
}

function submitRequest(id, actor) {
  const r = getRequest(id);
  transition(id, 'SUBMITTED', { actor, note: '提交申请' });
  r.requester = r.requester || actor;
  return { ...getRequest(id) };
}

function getRequest(id) {
  const r = STORE.get(id);
  if (!r) throw Object.assign(new Error('request not found'), { status: 404 });
  return r;
}

function listRequests(filter) {
  let list = [...STORE.values()];
  if (filter && filter.type) list = list.filter(r => r.type === filter.type);
  if (filter && filter.state) list = list.filter(r => r.state === filter.state);
  return list.map(r => ({ ...r, history: undefined }));
}

// 状态转换（服务端再鉴权由 BFF 完成）
function transition(id, nextState, opts) {
  const r = getRequest(id);
  const { actor, note, assignee, evidence_ref, verifier } = opts || {};
  const trans = TRANSITIONS[r.type] || {};
  const allowed = trans[r.state] || [];
  if (!allowed.includes(nextState)) {
    throw Object.assign(new Error(`invalid transition ${r.state} -> ${nextState}`), { status: 409 });
  }

  // 约束（done != verified）：进入 AWAITING_ACCEPTANCE 必须有处理结果和证据引用
  if (nextState === 'AWAITING_ACCEPTANCE') {
    if (!evidence_ref) throw Object.assign(new Error('AWAITING_ACCEPTANCE requires evidence_ref'), { status: 422 });
    r.evidence_refs = r.evidence_refs || [];
    r.evidence_refs.push(evidence_ref);
    r.done_by = actor;
    r.done_at = new Date().toISOString();
  }
  // 约束：CLOSED 必须有验证者（执行者不可自验）
  if (nextState === 'CLOSED') {
    if (!verifier) throw Object.assign(new Error('CLOSED requires verifier'), { status: 422 });
    if (verifier === r.done_by) throw Object.assign(new Error('executor cannot self-verify (done != verified)'), { status: 403 });
    r.verified_by = verifier;
    r.verified_at = new Date().toISOString();
    r.result_ref = 'res_' + id;
  }
  // 约束：ASSIGNED 必须有 assignee 与 SLA
  if (nextState === 'ASSIGNED') {
    if (!assignee || !r.sla && !opts.sla) throw Object.assign(new Error('ASSIGNED requires assignee and sla'), { status: 422 });
    if (assignee) r.assignee = assignee;
    if (opts.sla) r.sla = opts.sla;
  }

  const prev = r.state;
  r.state = nextState;
  r.object_version += 1;
  r.history.push({ from: prev, to: nextState, at: new Date().toISOString(), actor, note: note || '' });
  return { ...r, history: undefined };
}

module.exports = { getPeople, createRequest, submitRequest, getRequest, listRequests, transition, TRANSITIONS, PEOPLE };

seed();
