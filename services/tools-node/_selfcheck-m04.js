const http = require('http');
function req(o, b) { return new Promise((res, rej) => { const r = http.request(o, x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c).toString('utf8') })); }); r.on('error', rej); if (b) r.write(b); r.end(); }); }
const jj = (p, m, pl, tok) => { const o = { host: '127.0.0.1', port: 4173, path: p, method: m || 'GET', headers: {} }; let b; if (tok) o.headers.Authorization = 'Bearer ' + tok; if (pl) { b = JSON.stringify(pl); o.headers['Content-Type'] = 'application/json'; o.headers['Content-Length'] = Buffer.byteLength(b); } return req(o, b); };
const plm = (p, m, pl, tok) => { const o = { host: '127.0.0.1', port: 8081, path: '/api' + p, method: m || 'GET', headers: { 'Content-Type': 'application/json' } }; if (tok) o.headers.Authorization = 'Bearer ' + tok; let b; if (pl) { b = JSON.stringify(pl); o.headers['Content-Length'] = Buffer.byteLength(b); } return req(o, b); };
(async () => {
  let pass = 0, fail = 0, t0 = Date.now();
  const ck = (step, ok, d) => { const ms = Date.now() - t0; ok ? (pass++, console.log(`  [PASS] ${step}${d?' | '+d:''} (${ms}ms)`)) : (fail++, console.log(`  [FAIL] ${step}${d?' | '+d:''}`)); };
  const API = '/api/v1/plm2';

  // ① 登录（M04 统一认证）
  const lg = await jj(API + '/auth/login', 'POST', { username: 'admin', password: '736669' });
  const auth = JSON.parse(lg.body);
  ck('① 登录 admin/736669', lg.status === 200 && !!auth.token, `${auth.realName}/${auth.role}/roles=${(auth.roles||[]).join(',')}`);
  const tok = auth.token;

  // ② 令牌验证
  const me = await jj(API + '/auth/me', 'GET', null, tok);
  const meJ = JSON.parse(me.body);
  ck('② /auth/me 令牌有效', me.status === 200 && meJ.realName === auth.realName);

  // ③ 岗位装配（含兼岗）
  const mf = JSON.parse((await jj(API + '/me/manifest?role=ENGINEER,RD_LEAD', 'GET', null, tok)).body);
  ck('③ 装配（兼岗）', mf.modules && mf.modules.length > 0 && mf.duties && mf.duties.length > 3, `${mf.modules.length}模块/${mf.duties.length}职责/${mf.permission_matrix.length}权限`);

  // ④ 我的待办（PLM 口径）
  const bao = JSON.parse((await jj(API + '/people')).body).people.find(p => p.name === '包跃');
  const todos = JSON.parse((await jj(API + '/me/todos?user=' + bao.id, 'GET', null, tok)).body);
  ck('④ 我的待办', typeof todos.todoCount === 'number' && todos.total > 0, `todo=${todos.todoCount}/total=${todos.total}`);

  // ⑤ 打开项目（读透）
  const P = JSON.parse((await jj(API + '/projects')).body).projects.find(x => x.owner === '虞周峰');
  const no = encodeURIComponent(P.projectNo);
  const det = JSON.parse((await jj(API + '/projects/' + no, 'GET', null, tok)).body);
  ck('⑤ 项目详情（22节点+读透）', det.nodes.length === 22);

  // ⑥ 资料制作（模板+历史）
  const tpl = JSON.parse((await jj(API + '/ws-templates')).body);
  const hist = JSON.parse((await jj(API + '/ws-history?projectNo=' + no + '&nodeCode=SPEC')).body);
  ck('⑥ 模板+历史', tpl.templates && Object.keys(tpl.templates).length === 8, `历史=${hist.count}条`);

  // ⑦ 提交资料
  const mk = JSON.parse((await jj(API + '/ws-v2', 'POST', { projectNo: P.projectNo, nodeCode: 'SPEC', actor: '包跃', action: 'submit', fields: { model: 'E2E-TEST', power: '40', status: '已批准' } }, tok)).body);
  ck('⑦ 提交资料', mk.status === 'SUBMITTED');

  // ⑧ 主管审批（职责分离：admin≠包跃）
  const ap = JSON.parse((await jj(`${API}/ws-v2/${mk.id}/approve`, 'POST', { approver: '系统管理员', role: 'ADMIN' }, tok)).body);
  ck('⑧ 批准归档', ap.status === 'ARCHIVED' && ap.archiveRef, `${ap.archiveRef}/plmSync=${ap.plmSync&&ap.plmSync.ok}`);

  // ⑨ PLM 侧确认
  const sheets = JSON.parse((await plm(`/v1/rd/sheets/spec?projectNo=${no}`, 'GET', null, tok)).body);
  const list = (sheets.data && (sheets.data.list || sheets.data.records)) || [];
  ck('⑨ PLM 表同步确认', Array.isArray(list) && list.some(r => String(r.model||'').includes('E2E-TEST') || String(r._archiveRef||'').includes(ap.archiveRef)));

  // ⑩ 节点联动确认
  const det2 = JSON.parse((await jj(API + '/projects/' + no + '?fresh=1', 'GET', null, tok)).body);
  const spec = det2.nodes.find(n => n.code === 'SPEC');
  ck('⑩ 节点联动 DONE', spec.status === 'DONE' && spec.ws && spec.ws.status === 'ARCHIVED');

  // ⑪ 异常检查
  ck('⑪ 数据一致性', det2.summary.done >= det.summary.done, `进度 ${det2.summary.done}/${det2.summary.total}`);

  // ⑫ 页面完整
  const pg = (await jj('/plm2')).body;
  ['我的智能体','当前异常','兼岗','制作'].forEach(k => ck('⑫ 页面含 ' + k, pg.includes(k)));

  // ⑬ PLM 06微系统模式
  const plmPg = (await req({ host: '127.0.0.1', port: 80, path: '/', method: 'GET' })).body;
  ck('⑬ PLM 06微系统嵌入', plmPg.length > 100);

  const total = Date.now() - t0;
  console.log(`\n===== M04 全链路自查 =====`);
  console.log(`通过: ${pass} | 失败: ${fail} | 总耗时: ${total}ms`);
  if (fail === 0) console.log('✅ 全链路 Green');
  else console.log('❌ 存在失败项');
  process.exit(fail ? 1 : 0);
})();
