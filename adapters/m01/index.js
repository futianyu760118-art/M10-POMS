'use strict';
// M01 Identity / Policy / DEH 的 mock adapter。
// 真实实现应由 M01 Owner 提供 OpenAPI；此处仅用于 L0 验证。
const fs = require('fs');
const path = require('path');

function loadTenant(tenantId) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'configs', 'tenants', tenantId + '.json'), 'utf8'));
}

// 简化岗位 -> 能力映射（M01 Policy 的占位）
const POSITION_CAPABILITIES = {
  '质检员': ['quality', 'capture'],
  '研发工程师': ['rd-design', 'bom', 'ecn'],
  '销售专员': ['lead', 'quote', 'delivery', 'finance']
};

const ACTORS = {
  'u-1001': { actor_id: 'u-1001', tenant_id: 'hengjian', name: '张三', positions: ['质检员'] },
  'u-1002': { actor_id: 'u-1002', tenant_id: 'hengjian', name: '李四', positions: ['质检员', '研发工程师'] }, // 兼岗
  'u-1003': { actor_id: 'u-1003', tenant_id: 'hengjian', name: '赵六', positions: ['销售专员'] },
  'u-2001': { actor_id: 'u-2001', tenant_id: 'zhenguan', name: '王五', positions: ['质检员'] }
};

function getIdentity(actorId) {
  const actor = ACTORS[actorId];
  if (!actor) throw Object.assign(new Error('actor not found'), { status: 401 });
  const tenant = loadTenant(actor.tenant_id);
  return {
    tenant_id: actor.tenant_id,
    actor_id: actor.actor_id,
    name: actor.name,
    positions: actor.positions,
    policy_revision: tenant.policy_revision,
    capabilities: [...new Set(actor.positions.flatMap(p => POSITION_CAPABILITIES[p] || []))]
  };
}

// 服务端执行前再鉴权；UI 隐藏不能充当权限控制。
function authorize(identity, capability) {
  return identity.capabilities.includes(capability);
}

// 恒剑人员（person_id，对齐 M01 Kernel MVP 的 canonical person）
const PERSONS = {
  'p-001': { person_id: 'p-001', tenant_id: 'hj-demo', name: '包跃', positions: ['研发工程师'], capabilities: ['poms:tasks:read', 'hlc:request:create'] },
  'p-002': { person_id: 'p-002', tenant_id: 'hj-demo', name: '马雅雯', positions: ['人事行政专员'], capabilities: ['poms:tasks:read', 'hlc:request:create', 'hlc:request:read', 'hlc:request:assign', 'hlc:request:approve', 'hlc:request:execute'] },
  'p-003': { person_id: 'p-003', tenant_id: 'hj-demo', name: '王栌鑫', positions: ['研发工程师（验收）'], capabilities: ['poms:tasks:read', 'hlc:request:create', 'hlc:request:verify'] },
  'p-004': { person_id: 'p-004', tenant_id: 'hj-demo', name: '赵采购', positions: ['采购'], capabilities: ['poms:tasks:read', 'hlc:request:create'] }
};

function getPerson(personId) {
  const p = PERSONS[personId];
  if (!p) throw Object.assign(new Error('person not found'), { status: 401 });
  return { ...p };
}

function getDEHActions(actorId) {
  const identity = getIdentity(actorId);
  const map = {
    quality: [{ action_id: 'act-inspect', label: '产品检验' }, { action_id: 'act-submit', label: '提交采集' }],
    capture: [{ action_id: 'act-capture', label: '证据采集' }],
    lead: [{ action_id: 'act-lead', label: '公开线索开发' }]
  };
  return identity.capabilities.flatMap(c => map[c] || []);
}

module.exports = { getIdentity, authorize, getDEHActions, getPerson, PERSONS, POSITION_CAPABILITIES };
