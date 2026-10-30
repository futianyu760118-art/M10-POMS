'use strict';
// adapters/plm2 — 恒剑 PLM 中台 V4.0 mock adapter（Owner M04 研发中心）。
// 数据与状态机来自 PLM2 仓库（database/*.sql、README.md），仅用于 L0 演示。
const crypto = require('crypto');
const ROLE_PRIORITY_MAP = { ADMIN:'ADMIN', admin:'ADMIN', gm:'GM', rd_manager:'RD_LEAD', engineer:'ENGINEER', project_manager:'PROJECT_MANAGER', sales_director:'SALES_MANAGER', sales_manager:'SALES_MANAGER', purchase:'PURCHASE', finance:'FINANCE', cw1:'FINANCE', sales:'SALES', sales_user:'SALES', viewer:'VIEWER', hr_manager:'VIEWER', QUALITY:'QUALITY', ENGINEER:'ENGINEER', SALES:'SALES' };
const D = require('../../configs/plm2.json');

// 内存态（演示会话内可流转，重启复位）
let materials = D.materials.map(m => ({ ...m }));
let ecns = D.ecns.map(e => ({ ...e }));
let workItems = D.workItems.map(w => ({ ...w }));
let routes = D.processRoutes.map(r => ({ ...r, steps: r.steps.map(s => ({ ...s })) }));
let captures = [];
const CAP_IDEM = new Map();
let projects = D.projects.map(p => ({ ...p, nodes: { ...p.nodes } }));
let worksheets = [];

function role(code) { return D.roles.find(r => r.code === code); }
function person(id) { return D.people.find(p => p.id === Number(id)); }

function getPeople(roleCode) {
  let list = D.people;
  if (roleCode) {
    const codes = String(roleCode).split(',').map(s => s.trim());
    list = list.filter(p => codes.includes(p.role) || (p.realRoles || []).some(r => codes.includes(ROLE_PRIORITY_MAP[r] || r)));
  }
  return list.map(p => ({ ...p, deptName: (D.departments.find(d => d.code === p.dept) || {}).name }));
}
function peopleByRole(roleCode) { return getPeople(roleCode); }

function hasPerm(roleCode, perm) {
  const perms = D.rolePermissions[roleCode] || [];
  if (perms.includes(perm)) return true;
  if (perms.includes(perm.split(':')[0] + ':all')) return true;
  if (roleCode === 'ADMIN') return true;
  return false;
}

function getRoles() { return D.roles.map(r => ({ ...r, perms: D.rolePermissions[r.code] || [] })); }
function getDepartments() { return D.departments; }
function getModules() { return D.modules; }
function getDicts() { return D.dicts; }
function getLifecycle() { return D.lifecycle; }

// 岗位装配 manifest（按角色下发可访问模块与职责）
function getManifest(roleCodes) {
  const codes = String(roleCodes || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!codes.length) throw Object.assign(new Error('role not found'), { status: 404 });
  const roles = codes.map(c => role(c)).filter(Boolean);
  if (!roles.length) throw Object.assign(new Error('role not found'), { status: 404 });
  // 兼岗：合并所有角色的权限/模块/职责（去重）
  const permSet = new Set();
  const modSet = new Map();
  const dutyList = [];
  const primary = roles[0];
  roles.forEach(r => {
    (D.rolePermissions[r.code] || []).forEach(p => permSet.add(p));
    D.modules.forEach(m => { if (hasPerm(r.code, m.code)) modSet.set(m.code, m); });
    r.duties.forEach(d => { if (!dutyList.includes(d)) dutyList.push(d); });
  });
  const modules = D.modules.filter(m => modSet.has(m.code));
  // 附加真实菜单树（含子菜单/按钮级权限）
  const plmMenus = D.plmMenus || { menus: [], buttons: [] };
  const menuTree = plmMenus.menus.filter(m => !m.parent).map(m => ({
    ...m,
    children: plmMenus.menus.filter(c => c.parent === m.code),
    buttons: plmMenus.buttons.filter(b => b.parent === m.code)
  }));
  return {
    role: roles.length === 1 ? primary : { code: codes.join(','), name: roles.map(r => r.name).join(' / '), level: Math.max(...roles.map(r => r.level)), dataScope: Math.min(...roles.map(r => r.dataScope)) },
    roles: roles.map(r => ({ code: r.code, name: r.name, level: r.level })),
    duties: dutyList,
    modules,
    menuTree,
    permission_matrix: [...permSet],
    manifest_id: 'm_' + Date.now().toString(36),
    policy_version: 'candidate-v1',
    expires_at: Date.now() + 60 * 60 * 1000,
    note: '兼岗合并：' + roles.length + ' 个角色，' + modules.length + ' 个模块，' + dutyList.length + ' 条职责。UI 隐藏 ≠ 权限控制。'
  };
}

function listMaterials(roleCode) {
  return materials.map(m => ({ ...m, typeLabel: D.dicts.material_type[m.type], statusLabel: D.dicts.material_status[m.status], phaseLabel: D.dicts.phase[m.phase] }));
}
function listEcns(roleCode) {
  return ecns.map(e => ({ ...e, changeTypeLabel: D.dicts.ecn_change_type[e.changeType], statusLabel: D.dicts.ecn_status[e.status] }));
}
function listWorkItems(ownerId) {
  let list = workItems;
  if (ownerId) list = list.filter(w => w.ownerId === Number(ownerId));
  return list.map(w => ({ ...w }));
}
function listProcessRoutes() { return routes; }

/* ---- 研发项目（22 节点 + 阶段门） ---- */
function getGates() { return D.gates; }
function getNodeDefs() { return D.nodeDefs; }

function nodeSummary(nodes) {
  const vals = Object.values(nodes || {});
  return {
    total: D.nodeDefs.length,
    done: vals.filter(v => v === 'DONE').length,
    inProgress: vals.filter(v => v === 'IN_PROGRESS').length,
    pending: vals.filter(v => v === 'PENDING' || v === 'NOT_SET').length
  };
}

function listProjects() {
  const SL0 = D.projectStatusLabel || {};
  return projects.map(p => ({ ...p, gateName: D.gates[p.gate] || p.gate, statusLabel: SL0[p.status] || p.status, summary: nodeSummaryArr(nodeArr(p.projectNo)) }));
}

function getProject(projectNo) {
  const p = projects.find(x => x.projectNo === projectNo);
  if (!p) throw Object.assign(new Error('project not found'), { status: 404 });
  const nodes = D.nodeDefs.map((n, i) => nodeRow(p, i));
  const SL = D.projectStatusLabel || {};
  return { ...p, gateName: D.gates[p.gate] || p.gate, statusLabel: SL[p.status] || p.status, nodes, summary: nodeSummaryArr(nodeArr(projectNo)) };
}


// 创建 ECN（草稿；链路：提交 → 一审 → 二审 → 生效）
function createEcn(input) {
  const { partNo, changeType, reason, applicant, versionBefore, versionAfter, cost } = input || {};
  const m = materials.find(x => x.partNo === partNo);
  if (!m) throw Object.assign(new Error('material not found'), { status: 404 });
  if (!changeType || !D.dicts.ecn_change_type[changeType]) throw Object.assign(new Error('invalid change_type'), { status: 422 });
  const e = {
    ecnNo: 'ECN' + Date.now() + String(Math.floor(Math.random() * 90) + 10),
    partNo, name: m.name, changeType,
    versionBefore: versionBefore || m.version, versionAfter: versionAfter || m.version,
    status: 'DRAFT', applicant: applicant || '—', reason: reason || '',
    cost: Number(cost || 0), flow: ['提交', '研发主管一审', '供应链总监二审', '生效']
  };
  ecns.unshift(e);
  return { ...e };
}

// 工序流转：仅当前 ACTIVE 工序的负责人可完成；完成后自动激活下一道并推送待办；末道完成自动闭环
function completeStep(routeNo, stepOrder, opts) {
  const r = routes.find(x => x.routeNo === routeNo);
  if (!r) throw Object.assign(new Error('route not found'), { status: 404 });
  const s = r.steps.find(x => x.order === Number(stepOrder));
  if (!s) throw Object.assign(new Error('step not found'), { status: 404 });
  if (s.status !== 'ACTIVE') throw Object.assign(new Error('仅进行中的工序可完成（当前 ' + s.status + '）'), { status: 409 });
  const operator = (opts || {}).operator;
  if (operator && s.owner && operator !== s.owner) throw Object.assign(new Error('非本道工序负责人（应为 ' + s.owner + '）'), { status: 403 });
  s.status = 'DONE'; s.remark = (opts || {}).remark || ''; s.completedAt = new Date().toISOString();
  const next = r.steps.find(x => x.order === s.order + 1);
  let nextOwner = null, routeCompleted = false;
  if (next) { next.status = 'ACTIVE'; next.startedAt = new Date().toISOString(); nextOwner = next.owner; }
  else { r.status = 'COMPLETED'; r.completedAt = new Date().toISOString(); routeCompleted = true; }
  return { routeNo, completed: { order: s.order, name: s.name, owner: s.owner }, nextOwner, routeCompleted, event: routeCompleted ? 'PROCESS_ROUTE_COMPLETED' : 'PROCESS_STEP_PUSHED' };
}
/* ---- 工作表填报与节点联动 ---- */
function getWorksheetDefs() { return D.worksheetDefs; }
function getNodeWorksheetMap() { return D.nodeWorksheetMap; }

function listWorksheets(projectNo, nodeCode) {
  let list = worksheets;
  if (projectNo) list = list.filter(w => w.projectNo === projectNo);
  if (nodeCode) list = list.filter(w => w.nodeCode === nodeCode);
  return list.map(w => ({ ...w }));
}

function submitWorksheet(input) {
  const { projectNo, nodeCode, data, operator } = input || {};
  const p = projects.find(x => x.projectNo === projectNo);
  if (!p) throw Object.assign(new Error('project not found'), { status: 404 });
  const wsCode = D.nodeWorksheetMap[nodeCode];
  if (!wsCode) throw Object.assign(new Error('该节点无在线工作表（走档案/专业模块）'), { status: 422 });
  const def = D.worksheetDefs.find(w => w.code === wsCode);
  if (!data || !Object.keys(data).length) throw Object.assign(new Error('工作表内容不能为空'), { status: 422 });

  const rec = {
    id: 'WS' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    projectNo, nodeCode, type: wsCode, typeName: def.name,
    data, operator: operator || '—',
    createdAt: new Date().toISOString()
  };
  worksheets.unshift(rec);

  // 完成判定联动：满足 doneWhen → 节点 DONE；否则 IN_PROGRESS
  const done = def.doneWhen && data[def.doneWhen.field] === def.doneWhen.value;
  const arr = nodeArr(projectNo);
  const di = D.nodeDefs.findIndex(d => d.code === nodeCode);
  arr[di] = done ? 'DONE' : 'IN_PROGRESS';
  return { record: { ...rec }, nodeStatus: arr[di], nodeDone: !!done };
}

/* ---- 数据采集与录入（微系统核心） ---- */
function getCaptureTypes(roleCode) {
  if (!roleCode) return D.captureTypes;
  const allowed = D.captureRolePermissions[roleCode];
  if (allowed === undefined) return [];
  return D.captureTypes.filter(t => allowed.includes(t.code));
}

function submitCapture(input) {
  const { partNo, captureType, values, operator, role, idempotency_key, evidence } = input || {};
  if (!idempotency_key) throw Object.assign(new Error('Idempotency-Key required'), { status: 400 });
  if (CAP_IDEM.has(idempotency_key)) return { ...CAP_IDEM.get(idempotency_key), replay: true };

  // 严格岗位权限：采集类型必须在该岗位允许范围内
  const allowed = D.captureRolePermissions[role];
  if (allowed === undefined) throw Object.assign(new Error('permission denied: 无采集权限'), { status: 403 });
  if (captureType && !allowed.includes(captureType)) throw Object.assign(new Error('permission denied: 该岗位无权执行此采集类型 ' + captureType), { status: 403 });

  // 扫码匹配料号（错配拒绝）
  const m = materials.find(x => x.partNo === partNo);
  if (!m) throw Object.assign(new Error('扫码匹配失败：料号不存在'), { status: 404 });

  const cap = {
    captureId: 'CAP' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    partNo: m.partNo,
    materialName: m.name,
    captureType: captureType || null,
    captureTypeName: (D.captureTypes.find(t => t.code === captureType) || {}).name || captureType,
    values: values || {},
    evidence: evidence || [],
    operator: operator || '—',
    status: 'pending-review',      // done != verified：采集提交后进入人机审核
    createdAt: new Date().toISOString(),
    idempotency_key
  };
  captures.unshift(cap);
  CAP_IDEM.set(idempotency_key, cap);
  return cap;
}

function listCaptures(operator) {
  let list = captures;
  if (operator) list = list.filter(c => c.operator === operator);
  return list.map(c => ({ ...c }));
}

// 物料生命周期流转（含角色鉴权）
function transitionMaterial(partNo, action, roleCode) {
  const m = materials.find(x => x.partNo === partNo);
  if (!m) throw Object.assign(new Error('material not found'), { status: 404 });
  const t = D.lifecycle.find(x => x.from === m.status && x.action === action);
  if (!t) throw Object.assign(new Error(`invalid transition ${m.status} -> (${action})`), { status: 409 });
  if (!t.roles.includes(roleCode)) throw Object.assign(new Error('permission denied for ' + action), { status: 403 });
  const prev = m.status;
  m.status = t.to;
  if (t.to === 'IN_PRODUCTION') m.phase = 'MASS_PRODUCTION';
  return { partNo, from: prev, to: t.to, action, operatorRole: roleCode };
}

// ECN 三级审批状态机
function ecnTransition(ecnNo, action, roleCode) {
  const e = ecns.find(x => x.ecnNo === ecnNo);
  if (!e) throw Object.assign(new Error('ecn not found'), { status: 404 });
  const st = e.status;
  let ok = false;
  if (action === 'submit' && st === 'DRAFT') ok = true;
  if (action === 'review1' && st === 'PENDING_L1' && hasPerm(roleCode, 'ecn:review1')) ok = true;
  if (action === 'review2' && st === 'PENDING_L2' && hasPerm(roleCode, 'ecn:review2')) ok = true;
  if (action === 'effect' && st === 'APPROVED' && hasPerm(roleCode, 'ecn:effect')) ok = true;
  if (action === 'reject' && (st === 'PENDING_L1' || st === 'PENDING_L2')) ok = true;
  if (action === 'void' && ['DRAFT', 'REJECTED', 'PENDING_L1'].includes(st) && hasPerm(roleCode, 'ecn:add')) ok = true;
  if (!ok) throw Object.assign(new Error('invalid ecn transition or no permission'), { status: 409 });

  const map = {
    submit: 'PENDING_L1', review1: 'PENDING_L2', review2: 'APPROVED',
    effect: 'EFFECTIVE', reject: 'REJECTED', void: 'VOID'
  };
  const prev = e.status;
  e.status = map[action];
  if (action === 'effect') {
    // 生效后自动升级物料版本
    const m = materials.find(x => x.partNo === e.partNo);
    if (m && e.versionAfter) m.version = e.versionAfter;
  }
  return { ecnNo, from: prev, to: e.status, action };
}

// 待办完成（done != verified：完成者不可自行验证，仅演示）
function completeWorkItem(itemNo, roleCode) {
  const w = workItems.find(x => x.itemNo === itemNo);
  if (!w) throw Object.assign(new Error('work item not found'), { status: 404 });
  w.status = 'DONE';
  w.completedAt = new Date().toISOString();
  return { ...w };
}

// 我的概览（对齐 /v1/me/overview 语义）
// 我的概览 —— 字段对齐真实 PLM2 /v1/me/overview（MeOverviewController）
function overview(userId) {
  const u = person(userId) || D.people[0];
  const mine = workItems.filter(w => w.ownerId === u.id);
  const myProjects = projects.filter(p => p.owner === u.name);
  const today = (D.dataOrigin && D.dataOrigin.personalToday) || new Date().toISOString().slice(0, 10);
  const PS = D.personalStats || { evidence: {}, feedback: {} };
  const myNodes = Object.keys(nodeOwnersRT).filter(k => nodeOwnersRT[k] === u.name).map(k => { const [pn, code] = k.split('|'); const di = D.nodeDefs.findIndex(d => d.code === code); const arr = nodeArr(pn); return { projectNo: pn, nodeCode: code, status: arr[di] || 'NOT_SET', planDate: (nodePlansRT[pn] || {})[code] || null }; });
  const tm = todosFor(u.name);
  const overdueList = myNodes.filter(n => n.status !== 'DONE' && n.planDate && n.planDate < today)
    .map(n => ({ projectNo: n.projectNo, nodeCode: n.nodeCode, planDate: n.planDate, status: n.status }));
  return {
    user: u,
    role: role(u.role),
    projects: {
      total: myProjects.length,
      active: myProjects.filter(p => p.status === 'ACTIVE').length,
      closed: myProjects.filter(p => ['CLOSED', 'CANCELLED', 'MP'].includes(p.status)).length,
      recent: myProjects.slice(0, 5).map(p => ({ projectNo: p.projectNo, name: p.name, status: p.status, gate: p.gate }))
    },
    todos: {
      open: mine.filter(w => w.status === 'OPEN').length,
      escalated: mine.filter(w => w.status === 'ESCALATED').length,
      done: mine.filter(w => w.status === 'DONE').length,
      list: mine
    },
    nodes: { owned: myNodes.length, overdue: overdueList.length, done: myNodes.filter(n => n.status === 'DONE').length, overdueList },
    todosModule: { overdueCount: tm.overdueCount, todoCount: tm.todoCount, doneCount: tm.doneCount },
    evidence: PS.evidence[u.name] || 0,
    planSheets: 0,
    feedback: PS.feedback[u.name] || 0,
    materials: { total: materials.filter(m => m.owner === u.name).length },
    ecns: { total: ecns.filter(e => e.applicant === u.name).length },
    note: '对齐 PLM2 /v1/me/overview：planSheets/todayChanges 真实库为空或未导入，暂不提供。'
  };
}

// 项目编辑（名称/负责人/门/客户/风险）
function updateProject(projectNo, input, actorRole) {
  const p = projects.find(x => x.projectNo === projectNo);
  if (!p) throw Object.assign(new Error('project not found'), { status: 404 });
  if (!['ADMIN', 'RD_LEAD'].includes(actorRole)) throw Object.assign(new Error('permission denied：仅 ADMIN/研发主管可编辑项目'), { status: 403 });
  const { name, owner, gate, customer, risk } = input || {};
  if (name !== undefined && name !== '') p.name = name;
  if (owner !== undefined) p.owner = owner;
  if (gate !== undefined && D.gates[gate]) p.gate = gate;
  if (customer !== undefined) p.customer = customer;
  if (risk !== undefined && ['green', 'yellow', 'red'].includes(risk)) p.risk = risk;
  const plmPayload = {};
  if (name !== undefined && name !== '') plmPayload.projectName = name;
  if (owner !== undefined) plmPayload.owner = owner;
  if (gate !== undefined && D.gates[gate]) plmPayload.currentGate = gate;
  if (customer !== undefined) plmPayload.customerName = customer;
  if (risk !== undefined && ['green', 'yellow', 'red'].includes(risk)) plmPayload.riskLevel = risk;
  if (Object.keys(plmPayload).length) queueProjectWrite(p, plmPayload);
  const SL = D.projectStatusLabel || {};
  return { ...p, gateName: D.gates[p.gate] || p.gate, statusLabel: SL[p.status] || p.status, plmQueued: !!p.plmId };
}

// 物料编辑（名称/类型/版本/系列/阶段）
function updateMaterial(partNo, input, actorRole) {
  if (!['ADMIN', 'RD_LEAD', 'ENGINEER'].includes(actorRole)) throw Object.assign(new Error('permission denied'), { status: 403 });
  const m = materials.find(x => x.partNo === partNo);
  if (!m) throw Object.assign(new Error('material not found'), { status: 404 });
  const { name, type, version, series, phase } = input || {};
  if (name !== undefined && name !== '') m.name = name;
  if (type !== undefined && D.dicts.material_type[type]) m.type = type;
  if (version !== undefined && version !== '') m.version = version;
  if (series !== undefined) m.series = series;
  if (phase !== undefined && D.dicts.phase[phase]) m.phase = phase;
  return { ...m, typeLabel: D.dicts.material_type[m.type], statusLabel: D.dicts.material_status[m.status], phaseLabel: D.dicts.phase[m.phase] };
}

// 项目停用/启用/取消（真实 plm_project.status：ACTIVE/ON_HOLD/CANCELLED/CLOSED/MP）
function updateProjectStatus(projectNo, status, actorRole) {
  const p = projects.find(x => x.projectNo === projectNo);
  if (!p) throw Object.assign(new Error('project not found'), { status: 404 });
  if (!['ADMIN', 'RD_LEAD'].includes(actorRole)) throw Object.assign(new Error('permission denied：仅 ADMIN/研发主管可停用或启用项目'), { status: 403 });
  const allow = { ON_HOLD: ['ACTIVE'], ACTIVE: ['ON_HOLD'], CANCELLED: ['ACTIVE', 'ON_HOLD'], CLOSED: ['ACTIVE', 'ON_HOLD'] };
  if (!(allow[status] || []).includes(p.status)) throw Object.assign(new Error(`不允许 ${p.status} → ${status}`), { status: 409 });
  p.status = status;
  return { projectNo, status, statusLabel: (D.projectStatusLabel || {})[status] || status };
}

// ============ PLM 我的待办模块（复刻 OrgTodoService /v1/me/todos 口径） ============
// 口径：节点直接指派给我 ∪ 我负责项目下的全部节点；按计划日切 逾期/待办/已完成。
function todosFor(realName) {
  const today = _today();
  const rows = [];
  const ownedSet = {};
  projects.filter(p => p.owner === realName).forEach(p => {
    ownedSet[p.projectNo] = true;
    const arr = nodeArr(p.projectNo);
    D.nodeDefs.forEach((d, i) => rows.push({
      projectNo: p.projectNo, projectName: p.name, projectStatus: p.status,
      nodeCode: d.code, nodeName: d.name, status: arr[i] || 'NOT_SET',
      planDate: (nodePlansRT[p.projectNo] || {})[d.code] || null,
      actualDate: (nodeActualRT[p.projectNo] || {})[d.code] || null,
      assigned: false
    }));
  });
  Object.keys(nodeOwnersRT).forEach(k => {
    if (nodeOwnersRT[k] !== realName) return;
    const [pn, code] = k.split('|');
    if (ownedSet[pn]) return;
    const pj = projects.find(x => x.projectNo === pn) || {};
    const di = D.nodeDefs.findIndex(d => d.code === code);
    if (di < 0) return;
    const arr = nodeArr(pn);
    rows.push({ projectNo: pn, projectName: pj.name || '', projectStatus: pj.status || '', nodeCode: code, nodeName: D.nodeDefs[di].name, status: arr[di] || 'NOT_SET', planDate: (nodePlansRT[pn] || {})[code] || null, actualDate: (nodeActualRT[pn] || {})[code] || null, assigned: true });
  });
  const cmpDateAsc = (a, b) => String(a.planDate || '9999').localeCompare(String(b.planDate || '9999'));
  const active = r => r.status !== 'DONE' && r.status !== 'NONE';
  const overdue = rows.filter(r => active(r) && r.planDate && r.planDate < today).sort(cmpDateAsc);
  const todo = rows.filter(r => active(r) && (!r.planDate || r.planDate >= today)).sort(cmpDateAsc);
  const done = rows.filter(r => r.status === 'DONE')
    .sort((a, b) => String(b.actualDate || '').localeCompare(String(a.actualDate || ''))).slice(0, 200);
  const none = rows.filter(r => r.status === 'NONE');
  const total = overdue.length + todo.length + done.length;
  return { overdue, todo, done, none, overdueCount: overdue.length, todoCount: todo.length, doneCount: done.length, noneCount: none.length, total };
}

// 部门待办（复刻 /v1/me/dept-todos 组织聚合）：经理类看本部门，ADMIN/gm 看全部
const _LEADER_DEPTS = { rd_manager: ['RD'], project_manager: ['RD'], sales_director: ['SALES'], sales_manager: ['SALES'], cw1: ['FIN'], hr_manager: ['ADM'] };
const _ALL_ROLES = ['ADMIN', 'admin', 'gm'];
function deptTodos(userId) {
  const u = person(userId) || D.people[0];
  const roles = u.realRoles || [];
  const all = roles.some(r => _ALL_ROLES.includes(r));
  const scopeDeptCodes = [...new Set(roles.flatMap(r => _LEADER_DEPTS[r] || []))];
  const self = todosFor(u.name);
  const out = {
    scope: all ? 'ALL' : (scopeDeptCodes.length ? 'DEPT' : 'SELF'),
    scopeDepts: all ? null : scopeDeptCodes,
    self: { realName: u.name, userId: u.id, overdueCount: self.overdueCount, todoCount: self.todoCount, doneCount: self.doneCount }
  };
  const departments = [];
  if (all || scopeDeptCodes.length > 0) {
    D.departments.filter(d => all || scopeDeptCodes.includes(d.code)).forEach(d => {
      const members = [];
      let ov = 0, td = 0, dn = 0;
      const seen = new Set();
      D.people.filter(mp => mp.dept === d.code && !seen.has(mp.name)).forEach(mp => {
        seen.add(mp.name);
        const tf = todosFor(mp.name);
        ov += tf.overdueCount; td += tf.todoCount; dn += tf.doneCount;
        members.push({ userId: mp.id, realName: mp.name, deptName: d.name, overdueCount: tf.overdueCount, todoCount: tf.todoCount, doneCount: tf.doneCount });
      });
      departments.push({ deptCode: d.code, deptName: d.name, overdueCount: ov, todoCount: td, doneCount: dn, members });
    });
  }
  out.departments = departments;
  return out;
}

// ============ 项目明细表（复刻 progress.vue：状态/责任人/计划日/实际日/交付物） ============
const NODE_STATUS_LABEL = { NONE: '无节点', NOT_SET: '未设置', PLANNED: '已计划', IN_PROGRESS: '进行中', DONE: '已完成', FAILED: '未完成', PENDING: '待定' };
const DEFAULT_DELIVERY = {
  PLAN: '计划表（甘特）', BOM: '基础BOM', SPEC: '规格书', CONFIG: '配置表',
  MOLD_DRAWING: '模具图纸（档案）', MOLD_REVIEW: '评审单（开模评审）', HAND_SAMPLE: '评审单（样机评审）/样品单',
  APPEARANCE: '评审单（外观评审）', STRUCTURE: '评审单（结构评审）', ELECTRONICS: '评审单（电子评审）',
  MOLD: '模具验收（模具模块）', MOLD_SAMPLE: '评审单（样品评审）/样品单', PACKAGING: '包装图纸（档案）',
  ELEC_TRIAL: '试产报告（电子试产）', RD_TRIAL: '试产报告（研发试产）', ENG_TRIAL: '试产报告（工程试产）',
  PROD_TRIAL: '试产报告（生产试产）', TEST_REPORT: '送检单/测试报告', TECH_TRANSFER: '评审单（技转评审）/技转报告',
  SHIPMENT: '出货/验货报告', REVIEW: '复盘报告', OTHER: '—'
};
let nodeStatusRT = {}, nodePlansRT = {}, nodeActualRT = {}, nodeOwnersRT = {}, nodeDeliveryRT = {}, nodeRemarkRT = {};
function initNodeRuntime() {
  nodeStatusRT = JSON.parse(JSON.stringify(D.nodeStatusAll || {}));
  nodePlansRT = JSON.parse(JSON.stringify(D.nodePlans || {}));
  nodeActualRT = JSON.parse(JSON.stringify(D.nodeActual || {}));
  nodeOwnersRT = {}; (D.nodeOwners || []).forEach(o => { nodeOwnersRT[o.projectNo + '|' + o.nodeCode] = o.owner; });
  nodeDeliveryRT = {}; nodeRemarkRT = {};
}
initNodeRuntime();
const _today = () => (D.dataOrigin && D.dataOrigin.personalToday) || new Date().toISOString().slice(0, 10);
function nodeArr(projectNo) {
  if (!nodeStatusRT[projectNo]) nodeStatusRT[projectNo] = D.nodeDefs.map(() => 'NOT_SET');
  return nodeStatusRT[projectNo];
}
function nodeSummaryArr(arr) {
  const vals = (arr || []).filter(v => v !== 'NONE');
  return {
    total: vals.length,
    done: vals.filter(v => v === 'DONE').length,
    inProgress: vals.filter(v => v === 'IN_PROGRESS' || v === 'PLANNED').length,
    pending: vals.filter(v => v === 'PENDING' || v === 'FAILED' || v === 'NOT_SET' || !v).length,
    noneCount: (arr || []).filter(v => v === 'NONE').length
  };
}
function setMap(map, projectNo, code, val) { (map[projectNo] = map[projectNo] || {}); if (val === null || val === undefined || val === '') delete map[projectNo][code]; else map[projectNo][code] = val; }
function nodeRow(p, i) {
  const code = D.nodeDefs[i].code;
  const key = p.projectNo + '|' + code;
  return {
    seq: D.nodeDefs[i].seq, code, name: D.nodeDefs[i].name, key: D.nodeDefs[i].key, worksheet: D.nodeDefs[i].worksheet,
    status: nodeArr(p.projectNo)[i], statusLabel: NODE_STATUS_LABEL[nodeArr(p.projectNo)[i]] || nodeArr(p.projectNo)[i],
    planDate: (nodePlansRT[p.projectNo] || {})[code] || null,
    actualDate: (nodeActualRT[p.projectNo] || {})[code] || null,
    owner: nodeOwnersRT[key] || p.owner, ownerDefault: p.owner, ownerAssigned: !!nodeOwnersRT[key],
    deliveryDesc: (nodeDeliveryRT[p.projectNo] || {})[code] || DEFAULT_DELIVERY[code],
    remark: (nodeRemarkRT[p.projectNo] || {})[code] || '',
    worksheetCount: worksheets.filter(w => w.projectNo === p.projectNo && w.nodeCode === code).length,
    ws: nodeWsStatus(p.projectNo, code)
  };
}
// 节点保存：待办类状态必须填计划日期；实际日期缺省当天；DONE 自动补实际日期
function updateNode(projectNo, nodeCode, input) {
  const p = projects.find(x => x.projectNo === projectNo);
  if (!p) throw Object.assign(new Error('project not found'), { status: 404 });
  const idx = D.nodeDefs.findIndex(d => d.code === nodeCode);
  if (idx < 0) throw Object.assign(new Error('unknown node'), { status: 422 });
  const { status, owner, planDate, actualDate, deliveryDesc, remark } = input || {};
  const VALID = ['NONE', 'NOT_SET', 'PLANNED', 'IN_PROGRESS', 'DONE', 'FAILED', 'PENDING'];
  if (status !== undefined && !VALID.includes(status)) throw Object.assign(new Error('invalid status'), { status: 422 });
  const arr = nodeArr(projectNo);
  const st = status === undefined ? arr[idx] : status;
  const pl = planDate !== undefined ? planDate : ((nodePlansRT[projectNo] || {})[nodeCode] || null);
  if (['PLANNED', 'IN_PROGRESS', 'PENDING', 'FAILED'].includes(st) && !pl) {
    throw Object.assign(new Error('该状态为待办，计划日期必填'), { status: 422 });
  }
  let ac = actualDate !== undefined ? actualDate : ((nodeActualRT[projectNo] || {})[nodeCode] || null);
  if (st === 'DONE' && !ac) ac = _today();
  arr[idx] = st;
  setMap(nodePlansRT, projectNo, nodeCode, pl);
  setMap(nodeActualRT, projectNo, nodeCode, ac);
  if (owner !== undefined) { if (owner) nodeOwnersRT[projectNo + '|' + nodeCode] = owner; else delete nodeOwnersRT[projectNo + '|' + nodeCode]; }
  if (deliveryDesc !== undefined) setMap(nodeDeliveryRT, projectNo, nodeCode, deliveryDesc);
  if (remark !== undefined) setMap(nodeRemarkRT, projectNo, nodeCode, remark);
  // 写透 M04：仅回传显式改动字段 + 终态状态/日期
  const plmPayload = { status: st, planDate: pl, actualDate: ac };
  if (owner !== undefined) plmPayload.owner = owner || '';
  if (deliveryDesc !== undefined) plmPayload.deliveryDesc = deliveryDesc || '';
  if (remark !== undefined) plmPayload.remark = remark || '';
  queueNodeWrite(p, nodeCode, plmPayload);
  return { projectNo, node: nodeRow(p, idx), plmQueued: !!p.plmId };
}

// ============ M10 ↔ M04 PLM 实时同步（写透/读透，经 PLM REST） ============
const sync = require('./sync');
const nodePullAt = {};        // projectNo -> 上次拉取时间戳
const pendingWrites = [];     // 待写回队列 {kind, plmId, code?, payload}
const lastSync = { writeAt: null, pullAt: null, ok: null, msg: '' };

function queueNodeWrite(p, code, payload) { if (p.plmId) pendingWrites.push({ kind: 'node', plmId: p.plmId, code, payload }); }
function queueProjectWrite(p, payload) { if (p.plmId) pendingWrites.push({ kind: 'project', plmId: p.plmId, payload }); }
async function flushSync() {
  const results = [];
  while (pendingWrites.length) {
    const w = pendingWrites.shift();
    const r = w.kind === 'node' ? await sync.putNode(w.plmId, w.code, w.payload)
      : w.kind === 'sheet' ? await sync.createSheet(w.type, w.payload)
      : await sync.putProject(w.plmId, w.payload);
    results.push(Object.assign({ kind: w.kind }, r));
    lastSync.writeAt = new Date().toISOString(); lastSync.ok = r.ok; lastSync.msg = r.msg;
  }
  return results;
}
async function pullProject(p) {
  const m = await sync.getNodeMatrix(p.plmId);
  const byCode = {}; (m.nodes || []).forEach(n => byCode[n.nodeCode] = n);
  const arr = nodeArr(p.projectNo);
  D.nodeDefs.forEach((d, i) => {
    const n = byCode[d.code]; if (!n) return;
    arr[i] = n.status || arr[i];
    setMap(nodePlansRT, p.projectNo, d.code, n.planDate || null);
    setMap(nodeActualRT, p.projectNo, d.code, n.actualDate || null);
    if (n.owner) nodeOwnersRT[p.projectNo + '|' + d.code] = n.owner;
    else delete nodeOwnersRT[p.projectNo + '|' + d.code];
    if (n.deliveryDesc !== null && n.deliveryDesc !== undefined) setMap(nodeDeliveryRT, p.projectNo, d.code, n.deliveryDesc);
    if (n.remark !== null && n.remark !== undefined) setMap(nodeRemarkRT, p.projectNo, d.code, n.remark);
  });
  nodePullAt[p.projectNo] = Date.now();
  lastSync.pullAt = new Date().toISOString(); lastSync.ok = true; lastSync.msg = '';
}
// 读透：getProjectAsync（TTL 5s 或 fresh 强制）
async function getProjectAsync(projectNo, opts) {
  const p = projects.find(x => x.projectNo === projectNo);
  if (!p) throw Object.assign(new Error('project not found'), { status: 404 });
  if (p.plmId && ((opts && opts.fresh) || !nodePullAt[projectNo] || Date.now() - nodePullAt[projectNo] > 5000)) {
    try { await pullProject(p); } catch (e) { lastSync.ok = false; lastSync.msg = '拉取失败: ' + e.message; }
  }
  return getProject(projectNo);
}
// 批量拉取（personName 为空=全部带 plmId 的项目）
async function syncPull(personName) {
  const list = projects.filter(x => x.plmId && (!personName || x.owner === personName));
  let ok = 0, fail = 0;
  for (const p of list) { try { await pullProject(p); ok++; } catch (e) { fail++; } }
  return { pulled: ok, failed: fail, total: list.length, at: new Date().toISOString() };
}
function syncStatus() {
  return {
    enabled: true, api: sync.API_BASE,
    projectsWithPlmId: projects.filter(x => x.plmId).length,
    lastWriteAt: lastSync.writeAt, lastPullAt: lastSync.pullAt,
    lastOk: lastSync.ok, lastMsg: lastSync.msg, pending: pendingWrites.length
  };
}

// ============ 资料制作生命周期：草稿→提交→上级审批→批准归档→同步 PLM 对应表 ============
const WS_STATUS_LABEL = { DRAFT: '草稿', SUBMITTED: '待审批', APPROVED: '已批准', REJECTED: '已驳回', ARCHIVED: '已归档' };
let wsV2 = []; // {id, projectNo, nodeCode, type, fields, rows, status, createdBy, createdAt, submittedAt, approvedBy, approvedAt, rejectReason, archiveRef, plmQueued}

function getWsTemplates() { return D.wsTemplates || {}; }
function wsFind(id) { return wsV2.find(x => x.id === id); }

// 制作（带入项目/节点信息）：action = draft | submit
function makeWorksheet(input) {
  const { projectNo, nodeCode, fields, rows, actor, action } = input || {};
  const p = projects.find(x => x.projectNo === projectNo);
  if (!p) throw Object.assign(new Error('project not found'), { status: 404 });
  const mapped = D.nodeWorksheetMap[nodeCode];
  const ATTACH_TPL = { name: '工具成果/资料附档', fields: [
      { k: 'note', label: '成果说明（软件制作/导入解析结果）' },
      { k: 'files', label: '附件清单（文件名，逗号分隔）' },
      { k: 'done', label: '节点完成', type: 'enum', options: ['否', '是'] }
    ], doneWhen: { field: 'done', value: '是' } };
  const type = mapped || 'attach';
  const tpl = mapped ? (D.wsTemplates || {})[mapped] : ATTACH_TPL;
  if (!tpl) throw Object.assign(new Error('该节点无在线资料模板'), { status: 422 });
  let rec = wsV2.find(x => x.projectNo === projectNo && x.nodeCode === nodeCode && ['DRAFT', 'REJECTED'].includes(x.status));
  const data = { fields: fields || {}, rows: rows || [] };
  if (!rec) {
    rec = { id: 'WSV2-' + crypto.randomBytes(4).toString('hex').toUpperCase(), projectNo, nodeCode, type,
      fields: data.fields, rows: data.rows, status: 'DRAFT', createdBy: actor || '—', createdAt: new Date().toISOString() };
    wsV2.unshift(rec);
  } else { rec.fields = data.fields; rec.rows = data.rows; }
  if (action === 'submit') {
    rec.status = 'SUBMITTED'; rec.submittedAt = new Date().toISOString();
    pushApprovalTodos(rec, tpl, p);   // 推送待审批待办给研发主管（在「我的待办」收到）
  }
  return { ...rec, statusLabel: WS_STATUS_LABEL[rec.status], template: tpl.name, projectName: p.name };
}

// 提交 → 给所有研发主管（RD_LEAD）推送「资料待审批」待办（幂等：同一资料仅推一次）
const wsApprovalTodos = []; // {itemNo, type, subject, status, ownerId, owner, wsV2Id, createdAt}
function pushApprovalTodos(rec, tpl, p) {
  if (wsApprovalTodos.some(t => t.wsV2Id === rec.id && t.status === 'OPEN')) return;
  D.people.filter(x => x.role === 'RD_LEAD').forEach(lead => {
    wsApprovalTodos.unshift({
      itemNo: 'WIA' + crypto.randomBytes(4).toString('hex').toUpperCase(),
      type: 'WS_APPROVAL', subject: `资料待审批：${tpl.name}（${rec.projectNo}）· 提交人 ${rec.createdBy}`,
      status: 'OPEN', ownerId: lead.id, owner: lead.name,
      wsV2Id: rec.id, projectName: p.name, createdAt: new Date().toISOString()
    });
  });
}
// 审批完成/驳回 → 关闭该资料的待办
function closeApprovalTodos(wsId) {
  wsApprovalTodos.forEach(t => { if (t.wsV2Id === wsId) t.status = 'DONE'; });
}
// 我的待办（含资料审批待办）
function listApprovalTodos(ownerId) {
  return wsApprovalTodos.filter(t => !ownerId || t.ownerId === Number(ownerId)).map(t => ({ ...t }));
}

// 上级审批：批准 → 自动归档 + 节点联动 + 推送 PLM 对应表
function approveWorksheet(id, opts) {
  const { approver, role } = opts || {};
  if (!['RD_LEAD', 'ADMIN'].includes(role)) throw Object.assign(new Error('permission denied：仅研发主管/管理员可审批资料'), { status: 403 });
  const rec = wsFind(id);
  if (!rec) throw Object.assign(new Error('worksheet not found'), { status: 404 });
  if (rec.status !== 'SUBMITTED') throw Object.assign(new Error('仅待审批资料可批准（当前 ' + WS_STATUS_LABEL[rec.status] + '）'), { status: 409 });
  if (rec.createdBy === approver) throw Object.assign(new Error('制作人与审批人不能为同一人（职责分离）'), { status: 403 });
  rec.status = 'APPROVED'; rec.approvedBy = approver; rec.approvedAt = new Date().toISOString();
  rec.archiveRef = 'WSA-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  closeApprovalTodos(id);
  // 归档 → 同步 PLM 对应业务表（携带项目/节点信息）
  const p = projects.find(x => x.projectNo === rec.projectNo);
  const payload = Object.assign({ project_no: rec.projectNo, node_code: rec.nodeCode, created_by: rec.createdBy, _archiveRef: rec.archiveRef }, rec.fields);
  if (rec.rows && rec.rows.length) payload._items = rec.rows;
  const pushable = !!D.nodeWorksheetMap[rec.nodeCode];
  if (p && p.plmId && pushable) pendingWrites.push({ kind: 'sheet', type: rec.type, plmId: p.plmId, payload });
  rec.plmQueued = !!(p && p.plmId && pushable);
  // 节点完成判定联动（复用 updateNode 的写透逻辑）
  const tpl = (D.wsTemplates || {})[rec.type] || { fields: [], doneWhen: { field: 'done', value: '是' } };
  const merged = Object.assign({}, rec.fields);
  if (tpl.rows && rec.rows.length) tpl.rows.columns.forEach(c => { merged[c.k] = rec.rows.map(r => r[c.k]).join(','); });
  const done = tpl.doneWhen && merged[tpl.doneWhen.field] === tpl.doneWhen.value;
  try {
    const r = updateNode(rec.projectNo, rec.nodeCode, { status: done ? 'DONE' : 'IN_PROGRESS', deliveryDesc: (rec.type === 'attach' ? '工具成果' : tpl.name) + '（' + rec.archiveRef + '）', remark: '资料归档：' + rec.archiveRef, actor: approver });
    rec.nodeStatus = r.node.status;
  } catch (e) { rec.nodeStatus = '联动失败: ' + e.message; }
  rec.status = 'ARCHIVED';
  return { ...rec, statusLabel: WS_STATUS_LABEL[rec.status], nodeDone: !!done };
}

// 驳回 → 退回草稿（可改后重提）
function rejectWorksheet(id, opts) {
  const { approver, role, reason } = opts || {};
  if (!['RD_LEAD', 'ADMIN'].includes(role)) throw Object.assign(new Error('permission denied'), { status: 403 });
  const rec = wsFind(id);
  if (!rec) throw Object.assign(new Error('worksheet not found'), { status: 404 });
  if (rec.status !== 'SUBMITTED') throw Object.assign(new Error('仅待审批资料可驳回'), { status: 409 });
  rec.status = 'REJECTED'; rec.rejectReason = reason || ''; rec.approvedBy = approver;
  closeApprovalTodos(id);
  return { ...rec, statusLabel: WS_STATUS_LABEL[rec.status] };
}

function listWorksheetsV2(filter) {
  let list = wsV2;
  if (filter) {
    if (filter.projectNo) list = list.filter(x => x.projectNo === filter.projectNo);
    if (filter.nodeCode) list = list.filter(x => x.nodeCode === filter.nodeCode);
    if (filter.status) list = list.filter(x => x.status === filter.status);
  }
  return list.map(x => ({ ...x, statusLabel: WS_STATUS_LABEL[x.status] }));
}
// 待我审批（研发主管/管理员视角）
function listWorksheetApprovals() { return listWorksheetsV2({ status: 'SUBMITTED' }); }
// 节点最新资料状态（明细表行显示）
function nodeWsStatus(projectNo, nodeCode) {
  const rec = wsV2.find(x => x.projectNo === projectNo && x.nodeCode === nodeCode);
  return rec ? { status: rec.status, statusLabel: WS_STATUS_LABEL[rec.status], archiveRef: rec.archiveRef || '' } : null;
}

// 历史模板：该项目该节点的历史记录（优先 PLM 真实表，回退本地归档），用于模板带入
async function getWorksheetHistory(input) {
  const { projectNo, nodeCode } = input || {};
  const p = projects.find(x => x.projectNo === projectNo);
  if (!p) throw Object.assign(new Error('project not found'), { status: 404 });
  const type = D.nodeWorksheetMap[nodeCode] || 'attach';
  let records = [], source = 'local';
  if (p.plmId && type !== 'attach') {
    try {
      const data = await sync.listSheets(type, projectNo);
      const arr = data && (data.list || data.records || data.rows) || (Array.isArray(data) ? data : []);
      records = arr.map(r => Object.assign({}, r, { _src: 'plm' }));
      if (records.length) source = 'plm';
    } catch (e) { /* PLM 不可用时回退本地 */ }
  }
  if (!records.length) {
    records = wsV2.filter(x => x.projectNo === projectNo && x.nodeCode === nodeCode && x.status === 'ARCHIVED')
      .map(x => Object.assign({}, x.fields, { _items: x.rows, _archiveRef: x.archiveRef, _archivedAt: (x.approvedAt || '').slice(0, 10), _src: 'local' }));
  }
  return { type, projectNo, nodeCode, source, count: records.length, records: records.slice(0, 10) };
}

// ============ 立项五阶段审批（复刻 plm_project_initiation） ============
// draft → submitted → dept_review → rd_review + finance_review → gm_approve → execute
const INIT_TRANSITIONS = {
  draft: ['submitted', ''],
  submitted: ['dept_review', ''],
  dept_review: ['rd_review', ''],
  rd_review: ['finance_review', ''],
  finance_review: ['gm_approve', ''],
  gm_approve: ['execute', ''],
  execute: [],
  rejected: []
};
const INIT_LABEL = { draft:'草稿', submitted:'已提交', dept_review:'部门审核', rd_review:'研发审核', finance_review:'财务审核', gm_approve:'总经理批准', execute:'执行中', rejected:'已驳回' };
const INIT_ROLE_GATE = { submitted: null, dept_review: 'RD_LEAD', rd_review: 'RD_LEAD', finance_review: 'FINANCE', gm_approve: 'GM', execute: 'ADMIN' };
let initiations = [];

function createInitiation(input) {
  const { projectName, applicant, dept, description, budgetTotal, idempotency_key } = input || {};
  if (!projectName || !applicant) throw Object.assign(new Error('projectName and applicant required'), { status: 422 });
  const rec = {
    initNo: 'LX' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    projectName, applicant, dept: dept || 'RD', description: description || '', budgetTotal: Number(budgetTotal || 0),
    status: 'draft', workflow_stage: 'draft',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    history: [{ stage: 'draft', at: new Date().toISOString(), actor: applicant, note: '创建草稿' }]
  };
  initiations.unshift(rec);
  return { ...rec, statusLabel: INIT_LABEL[rec.status] };
}

function listInitiations(filter) {
  let list = initiations;
  if (filter && filter.status) list = list.filter(x => x.status === filter.status);
  return list.map(x => ({ ...x, statusLabel: INIT_LABEL[x.status] }));
}

function transitionInitiation(initNo, action, opts) {
  const rec = initiations.find(x => x.initNo === initNo);
  if (!rec) throw Object.assign(new Error('initiation not found'), { status: 404 });
  const { actor, role, note } = opts || {};
  const from = rec.workflow_stage;
  if (action === 'reject') {
    if (!INIT_ROLE_GATE[from]) throw Object.assign(new Error('当前阶段不可驳回'), { status: 409 });
    if (role !== INIT_ROLE_GATE[from] && role !== 'ADMIN') throw Object.assign(new Error('permission denied: ' + INIT_ROLE_GATE[from] + ' required'), { status: 403 });
    rec.workflow_stage = 'rejected'; rec.status = 'rejected';
    rec.history.push({ stage: 'rejected', at: new Date().toISOString(), actor, note: note || '' });
    return { ...rec, statusLabel: INIT_LABEL[rec.status] };
  }
  if (action === 'submit') {
    if (from !== 'draft') throw Object.assign(new Error('仅草稿可提交'), { status: 409 });
    rec.workflow_stage = 'submitted'; rec.status = 'submitted';
  } else {
    const pair = INIT_TRANSITIONS[from];
    if (!pair || pair[0] !== action) throw Object.assign(new Error('invalid transition ' + from + ' -> ' + action), { status: 409 });
    const gate = INIT_ROLE_GATE[action];
    if (gate && role !== gate && role !== 'ADMIN') throw Object.assign(new Error('permission denied: ' + gate + ' required'), { status: 403 });
    rec.workflow_stage = action; rec.status = action;
    if (action === 'execute') {
      // 批准后自动创建研发项目
      const pjNo = 'HJ.AUTO.' + Date.now().toString(36).toUpperCase();
      const pj = { plmId: null, projectNo: pjNo, name: rec.projectName, partNo: null, customer: '', owner: rec.applicant, dept: rec.dept, gate: 'G0', status: 'ACTIVE', risk: 'green', nodes: {} };
      projects.push(pj);
      rec.generatedProjectNo = pjNo;
    }
  }
  rec.updatedAt = new Date().toISOString();
  rec.history.push({ stage: rec.workflow_stage, at: new Date().toISOString(), actor, note: note || '' });
  return { ...rec, statusLabel: INIT_LABEL[rec.status] };
}

function reset() {
  materials = D.materials.map(m => ({ ...m }));
  ecns = D.ecns.map(e => ({ ...e }));
  workItems = D.workItems.map(w => ({ ...w }));
  routes = D.processRoutes.map(r => ({ ...r, steps: r.steps.map(s => ({ ...s })) }));
  projects = D.projects.map(p => ({ ...p, nodes: { ...p.nodes } }));
  worksheets = [];
  initNodeRuntime();
  Object.keys(nodePullAt).forEach(k => delete nodePullAt[k]);
  pendingWrites.length = 0;
  wsV2 = [];
  initiations = [];
}

module.exports = {
  getRoles, getDepartments, getModules, getDicts, getLifecycle, getManifest,
  getPeople, peopleByRole,
  listMaterials, listEcns, listWorkItems, listProcessRoutes,
  getGates, getNodeDefs, listProjects, getProject, createEcn, completeStep,
  getWorksheetDefs, getNodeWorksheetMap, listWorksheets, submitWorksheet,
  listApprovalTodos,
  updateProjectStatus, updateProject, updateNode, updateMaterial, todosFor, deptTodos, getProjectAsync, flushSync, syncPull, syncStatus, createInitiation, listInitiations, transitionInitiation, getWsTemplates, getWorksheetHistory, makeWorksheet, approveWorksheet, rejectWorksheet, listWorksheetsV2, listWorksheetApprovals, nodeWsStatus,
  getCaptureTypes, submitCapture, listCaptures,
  transitionMaterial, ecnTransition, completeWorkItem, overview, hasPerm, reset
};
