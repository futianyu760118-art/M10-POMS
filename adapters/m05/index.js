'use strict';
// M05 CRM 的 mock adapter（Owner M05）。
// M10 不复制 CRM：线索/客户/报价/合同等专业事实归属 M05，POMS 仅视图和 Action。
const LEADS = [
  { lead_id: 'LD-077', source: '企业公开网站', fetched_at: '2026-10-22', source_url: 'https://example.com/customers', status: 'verified' },
  { lead_id: 'LD-078', source: '展会名录（公开）', fetched_at: '2026-10-23', source_url: null, status: 'pending-review' }
];

function listLeads() {
  // 公开来源可核验、抓取时间、人工核对；遵守隐私。
  return LEADS.map(l => ({ ...l, note: '公开来源，需人工核对' }));
}

module.exports = { listLeads };
