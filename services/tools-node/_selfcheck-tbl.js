const http = require('http');
function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c) })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
async function j(path, method, payload) {
  const opts = { host: '127.0.0.1', port: 4173, path, method, headers: {} };
  let body;
  if (payload) { body = JSON.stringify(payload); opts.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }; }
  const r = await req(opts, body);
  let data = null; try { data = JSON.parse(r.body.toString('utf8')); } catch (e) {}
  return { status: r.status, data };
}
(async () => {
  let pass = 0, fail = 0;
  const check = (n, ok, d) => { ok ? (pass++, console.log('  [PASS] ' + n + (d ? ' | ' + d : ''))) : (fail++, console.log('  [FAIL] ' + n + (d ? ' | ' + d : ''))); };
  const API = '/api/v1/plm2';

  // 页面含表格组件与停用
  const plm = (await req({ host: '127.0.0.1', port: 4173, path: '/plm2', method: 'GET' })).body.toString('utf8');
  ['tblRender', 'tblSearch', 'tblFilter', 'tblSort', '停用</button>', '启用</button>', '作废</button>', '与真实 PLM 个人模块核对'].forEach(k => check('页面含：' + k, plm.includes(k)));

  // 项目停用/启用（ADMIN）
  const prj = (await j(API + '/projects', 'GET')).data.projects;
  const active = prj.find(p => p.status === 'ACTIVE');
  const deny = await j(`${API}/projects/${encodeURIComponent(active.projectNo)}/status`, 'POST', { status: 'ON_HOLD', role: 'ENGINEER' });
  check('工程师停用被拒 403', deny.status === 403, (deny.data || {}).error || '');
  const off = await j(`${API}/projects/${encodeURIComponent(active.projectNo)}/status`, 'POST', { status: 'ON_HOLD', role: 'ADMIN' });
  check('ADMIN 停用项目 → ON_HOLD', off.status === 200 && off.data.status === 'ON_HOLD');
  const on = await j(`${API}/projects/${encodeURIComponent(active.projectNo)}/status`, 'POST', { status: 'ACTIVE', role: 'RD_LEAD' });
  check('研发主管启用 → ACTIVE', on.status === 200 && on.data.status === 'ACTIVE');
  const bad = await j(`${API}/projects/${encodeURIComponent(active.projectNo)}/status`, 'POST', { status: 'ACTIVE', role: 'ADMIN' });
  check('非法流转被拒 409（ACTIVE→ACTIVE）', bad.status === 409);

  // ECN 作废（DRAFT→VOID）
  const mat0 = (await j(API + '/materials', 'GET')).data.materials[0];
  const ne = await j(API + '/ecns', 'POST', { partNo: mat0.partNo, changeType: 'BOM', applicant: '包跃' });
  const vo = await j(`${API}/ecns/${ne.data.ecnNo}/transition`, 'POST', { action: 'void', role: 'ENGINEER' });
  check('ECN 草稿作废 → VOID', vo.status === 200 && vo.data.to === 'VOID');

  // 个人模块对齐（虞周峰：项目 20 个）
  const ppl = (await j(API + '/people', 'GET')).data.people;
  const yu = ppl.find(p => p.name === '虞周峰');
  const ov = (await j(API + '/me/overview?user=' + yu.id, 'GET')).data;
  check('虞周峰 我的项目=20（真实口径）', ov.projects.total === 20, 'active=' + ov.projects.active);
  check('含真实证据/反馈统计', ov.evidence >= 0 && typeof ov.feedback === 'number', `evidence=${ov.evidence} feedback=${ov.feedback}`);
  check('含 nodes/projects/todos 结构', !!ov.nodes && !!ov.projects && !!ov.todos);
  const bao = ppl.find(p => p.name === '包跃');
  const ovb = (await j(API + '/me/overview?user=' + bao.id, 'GET')).data;
  check('包跃 我的项目=82、证据=25（真实）', ovb.projects.total === 82 && ovb.evidence === 25, `proj=${ovb.projects.total} ev=${ovb.evidence}`);

  console.log('\n表格能力+个人模块核对自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
