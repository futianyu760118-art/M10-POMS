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

  // 门户与路由
  const portal = await req({ host: '127.0.0.1', port: 4173, path: '/', method: 'GET' });
  const ph = portal.body.toString('utf8');
  check('门户为根页面', portal.status === 200 && ph.includes('AEOS 统一门户'), '');
  ['PLM 研发自治中心', 'HLC 人力后勤自治中心', 'CRM 销售自治中心', 'SCP 供应链协同', 'FAC 财经自治中心', 'EDP 数据证据平台', 'Hub 智能体中心', 'EBMS'].forEach(s => check('门户含系统：' + s, ph.includes(s)));
  const org = await req({ host: '127.0.0.1', port: 4173, path: '/org', method: 'GET' });
  check('岗位装配挪至 /org 且 200', org.status === 200 && org.body.toString('utf8').includes('岗位自动装配'));

  // 工序按人员联动（API 层）
  const API = '/api/v1/plm2';
  const routes = await j(API + '/process-routes', 'GET');
  const rt = (routes.data.routes || [])[0];
  check('工序路线存在', routes.status === 200 && !!rt, rt && rt.routeNo);
  const active = rt.steps.find(s => s.status === 'ACTIVE');
  check('存在进行中工序', !!active, active.owner + ' · ' + active.name);

  const wrong = await j(`${API}/process-routes/${rt.routeNo}/steps/${active.order}/complete`, 'POST', { operator: '王栌鑫' });
  check('非负责人完成被拒 403', wrong.status === 403, (wrong.data || {}).error || '');

  const okc = await j(`${API}/process-routes/${rt.routeNo}/steps/${active.order}/complete`, 'POST', { operator: active.owner, remark: '自查' });
  check('负责人完成成功并推送下一道', okc.status === 200 && okc.data.event === 'PROCESS_STEP_PUSHED', 'next=' + okc.data.nextOwner);

  const rt2 = (await j(API + '/process-routes', 'GET')).data.routes[0];
  check('下一道已激活', rt2.steps.find(s => s.order === active.order).status === 'DONE' && rt2.steps.find(s => s.order === active.order + 1).status === 'ACTIVE');

  // 页面含联动逻辑
  const plm = await req({ host: '127.0.0.1', port: 4173, path: '/plm2', method: 'GET' });
  check('/plm2 含工序联动（我的工序/完成本道）', plm.body.toString('utf8').includes('completeStep') && plm.body.toString('utf8').includes('我的工序'));

  console.log('\n门户+工序联动自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
