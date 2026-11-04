'use strict';
// 微系统「全部系统接入」自查：PLM/会议/Hub/SPC/CRM/EBMS/HLC 状态、CRM 与 EBMS 真实数据、手机端入口
const http = require('http');

function req(p, m, b) {
  return new Promise((resolve, reject) => {
    const h = {};
    if (b) h['Content-Type'] = 'application/json';
    const q = http.request({ host: '127.0.0.1', port: 4173, path: p, method: m || 'GET', headers: h }, x => {
      x.setEncoding('utf8'); let d = ''; x.on('data', c => d += c);
      x.on('end', () => resolve({ s: x.statusCode, b: d }));
    });
    q.on('error', reject);
    if (b) q.write(JSON.stringify(b));
    q.end();
  });
}
const j = (r) => { try { return JSON.parse(r.b); } catch (e) { return {}; } };

(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { if (ok) { pass++; console.log('  [PASS] ' + n + (d ? ' | ' + d : '')); } else { fail++; console.log('  [FAIL] ' + n + (d ? ' | ' + d : '')); } };

  /* ---- 系统总览 ---- */
  const sy = j(await req('/api/v1/systems'));
  const S = sy.systems || {};
  const need = ['plm', 'meeting', 'hub', 'spc', 'crm', 'ebms', 'hlc', 'fac', 'edp'];
  ck('系统总览覆盖全部系统', need.every(k => S[k]), Object.keys(S).join(','));
  const liveOk = ['plm', 'meeting', 'hub', 'spc', 'crm', 'ebms', 'hlc'].filter(k => S[k] && S[k].ok);
  ck('本地已部署系统已连接（SPC 为公网，单独校验其状态如实）', liveOk.length >= 6, liveOk.join(',') + '（' + liveOk.length + '/7）');
  ck('SPC 状态如实报告（连接或带原因）', S.spc && typeof S.spc.ok === 'boolean' && (S.spc.ok || !!S.spc.error));
  ck('未部署系统如实标记（不伪造）', S.fac && S.fac.configured === false && S.fac.ok === false && S.edp && S.edp.configured === false && S.edp.ok === false);

  /* ---- CRM 真实数据 ---- */
  const cs = j(await req('/api/v1/crm/status'));
  ck('CRM 已连接', cs.connected === true && cs.configured === true, cs.api);
  const cd = j(await req('/api/v1/crm/dashboard'));
  ck('CRM 概览可读（统计对象）', !!(cd.data && cd.data.stats), JSON.stringify(cd.data && cd.data.stats));
  const leads = j(await req('/api/v1/crm/leads?page=1&page_size=5'));
  ck('CRM 线索可读且分页正确', typeof (leads.data || {}).total === 'number' && (leads.data.total > 0), '线索 ' + ((leads.data || {}).total));
  const opps = j(await req('/api/v1/crm/opportunities?page=1&page_size=5'));
  ck('CRM 商机可读', (opps.data || {}).total > 0, '商机 ' + ((opps.data || {}).total));
  const orders = j(await req('/api/v1/crm/orders?page=1&page_size=5'));
  ck('CRM 订单可读', (orders.data || {}).total > 0, '订单 ' + ((orders.data || {}).total));

  /* ---- EBMS ---- */
  const es = j(await req('/api/v1/ebms/status'));
  ck('EBMS 已连接', es.connected === true && es.configured === true, es.api);
  const ws = j(await req('/api/v1/ebms/workspace?person_id=1'));
  const w = ws.data || ws;
  ck('EBMS 岗位信息可读（M10 契约）', w.contract_version === 'M10-POMS.V1' && !!w.name, w.name + ' / ' + w.department);
  const wi = j(await req('/api/v1/ebms/work-items?person_id=1'));
  const wb = wi.data || wi;
  ck('EBMS 待办事项结构可读', !!wb.summary && typeof wb.summary.total === 'number', JSON.stringify(wb.summary));

  /* ---- 手机端入口 ---- */
  const m = await req('/m');
  ck('手机端 5 个页签（含系统）', ['todos', 'capture', 'approval', 'systems', 'mine'].every(k => m.b.includes('data-tab="' + k + '"')));
  ck('手机端系统页含全部系统入口', ['/plm2', '/m/spc', '/m/crm', '/m/ebms', '/hlc'].every(h => m.b.includes(h)));
  const crmPage = await req('/m/crm');
  ck('CRM 手机页可访问（商机/订单/线索）', crmPage.s === 200 && ['商机', '订单', '线索'].every(k => crmPage.b.includes(k)));
  const ebmsPage = await req('/m/ebms');
  ck('EBMS 手机页可访问（岗位/待办/结果）', ebmsPage.s === 200 && ['我的岗位', '待办事项', '经营结果'].every(k => ebmsPage.b.includes(k)));
  ck('待办可点开明细并直接处理', m.b.includes('todoSheet') && m.b.includes('openTodoDetail') && m.b.includes('window.todoAct'));
  ck('CRM 页可处理（审批/任务/商机阶段）', crmPage.b.includes('待审批') && crmPage.b.includes('我的任务') && crmPage.b.includes('stageAct') && crmPage.b.includes('apprAct') && crmPage.b.includes('taskDone'));
  ck('EBMS 页可点开明细', ebmsPage.b.includes('wiDetail') && ebmsPage.b.includes('shTitle'));
  const appr = j(await req('/api/v1/crm/approvals?page=1&page_size=5'));
  ck('CRM 待审批列表可读', appr.data && typeof appr.data.total === 'number', '待审批 ' + (appr.data && appr.data.total));
  const w1 = await req('/api/v1/crm/opportunities/not-exist/stage', 'POST', { stage: 'WON' });
  const w2 = await req('/api/v1/crm/approvals/not-exist/approve', 'POST', { comment: 'x' });
  ck('CRM 处理动作走官方接口且失败不伪造', [w1, w2].every(x => x.s >= 400) && [w1, w2].every(x => !!j(x).error));
  const portal = await req('/portal');
  ck('门户含 CRM 与 EBMS 手机入口', portal.b.includes('/m/crm') && portal.b.includes('/m/ebms'));

  console.log('\n全部系统接入自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
