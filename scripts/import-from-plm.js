'use strict';
/**
 * 从真实 PLM-2 生产库（docker plm-postgres / plm_v4）导入数据到 configs/plm2.json
 * 用法：node scripts/import-from-plm.js
 * 说明：仅替换数据区（departments/people/materials/ecns/projects/workItems），保留
 *       角色/权限/字典/生命周期/工作表定义等结构；processRoutes 真实为空时保留演示样例。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CFG = path.join(__dirname, '..', 'configs', 'plm2.json');

function q(sql) {
  const out = execFileSync('docker', ['exec', 'plm-postgres', 'psql', '-U', 'plm', '-d', 'plm_v4', '-t', '-A', '-c', sql], { maxBuffer: 128 * 1024 * 1024 });
  const s = out.toString('utf8').trim();
  if (!s) return [];
  return JSON.parse(s);
}

/* 真实角色 → 演示角色（取优先级最高者为主岗） */
const ROLE_MAP = {
  ADMIN: 'ADMIN', admin: 'ADMIN', gm: 'GM',
  rd_manager: 'RD_LEAD', engineer: 'ENGINEER', project_manager: 'PROJECT_MANAGER',
  sales_director: 'SALES_MANAGER', sales_manager: 'SALES_MANAGER',
  purchase: 'PURCHASE', finance: 'FINANCE', cw1: 'FINANCE',
  sales: 'SALES', sales_user: 'SALES', viewer: 'VIEWER',
  hr_manager: 'VIEWER', QUALITY: 'QUALITY', ENGINEER: 'ENGINEER', SALES: 'SALES'
};
const ROLE_PRIORITY = ['ADMIN', 'admin', 'gm', 'rd_manager', 'engineer', 'project_manager', 'sales_director', 'sales_manager', 'purchase', 'finance', 'cw1', 'sales', 'sales_user', 'viewer', 'QUALITY', 'hr_manager'];
const STATUS_LABEL = { ACTIVE: '进行中', CLOSED: '已关闭', CANCELLED: '已取消', MP: '量产', ON_HOLD: '暂停' };

const depts = q(`SELECT COALESCE(json_agg(t),'[]') FROM (SELECT dept_code code, dept_name name FROM sys_department ORDER BY sort_order) t`);
const users = q(`SELECT COALESCE(json_agg(t),'[]') FROM (
  SELECT u.id, u.username, u.real_name AS name, d.dept_name AS dept,
         COALESCE(string_agg(DISTINCT r.role_code, ','), '') AS roles
  FROM sys_user u
  LEFT JOIN sys_user_role ur ON ur.user_id=u.id
  LEFT JOIN sys_role r ON r.id=ur.role_id
  LEFT JOIN sys_department d ON d.id=u.dept_id
  WHERE COALESCE(u.deleted,0)=0
  GROUP BY u.id, u.username, u.real_name, d.dept_name ORDER BY u.id) t`);
const projects = q(`SELECT COALESCE(json_agg(t),'[]') FROM (SELECT id,project_no,project_name,part_no,customer_name,owner,department,current_gate,status,risk_level FROM plm_project ORDER BY id) t`);
const nodes = q(`SELECT COALESCE(json_agg(t),'[]') FROM (SELECT project_no,node_code,status FROM plm_project_node WHERE status IS NOT NULL AND status <> 'NOT_SET') t`);
const materials = q(`SELECT COALESCE(json_agg(t),'[]') FROM (SELECT part_no,material_name,material_type,status,version_no,phase,part_category,product_series,created_by FROM plm_material WHERE COALESCE(deleted,0)=0 ORDER BY id) t`);
const ecns = q(`SELECT COALESCE(json_agg(t),'[]') FROM (SELECT ecn_no,part_no,material_name,change_type,status,version_before,version_after,applicant,change_reason,mold_cost FROM plm_ecn ORDER BY id) t`);
const workItems = q(`SELECT COALESCE(json_agg(t),'[]') FROM (SELECT item_no,type,title,ref_type,ref_id,priority,owner_id,status,sla_due_at FROM plm_work_item ORDER BY id DESC LIMIT 200) t`);
const routes = q(`SELECT COALESCE(json_agg(t),'[]') FROM (SELECT route_no,route_name,ref_type,ref_id,status FROM plm_process_route ORDER BY id LIMIT 50) t`);
/* PLM 真实菜单树（sys_permission 全量） */
const perms = q(`SELECT COALESCE(json_agg(t),'[]') FROM (
  SELECT p.id, p.perm_code, p.perm_name, p.perm_type, p.path, p.component, p.icon, p.sort_order,
         pp.perm_code AS parent_code
  FROM sys_permission p LEFT JOIN sys_permission pp ON p.parent_id = pp.id
  ORDER BY p.perm_type, p.sort_order, p.id) t`);
const menus = perms.filter(x => x.perm_type === 1).map(x => ({
  code: x.perm_code, name: x.perm_name, path: x.path || null, icon: x.icon || null,
  parent: x.parent_code || null, sort: x.sort_order
}));
const buttons = perms.filter(x => x.perm_type === 2).map(x => ({
  code: x.perm_code, name: x.perm_name, parent: x.parent_code || null
}));

/* 个人模块（对齐 /v1/me/overview 与 /v1/me/todos）：全量节点状态/计划日/实际日/直接指派 + 证据/反馈 */
const evidRows = q(`SELECT COALESCE(json_agg(t),'[]') FROM (SELECT uploaded_by u, count(*) c FROM plm_project_node_evidence WHERE uploaded_by IS NOT NULL AND uploaded_by<>'' GROUP BY uploaded_by) t`);
const fbRows = q(`SELECT COALESCE(json_agg(t),'[]') FROM (SELECT u.real_name n, count(f.id) c FROM plm_feedback f JOIN sys_user u ON u.id=f.submitter_id WHERE COALESCE(f.deleted,0)=0 GROUP BY u.real_name) t`);
const allNodes = q(`SELECT COALESCE(json_agg(t),'[]') FROM (SELECT project_no,node_code,status,owner,plan_date,actual_date FROM plm_project_node ORDER BY project_no,seq) t`);
const DEFS = ['PLAN','BOM','SPEC','CONFIG','MOLD_DRAWING','MOLD_REVIEW','HAND_SAMPLE','APPEARANCE','STRUCTURE','ELECTRONICS','MOLD','MOLD_SAMPLE','PACKAGING','ELEC_TRIAL','RD_TRIAL','ENG_TRIAL','PROD_TRIAL','TEST_REPORT','TECH_TRANSFER','SHIPMENT','REVIEW','OTHER'];
const d10 = v => v ? String(v).slice(0, 10) : null;
const nodeStatusAll = {}, nodePlans = {}, nodeActual = {}, nodeOwners = [];
allNodes.forEach(n => {
  (nodeStatusAll[n.project_no] = nodeStatusAll[n.project_no] || {})[n.node_code] = n.status;
  if (n.plan_date) (nodePlans[n.project_no] = nodePlans[n.project_no] || {})[n.node_code] = d10(n.plan_date);
  if (n.actual_date) (nodeActual[n.project_no] = nodeActual[n.project_no] || {})[n.node_code] = d10(n.actual_date);
  if (n.owner && n.owner !== '') nodeOwners.push({ projectNo: n.project_no, nodeCode: n.node_code, status: n.status, owner: n.owner, planDate: d10(n.plan_date), actualDate: d10(n.actual_date) });
});
Object.keys(nodeStatusAll).forEach(pn => { nodeStatusAll[pn] = DEFS.map(c => nodeStatusAll[pn][c] || 'NOT_SET'); });
const today = new Date().toISOString().slice(0, 10);
const personalStats = { evidence: {}, feedback: {} };
evidRows.forEach(r => personalStats.evidence[r.u] = r.c);
fbRows.forEach(r => personalStats.feedback[r.n] = r.c);

/* ---- 变换 ---- */
const deptCode = {}; depts.forEach(d => deptCode[d.name] = d.code);

const people = users.map(u => {
  const rs = (u.roles || '').split(',').filter(Boolean);
  const primary = ROLE_PRIORITY.find(p => rs.includes(p));
  return { id: u.id, name: u.name, username: u.username, role: ROLE_MAP[primary] || 'VIEWER', dept: deptCode[u.dept] || null, realRoles: rs };
});

const nodeMap = {};
nodes.forEach(n => { (nodeMap[n.project_no] = nodeMap[n.project_no] || {})[n.node_code] = n.status; });

const pj = projects.map(p => ({
  plmId: p.id, projectNo: p.project_no, name: p.project_name, partNo: p.part_no || null,
  customer: p.customer_name || '', owner: p.owner || '—',
  dept: deptCode[p.department] || null,
  gate: p.current_gate === '暂停' ? 'BLOCKED' : (p.current_gate || 'G0'),
  status: p.status || 'ACTIVE', risk: p.risk_level || 'green',
  nodes: nodeMap[p.project_no] || {}
}));

const mats = materials.map(m => ({
  partNo: m.part_no, name: m.material_name, type: m.material_type, status: m.status,
  version: m.version_no || 'V1.0', phase: m.phase || 'CONCEPT',
  category: m.part_category || 'COMPONENT', series: m.product_series || '',
  owner: m.created_by || '—'
}));

const ecnList = ecns.map(e => ({
  ecnNo: e.ecn_no, partNo: e.part_no, name: e.material_name, changeType: e.change_type,
  versionBefore: e.version_before, versionAfter: e.version_after, status: e.status,
  applicant: e.applicant || '—', reason: e.change_reason || '', cost: Number(e.mold_cost || 0),
  flow: ['提交', '研发主管一审', '供应链总监二审', '生效']
}));

const wis = workItems.map(w => ({
  itemNo: w.item_no, type: w.type, title: w.title, refType: w.ref_type, refId: w.ref_id,
  priority: w.priority == null ? 3 : w.priority, ownerId: w.owner_id,
  owner: (people.find(p => p.id === w.owner_id) || {}).name || '—',
  status: w.status, sla: w.sla_due_at ? String(w.sla_due_at).slice(0, 16).replace('T', ' ') : '—'
}));

/* ---- 合并写回 ---- */
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const keepRoutes = routes.length ? cfg.processRoutes /* 真实路线字段过少时暂保留样例，后续接 steps 查询 */ : cfg.processRoutes;
cfg.dataOrigin = { source: 'plm-postgres / plm_v4（真实生产库）', importedAt: new Date().toISOString(), counts: { projects: pj.length, nodes: nodes.length, materials: mats.length, ecns: ecnList.length, people: people.length, workItems: wis.length } };
cfg.departments = depts.map(d => ({ code: d.code, name: d.name }));
cfg.people = people;
cfg.materials = mats;
cfg.ecns = ecnList;
cfg.projects = pj;
cfg.workItems = wis;
cfg.processRoutes = keepRoutes;
cfg.gates = Object.assign({}, cfg.gates, { BLOCKED: '暂停' });
cfg.projectStatusLabel = STATUS_LABEL;
cfg.plmMenus = { menus, buttons };
cfg.personalStats = personalStats;
cfg.nodeStatusAll = nodeStatusAll;
cfg.nodePlans = nodePlans;
cfg.nodeActual = nodeActual;
cfg.nodeOwners = nodeOwners;
cfg.dataOrigin.personalToday = today;
cfg.dataOrigin.counts.nodeAll = allNodes.length;
fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2), 'utf8');

console.log('导入完成：', JSON.stringify(cfg.dataOrigin.counts));
console.log('示例项目：', pj.slice(0, 3).map(p => `${p.projectNo} ${p.name} [${p.gate}] ${p.owner}`).join(' | '));
