const http = require('http');
function req(o, b) { return new Promise((res, rej) => { const r = http.request(o, x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c).toString('utf8') })); }); r.on('error', rej); if (b) r.write(b); r.end(); }); }
const jj = (p, m, pl, tok) => { const o = { host: '127.0.0.1', port: 4173, path: p, method: m || 'GET', headers: {} }; let b; if (tok) o.headers.Authorization = 'Bearer ' + tok; if (pl) { b = JSON.stringify(pl); o.headers['Content-Type'] = 'application/json'; o.headers['Content-Length'] = Buffer.byteLength(b); } return req(o, b); };
const plm = (p, m, pl, tok) => { const o = { host: '127.0.0.1', port: 8081, path: '/api' + p, method: m || 'GET', headers: { 'Content-Type': 'application/json' } }; if (tok) o.headers.Authorization = 'Bearer ' + tok; let b; if (pl) { b = JSON.stringify(pl); o.headers['Content-Length'] = Buffer.byteLength(b); } return req(o, b); };
(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { ok ? (pass++, console.log('  [PASS] ' + n + (d ? ' | ' + d : ''))) : (fail++, console.log('  [FAIL] ' + n + (d ? ' | ' + d : ''))); };
  const API = '/api/v1/plm2';

  // 登录（admin/736669）
  const lg = await jj(API + '/auth/login', 'POST', { username: 'admin', password: '736669' });
  const auth = JSON.parse(lg.body);
  ck('登录', lg.status === 200 && !!auth.token, auth.realName + '/' + auth.role);

  // 选项目（虞周峰负责的，制作人与审批人分离：制作=虞周峰? 用 admin 会同人冲突 → 用第二个真实用户名模拟制作人 '包跃'，审批=admin）
  const P = JSON.parse((await jj(API + '/projects')).body).projects.find(x => x.owner === '虞周峰');
  const no = encodeURIComponent(P.projectNo);

  // ① 打开模板（含项目信息）
  const tpls = JSON.parse((await jj(API + '/ws-templates')).body).data || JSON.parse((await jj(API + '/ws-templates')).body);
  const type = tpls.nodeMap['SPEC'];
  ck('模板接口返回 8 类+节点映射', Object.keys(tpls.templates).length === 8 && type === 'spec');

  // ② 制作（保存草稿）
  const mk1 = JSON.parse((await jj(API + '/ws-v2', 'POST', { projectNo: P.projectNo, nodeCode: 'SPEC', actor: '包跃', action: 'draft', fields: { model: 'MB-40', power: '40', status: '编制中' } }, auth.token)).body);
  ck('保存草稿 DRAFT', mk1.status === 'DRAFT', mk1.id);

  // ③ 提交审批
  const mk2 = JSON.parse((await jj(API + '/ws-v2', 'POST', { projectNo: P.projectNo, nodeCode: 'SPEC', actor: '包跃', action: 'submit', fields: { model: 'MB-40', power: '40', cct: '4000', status: '已批准' } }, auth.token)).body);
  ck('提交审批 SUBMITTED（复用草稿）', mk2.status === 'SUBMITTED' && mk2.id === mk1.id);

  // ④ 审批队列可见
  const ap = JSON.parse((await jj(API + '/ws-v2?approvals=1')).body);
  ck('审批队列含该资料', ap.items.some(x => x.id === mk1.id));

  // ⑤ 同人审批被拒（包跃自审）
  const self = await jj(`${API}/ws-v2/${mk1.id}/approve`, 'POST', { approver: '包跃', role: 'RD_LEAD' });
  ck('制作人自审被拒 403', self.status === 403);

  // ⑥ admin 批准 → 归档 + 节点联动 + PLM 表同步
  const appr = JSON.parse((await jj(`${API}/ws-v2/${mk1.id}/approve`, 'POST', { approver: '系统管理员', role: 'ADMIN' }, auth.token)).body);
  ck('批准归档 ARCHIVED + 节点 DONE', appr.status === 'ARCHIVED' && appr.nodeStatus === 'DONE', appr.archiveRef + ' / plmSync=' + JSON.stringify(appr.plmSync));
  ck('PLM 归档同步成功', appr.plmSync && appr.plmSync.ok === true, (appr.plmSync||{}).msg || '');

  // ⑦ 直查 PLM 真实表：spec 表出现该记录
  const sheets = JSON.parse((await plm(`/v1/rd/sheets/spec?projectNo=${encodeURIComponent(P.projectNo)}`, 'GET', null, auth.token)).body);
  const list = (sheets.data && (sheets.data.list || sheets.data.records || sheets.data)) || [];
  const found = Array.isArray(list) && list.some(r => String(r.model||'').includes('MB-40') || String(r._archiveRef||r.archiveRef||'').includes(appr.archiveRef));
  ck('PLM spec 表已含归档记录', found, `共 ${Array.isArray(list)?list.length:'?'} 条`);

  // ⑧ 驳回流程
  const mk3 = JSON.parse((await jj(API + '/ws-v2', 'POST', { projectNo: P.projectNo, nodeCode: 'CONFIG', actor: '包跃', action: 'submit', fields: { signed: '是' } }, auth.token)).body);
  const rej = JSON.parse((await jj(`${API}/ws-v2/${mk3.id}/reject`, 'POST', { approver: '系统管理员', role: 'ADMIN', reason: '配置不完整' }, auth.token)).body);
  ck('驳回退回草稿可改', rej.status === 'REJECTED' && rej.rejectReason === '配置不完整');

  // ⑨ 页面含制作入口与审批
  const pg = (await jj('/plm2')).body;
  ['makeDoc', 'mkModal', '制作</button>', '资料审批', '批准归档', 'wsApprove'].forEach(k => ck('页面含：' + k, pg.includes(k)));

  console.log('\n资料制作→审批→归档→同步自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
