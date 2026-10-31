'use strict';
// adapters/org — 组织/岗位装配 mock adapter（Owner M01/M10）。
// 数据来源 configs/org.json：公司 → 部门 → 岗位 → 职责/任务/能力包。
// 岗位自动装配：根据选择动态下发职责与任务项，公共代码零产品侵入。
const ORG = require('../../configs/org.json');

function listCompanies() {
  return ORG.companies.map(c => ({ id: c.id, name: c.name, short: c.short, family: c.family }));
}

function listDepartments(companyId) {
  return ORG.departments[companyId] || [];
}

function listPositions(companyId, department) {
  const dept = ORG.positions[companyId] && ORG.positions[companyId][department];
  return dept ? Object.keys(dept) : [];
}

function assemble({ company, department, position }) {
  const comp = ORG.companies.find(c => c.id === company);
  if (!comp) throw Object.assign(new Error('company not found'), { status: 404 });
  const pos = ORG.positions[company] && ORG.positions[company][department] && ORG.positions[company][department][position];
  if (!pos) throw Object.assign(new Error('position not found'), { status: 404 });

  const packs = pos.packs.map(id => ({ id, name: ORG.packLabels[id] || id }));
  return {
    company: comp,
    department,
    position,
    duties: pos.duties,
    tasks: pos.tasks,
    packs,
    manifest: {
      manifest_id: 'm_' + Date.now().toString(36),
      company_id: company,
      department,
      position,
      policy_version: 'candidate-v1',
      industry_pack_ref: comp.family,
      expires_at: Date.now() + 60 * 60 * 1000,
      widgets: ['future_todos', 'past_results', 'personal_agent'],
      capability_ids: pos.packs
    }
  };
}

module.exports = { listCompanies, listDepartments, listPositions, assemble };
