'use strict';
// tests/contract/run.js — L0 契约测试（模块级，无需外部依赖）。
// 覆盖：装配、兼岗、跨租户拒绝、产品包匹配、done≠verified、幂等、Agent 未连接不虚假成功。
const assert = require('assert');
const assembly = require('../../packages/assembly');
const capture = require('../../packages/capture');
const m01 = require('../../adapters/m01');
const m07 = require('../../adapters/m07');
const m08 = require('../../adapters/m08');
const org = require('../../adapters/org');
const plm2 = require('../../adapters/plm2');
const hub = require('../../adapters/hub');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { console.error('  ✘ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('M10 POMS L0 契约测试\n');

test('AT01/AT02 兼岗装配：质检员+研发 合并能力', () => {
  const m = assembly.assemble({ actor_id: 'u-1002' });
  assert(m.capability_ids.includes('quality'), '缺少 quality');
  assert(m.capability_ids.includes('rd-design'), '缺少 rd-design');
  assert.strictEqual(m.positions.length, 2, '应有两个岗位');
});

test('AT04 恒剑灯具 -> 能力包匹配 lighting-inspection', () => {
  const m = assembly.assemble({ actor_id: 'u-1001', product_family: 'led-light', model_id: 'EXAMPLE_ONLY' });
  assert.strictEqual(m.product_pack.pack_id, 'lighting-inspection');
});

test('AT04 贞观定时器 -> 能力包匹配 timer-inspection', () => {
  const m = assembly.assemble({ actor_id: 'u-2001', product_family: 'timer', model_id: 'EXAMPLE_ONLY' });
  assert.strictEqual(m.product_pack.pack_id, 'timer-inspection');
});

test('跨租户默认拒绝：恒剑人员请求 timer 产品族', () => {
  assert.throws(() => assembly.assemble({ actor_id: 'u-1001', product_family: 'timer' }), /denied/);
});

test('U05 采集提交后为 pending-review，不是 verified', () => {
  const r = capture.submitCapture({ actor_id: 'u-1001', idempotency_key: 'ik-' + Date.now(), capture_type: 'scan', values: { power_w: 198 } });
  assert.strictEqual(r.status, 'pending-review', '应进入待验证');
  assert(r.evidence_id, '应产生 evidence 引用');
});

test('AT07 相同 Idempotency-Key 不重复写记录', () => {
  const key = 'ik-dup-' + Date.now();
  const a = capture.submitCapture({ actor_id: 'u-1001', idempotency_key: key, capture_type: 'scan', values: {} });
  const b = capture.submitCapture({ actor_id: 'u-1001', idempotency_key: key, capture_type: 'scan', values: {} });
  assert.strictEqual(a.capture_id, b.capture_id, '应返回同一 capture_id');
  assert.strictEqual(b.replay, true);
});

test('U06 越权拒绝：销售专员无 capture 能力', () => {
  assert.throws(() => capture.submitCapture({ actor_id: 'u-1003', idempotency_key: 'ik-x', capture_type: 'scan', values: {} }), /denied/);
});

test('done != verified：M08 review 由验证者产生 verified', () => {
  const r = m08.reviewCapture('cap_abc', '主管-授权验证者');
  assert.strictEqual(r.status, 'verified');
  assert(r.verified_by, '需记录验证者');
});

test('AT11 Hub 未连接时打开会话返回 503，不虚假成功', () => {
  assert.throws(() => hub.openSession('agent-main'), e => e.status === 503);
});

test('U09 Agent 列表含主 Agent 与专业子 Agent，未连接为 simulated', () => {
  const agents = hub.listAgents();
  assert(agents.some(a => a.role === 'personal'));
  assert(agents.some(a => a.role === 'pro'));
  assert(agents.every(a => a.status === 'simulated'));
});

/* ---- 恒剑 M07+M10 契约（AEOS_M07_M10_可开发资料包 V1.0） ---- */
console.log('\n恒剑 M07+M10（报修/请假 MVP）\n');

test('T-001 报修闭环：提交→分派→处理→验收→关闭', () => {
  const r = m07.createRequest({ type: 'logistics_repair', subject: '车间照明维修', requester: 'p-003', idempotency_key: 'ik-m07-' + Date.now() });
  m07.submitRequest(r.id, 'p-003');                          // SUBMITTED
  m07.transition(r.id, 'TRIAGED', { actor: 'p-002' });       // TRIAGED
  m07.transition(r.id, 'ASSIGNED', { actor: 'p-002', assignee: 'p-002', sla: '10-17' }); // ASSIGNED
  m07.transition(r.id, 'IN_PROGRESS', { actor: 'p-002' });   // IN_PROGRESS
  m07.transition(r.id, 'AWAITING_ACCEPTANCE', { actor: 'p-002', evidence_ref: 'EVD-1' }); // 处理完成
  const closed = m07.transition(r.id, 'CLOSED', { actor: 'p-003', verifier: 'p-003' });   // 验收关闭
  assert.strictEqual(closed.state, 'CLOSED');
  assert(closed.result_ref, '应生成 ResultRef');
});

test('T-003 非法工作流跳步返回 409', () => {
  const r = m07.createRequest({ type: 'leave', subject: '请假', requester: 'p-001', idempotency_key: 'ik-lv-' + Date.now() });
  m07.submitRequest(r.id, 'p-001');
  assert.throws(() => m07.transition(r.id, 'APPROVED', { actor: 'p-002' }), e => e.status === 409); // 不能从 SUBMITTED 直接 APPROVED
});

test('T-002 相同 Idempotency-Key 不重复创建请求', () => {
  const key = 'ik-dup-m07-' + Date.now();
  const a = m07.createRequest({ type: 'logistics_repair', subject: 'x', requester: 'p-004', idempotency_key: key });
  const b = m07.createRequest({ type: 'logistics_repair', subject: 'x', requester: 'p-004', idempotency_key: key });
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(b.replay, true);
});

test('done != verified：执行者不可自验（CLOSED 拒绝）', () => {
  const r = m07.createRequest({ type: 'logistics_repair', subject: '自验测试', requester: 'p-001', idempotency_key: 'ik-self-' + Date.now() });
  m07.submitRequest(r.id, 'p-001');
  m07.transition(r.id, 'TRIAGED', { actor: 'p-002' });
  m07.transition(r.id, 'ASSIGNED', { actor: 'p-002', assignee: 'p-002', sla: '10-20' });
  m07.transition(r.id, 'IN_PROGRESS', { actor: 'p-002' });
  m07.transition(r.id, 'AWAITING_ACCEPTANCE', { actor: 'p-002', evidence_ref: 'EVD-9' });
  assert.throws(() => m07.transition(r.id, 'CLOSED', { actor: 'p-002', verifier: 'p-002' }), /self-verify/);
});

test('AWAITING_ACCEPTANCE 必须带证据引用', () => {
  const r = m07.createRequest({ type: 'logistics_repair', subject: '缺证据', requester: 'p-001', idempotency_key: 'ik-evd-' + Date.now() });
  m07.submitRequest(r.id, 'p-001');
  m07.transition(r.id, 'TRIAGED', { actor: 'p-002' });
  m07.transition(r.id, 'ASSIGNED', { actor: 'p-002', assignee: 'p-002', sla: '10-20' });
  m07.transition(r.id, 'IN_PROGRESS', { actor: 'p-002' });
  assert.throws(() => m07.transition(r.id, 'AWAITING_ACCEPTANCE', { actor: 'p-002' }), /evidence/);
});

/* ---- 组织/岗位装配（公司→部门→岗位→职责/任务） ---- */
console.log('\n岗位装配（公司/部门/岗位）\n');

test('公司列表含恒剑与贞观', () => {
  const cs = org.listCompanies();
  assert(cs.some(c => c.id === 'hengjian'));
  assert(cs.some(c => c.id === 'zhenguan'));
});

test('部门按公司级联，岗位按部门级联', () => {
  const deps = org.listDepartments('hengjian');
  assert(deps.includes('研发部') && deps.includes('财务部'), '恒剑应含研发部/财务部');
  assert(!org.listDepartments('zhenguan').includes('财务部'), '贞观不应含财务部');
  assert(org.listPositions('hengjian', '质量部').includes('质检员'));
});

test('装配：恒剑质检员职责/任务/能力包正确', () => {
  const r = org.assemble({ company: 'hengjian', department: '质量部', position: '质检员' });
  assert(r.duties.some(d => d.includes('检验')), '应含检验职责');
  assert(r.tasks.some(t => t.t.includes('灯具检验')), '应含灯具检验任务');
  assert(r.packs.some(p => p.id === 'quality'));
  assert.strictEqual(r.manifest.industry_pack_ref, 'lighting');
});

test('装配：贞观质检员任务为定时器（公共代码零产品侵入）', () => {
  const r = org.assemble({ company: 'zhenguan', department: '质量部', position: '质检员' });
  assert(r.tasks.some(t => t.t.includes('定时器检验')), '应含定时器检验任务');
  assert.strictEqual(r.manifest.industry_pack_ref, 'timer');
});

test('装配：非法岗位返回 404', () => {
  assert.throws(() => org.assemble({ company: 'hengjian', department: '研发部', position: '不存在' }), e => e.status === 404);
});

/* ---- PLM-2 研发中心（接入 PLM2 仓库真实数据） ---- */
console.log('\nPLM-2 研发中心（六大角色 / ECN三级审批 / 物料生命周期）\n');

test('六大固定角色与权限矩阵', () => {
  const roles = plm2.getRoles();
  ['ADMIN','ENGINEER','QUALITY','SALES','SUPPLIER','CUSTOMER'].forEach(c => {
    assert(roles.some(r => r.code === c), '缺少角色 ' + c);
  });
  assert(plm2.hasPerm('QUALITY', 'bom'), '品质应可查看 BOM');
  assert(!plm2.hasPerm('QUALITY', 'mold'), '品质应屏蔽模具');
  assert(!plm2.hasPerm('SALES', 'ecn:add'), '销售不应有 ECN 新建');
});

test('岗位装配：按角色下发模块与职责', () => {
  const m = plm2.getManifest('ENGINEER');
  assert(m.modules.some(x => x.code === 'ecn'), '工程师应有 ECN');
  assert(m.duties.some(d => d.includes('ECN')));
  const q = plm2.getManifest('QUALITY');
  assert(!q.modules.some(x => x.code === 'mold'), '品质不应见模具');
});

test('ECN 三级审批：创建→提交→一审→二审→生效 并升级版本', () => {
  const m = plm2.listMaterials()[0];
  const e = plm2.createEcn({ partNo: m.partNo, changeType: 'STRUCTURE', reason: '测试变更', applicant: '包跃', versionAfter: 'V9.9' });
  assert.strictEqual(e.status, 'DRAFT');
  plm2.ecnTransition(e.ecnNo, 'submit', 'ENGINEER');
  assert.strictEqual(plm2.ecnTransition(e.ecnNo, 'review1', 'RD_LEAD').to, 'PENDING_L2');
  assert.strictEqual(plm2.ecnTransition(e.ecnNo, 'review2', 'PURCHASE').to, 'APPROVED');
  assert.strictEqual(plm2.ecnTransition(e.ecnNo, 'effect', 'ADMIN').to, 'EFFECTIVE');
  assert.strictEqual(plm2.listMaterials()[0].version, 'V9.9', '生效后版本升级');
  plm2.reset();
});

test('ECN 越权：销售不能一审', () => {
  const m = plm2.listMaterials()[0];
  const e = plm2.createEcn({ partNo: m.partNo, changeType: 'MOLD', applicant: '包跃' });
  plm2.ecnTransition(e.ecnNo, 'submit', 'ENGINEER');
  assert.throws(() => plm2.ecnTransition(e.ecnNo, 'review1', 'SALES'), x => x.status === 409);
  plm2.reset();
});

test('物料生命周期：ADMIN 可执行、SALES 被拒（数据驱动）', () => {
  const lc = plm2.getLifecycle();
  let m = null, t = null;
  for (const mm of plm2.listMaterials()) {
    const tt = lc.find(x => x.from === mm.status && x.roles.includes('ADMIN'));
    if (tt) { m = mm; t = tt; break; }
  }
  assert(m, '真实物料中应存在 ADMIN 可执行的转换');
  const r = plm2.transitionMaterial(m.partNo, t.action, 'ADMIN');
  assert.strictEqual(r.to, t.to);
  plm2.reset();
  const m2 = plm2.listMaterials().find(x => x.partNo === m.partNo);
  assert.throws(() => plm2.transitionMaterial(m2.partNo, t.action, 'SALES'), x => x.status === 403);
  plm2.reset();
});

test('我的概览：按真实人员聚合', () => {
  const yu = plm2.getPeople().find(p => p.name === '虞周峰') || plm2.getPeople()[0];
  const ov = plm2.overview(yu.id);
  assert.strictEqual(ov.user.name, yu.name);
  assert.strictEqual(ov.role.code, yu.role);
});

test('研发项目：22 节点与阶段门（真实数据）', () => {
  const projects = plm2.listProjects();
  assert(projects.length >= 100, '真实项目应≥100 个，实际 ' + projects.length);
  assert(projects.every(p => p.summary.total === 22));
  const p = plm2.getProject(projects[0].projectNo);
  assert.strictEqual(p.nodes.length, 22);
  assert(p.nodes.find(n => n.code === 'MOLD_REVIEW').key);
  const doneCnt = p.nodes.filter(n => n.status === 'DONE').length;
  assert.strictEqual(p.summary.done, doneCnt, '进度统计与节点一致');
});

test('研发项目：真实负责人存在', () => {
  const names = plm2.getPeople().map(p => p.name);
  const withOwner = plm2.listProjects().filter(p => p.owner && p.owner !== '—');
  assert(withOwner.length > 0);
  assert(withOwner.some(p => names.includes(p.owner)), '项目负责人应来自真实人员');
});

/* ---- 工作表填报与节点联动 ---- */
console.log('\nPLM-2 工作表填报 + 节点联动\n');

test('规格书批准 → SPEC 节点 DONE', () => {
  const P = plm2.listProjects()[0].projectNo;
  const r = plm2.submitWorksheet({ projectNo: P, nodeCode: 'SPEC', data: { model: 'MB-40', power: '40', cct: '4000', status: '已批准' }, operator: '包跃' });
  assert.strictEqual(r.nodeStatus, 'DONE');
  assert.strictEqual(r.nodeDone, true);
  assert(plm2.getProject(P).nodes.find(n => n.code === 'SPEC').status === 'DONE');
  plm2.reset();
});

test('试产报告不通过 → 节点仅 IN_PROGRESS', () => {
  const P = plm2.listProjects()[0].projectNo;
  const r = plm2.submitWorksheet({ projectNo: P, nodeCode: 'RD_TRIAL', data: { trialType: '研发试产', qty: '50', defectRate: '8', conclusion: '不通过' }, operator: '包跃' });
  assert.strictEqual(r.nodeStatus, 'IN_PROGRESS');
  assert.strictEqual(r.nodeDone, false);
  plm2.reset();
});

test('模具节点无在线工作表 → 422', () => {
  const P = plm2.listProjects()[0].projectNo;
  assert.throws(() => plm2.submitWorksheet({ projectNo: P, nodeCode: 'MOLD', data: { x: 1 } }), e => e.status === 422);
});

test('工作表计入节点证据数', () => {
  const P = plm2.listProjects()[0].projectNo;
  plm2.submitWorksheet({ projectNo: P, nodeCode: 'SPEC', data: { status: '编制中' }, operator: '包跃' });
  plm2.submitWorksheet({ projectNo: P, nodeCode: 'SPEC', data: { status: '已批准' }, operator: '包跃' });
  const n = plm2.getProject(P).nodes.find(x => x.code === 'SPEC');
  assert.strictEqual(n.worksheetCount, 2, '应有 2 份工作表证据');
  assert.strictEqual(n.status, 'DONE');
  plm2.reset();
});

/* ---- 工序流转（按人员联动） ---- */
console.log('\n工序流转（按人员联动）\n');

test('工序：仅负责人可完成，越权 403 / 非进行中 409', () => {
  const rt = plm2.listProcessRoutes()[0];
  const active = rt.steps.find(s => s.status === 'ACTIVE');
  assert(active, '应有进行中工序');
  assert.throws(() => plm2.completeStep(rt.routeNo, active.order, { operator: '王栌鑫' }), e => e.status === 403, '非负责人应 403');
  assert.throws(() => plm2.completeStep(rt.routeNo, 1, { operator: active.owner }), e => e.status === 409, '已完成工序应 409');
  plm2.reset();
});

test('工序：完成后自动激活下一道并推送（PROCESS_STEP_PUSHED）', () => {
  const rt = plm2.listProcessRoutes()[0];
  const active = rt.steps.find(s => s.status === 'ACTIVE');
  const r = plm2.completeStep(rt.routeNo, active.order, { operator: active.owner, remark: '演示' });
  assert.strictEqual(r.event, 'PROCESS_STEP_PUSHED');
  const rt2 = plm2.listProcessRoutes()[0];
  assert.strictEqual(rt2.steps.find(s => s.order === active.order).status, 'DONE');
  assert.strictEqual(rt2.steps.find(s => s.order === active.order + 1).status, 'ACTIVE');
  assert.strictEqual(r.nextOwner, rt2.steps.find(s => s.order === active.order + 1).owner);
  plm2.reset();
});

test('工序：逐道完成自动闭环（PROCESS_ROUTE_COMPLETED）', () => {
  const rt0 = plm2.listProcessRoutes()[0];
  let guard = 0;
  while (guard++ < 30) {
    const cur = plm2.listProcessRoutes()[0];
    if (cur.status === 'COMPLETED') break;
    const act = cur.steps.find(s => s.status === 'ACTIVE');
    plm2.completeStep(rt0.routeNo, act.order, { operator: act.owner, remark: '演示' });
  }
  assert.strictEqual(plm2.listProcessRoutes()[0].status, 'COMPLETED');
  plm2.reset();
});

/* ---- PLM 我的待办模块（真实口径） ---- */
console.log('\nPLM 我的待办模块（/v1/me/todos 口径）\n');

test('待办口径：我负责项目全部节点 ∪ 直接指派（包跃对账）', () => {
  const t = plm2.todosFor('包跃');
  const owned = plm2.listProjects().filter(p => p.owner === '包跃');
  const directOutside = require('../../configs/plm2.json').nodeOwners.filter(o => o.owner === '包跃' && !owned.find(p => p.projectNo === o.projectNo));
  const expectedDone = owned.reduce((s, p) => s + p.summary.done, 0) + directOutside.filter(o => o.status === 'DONE').length;
  assert.strictEqual(t.doneCount, expectedDone, '完成数应与项目节点统计一致');
  assert.strictEqual(t.total, owned.length * 22 + directOutside.length - t.noneCount, '总数 = 项目×22 + 项目外指派 − 无节点');
  assert.strictEqual(t.overdueCount + t.todoCount + t.doneCount, t.total, '总数不含无节点');
});

test('待办分类：已完成列表按实际日倒序且 ≤200', () => {
  const t = plm2.todosFor('包跃');
  assert(t.done.length <= 200);
  for (let i = 1; i < t.done.length; i++) {
    assert(String(t.done[i - 1].actualDate || '') >= String(t.done[i].actualDate || ''), '实际日应倒序');
  }
  t.todo.forEach(r => assert(r.status !== 'DONE'));
  t.overdue.forEach(r => assert(r.planDate && r.status !== 'DONE'));
});

test('部门待办：rd_manager 见本部门，engineer 仅 SELF', () => {
  const ppl = plm2.getPeople();
  const yu = ppl.find(p => p.name === '虞周峰');
  const d = plm2.deptTodos(yu.id);
  assert.strictEqual(d.scope, 'DEPT');
  assert(d.departments.some(x => x.deptName === '研发中心'), '应含研发中心');
  const bao = ppl.find(p => p.name === '包跃');
  assert.strictEqual(plm2.deptTodos(bao.id).scope, 'SELF');
});

/* ---- 项目明细表（复刻 progress.vue：状态/责任人/计划日/实际日/交付物） ---- */
console.log('\n项目明细表（节点编辑）\n');

test('待办类状态必须填计划日期（422）', () => {
  const P = plm2.listProjects()[0].projectNo;
  ['PLANNED', 'IN_PROGRESS', 'PENDING', 'FAILED'].forEach(st => {
    assert.throws(() => plm2.updateNode(P, 'RD_TRIAL', { status: st }), e => e.status === 422, st + ' 应 422');
  });
  plm2.reset();
});

test('责任人默认项目负责人，可指派覆盖', () => {
  const pj = plm2.listProjects().find(p => p.owner && p.owner !== '—');
  const n0 = plm2.getProject(pj.projectNo).nodes.find(x => x.code === 'SPEC');
  assert.strictEqual(n0.owner, pj.owner, '默认=项目负责人');
  assert.strictEqual(n0.ownerAssigned, false);
  plm2.updateNode(pj.projectNo, 'SPEC', { owner: '王栌鑫' });
  const n1 = plm2.getProject(pj.projectNo).nodes.find(x => x.code === 'SPEC');
  assert.strictEqual(n1.owner, '王栌鑫');
  assert.strictEqual(n1.ownerAssigned, true);
  plm2.reset();
});

test('实际日期确认当天 → DONE 且自动记当天', () => {
  const P = plm2.listProjects()[0].projectNo;
  plm2.updateNode(P, 'RD_TRIAL', { status: 'DONE' });
  const n = plm2.getProject(P).nodes.find(x => x.code === 'RD_TRIAL');
  assert.strictEqual(n.status, 'DONE');
  assert(!!n.actualDate, '实际日期应自动为当天');
  plm2.reset();
});

test('无节点不计入待办', () => {
  const cand = plm2.listProjects().find(p => p.owner === '包跃' &&
    plm2.getProject(p.projectNo).nodes.find(x => x.code === 'MOLD_SAMPLE').status !== 'DONE');
  if (!cand) { console.log('    （无可测项目，跳过）'); return; }
  const before = plm2.todosFor('包跃');
  const s0 = plm2.getProject(cand.projectNo).summary;
  plm2.updateNode(cand.projectNo, 'MOLD_SAMPLE', { status: 'NONE' });
  const after = plm2.todosFor('包跃');
  const s1 = plm2.getProject(cand.projectNo).summary;
  assert.strictEqual(after.todoCount, before.todoCount - 1, '待办应减 1');
  assert.strictEqual(after.noneCount, before.noneCount + 1);
  assert.strictEqual(after.total, before.total - 1, '待办总数应减 1');
  assert.strictEqual(s1.total, s0.total - 1, '项目进度分母应减 1');
  assert.strictEqual(s1.noneCount, 1);
  plm2.reset();
});

test('交付物默认为节点应交付资料/表单', () => {
  const P = plm2.listProjects()[0].projectNo;
  const nodes = plm2.getProject(P).nodes;
  assert(nodes.find(x => x.code === 'MOLD_REVIEW').deliveryDesc.includes('评审单'));
  assert(nodes.find(x => x.code === 'SPEC').deliveryDesc.includes('规格书'));
  assert(nodes.find(x => x.code === 'RD_TRIAL').deliveryDesc.includes('试产报告'));
});

test('数据采集：扫码匹配料号 + 幂等提交（真实物料）', () => {
  const mat = plm2.listMaterials()[0];
  const r = plm2.submitCapture({ partNo: mat.partNo, captureType: 'SPEC', role: 'ENGINEER', values: { power: '198' }, operator: '包跃', idempotency_key: 'ik-cap-' + Date.now() });
  assert.strictEqual(r.status, 'pending-review');
  assert(r.captureId, '应生成采集编号');
  assert.strictEqual(r.materialName, mat.name);
  const dup = plm2.submitCapture({ partNo: mat.partNo, captureType: 'SPEC', role: 'ENGINEER', values: { power: '198' }, operator: '包跃', idempotency_key: r.idempotency_key });
  assert.strictEqual(dup.captureId, r.captureId, '相同幂等键不重复写');
  assert.strictEqual(dup.replay, true);
});

test('数据采集：扫码错配拒绝', () => {
  assert.throws(() => plm2.submitCapture({ partNo: 'HJ-不存在', captureType: 'SPEC', role: 'ENGINEER', values: {}, operator: '包跃', idempotency_key: 'ik-x-' + Date.now() }), /404|不存在/);
});

test('采集类型严格按岗位匹配：工程师无来料检', () => {
  const eng = plm2.getCaptureTypes('ENGINEER').map(t => t.code);
  assert(eng.includes('SPEC') && eng.includes('WORKSHEET'), '工程师应有规格/工作表');
  assert(!eng.includes('IQC'), '工程师不应有来料检验');
  const qa = plm2.getCaptureTypes('QUALITY').map(t => t.code);
  assert(qa.includes('IQC') && !qa.includes('SPEC'), '品质应有 IQC 且无规格');
});

test('越权采集被拒绝：工程师提交 IQC 返回 403', () => {
  assert.throws(() => plm2.submitCapture({ partNo: 'HJ202607010001', captureType: 'IQC', role: 'ENGINEER', operator: '包跃', idempotency_key: 'ik-iqc-' + Date.now() }), e => e.status === 403);
});

console.log('\n结果: ' + passed + ' 项通过' + (process.exitCode ? '（存在失败）' : ''));
