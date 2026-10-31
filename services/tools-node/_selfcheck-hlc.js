const http = require('http');

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
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

  const B = '/api/v1/hlc';
  // 1. 人员为真实姓名
  const people = await j(B + '/people', 'GET');
  const names = (people.data.people || []).map(p => p.name).join(',');
  check('人员为真实数据', people.status === 200 && names.includes('包跃') && names.includes('马雅雯'), names);

  // 2. 页面
  const page = await req({ host: '127.0.0.1', port: 4173, path: '/hlc', method: 'GET' });
  const html = page.body.toString('utf8');
  check('/hlc 页面 200', page.status === 200);
  check('页面含双端导航与状态机', html.includes('总览工作台') && html.includes('我的申请') && html.includes('AWAITING_ACCEPTANCE'));

  // 3. 员工(包跃 p-001)创建报修 → SUBMITTED
  const created = await j(B + '/service-requests', 'POST', { type: 'logistics_repair', subject: '车间照明灯故障', description: '演示闭环', requester: 'p-001', idempotency_key: 'ik-hlc-e2e-1' });
  check('创建报修 201/SUBMITTED', created.status === 201 && created.data.state === 'SUBMITTED', created.data.id);
  const id = created.data.id;

  // 4. 越权：员工直接验收应失败（当前非待验收，必 409/403）
  const bad = await j(`${B}/service-requests/${id}/transitions`, 'POST', { next_state: 'CLOSED', actor: 'p-001', verifier: 'p-001' });
  check('员工跳步被拒', bad.status === 409 || bad.status === 403, 'HTTP ' + bad.status);

  // 5. HR(马雅雯 p-002)受理→分派→处理
  const t1 = await j(`${B}/service-requests/${id}/transitions`, 'POST', { next_state: 'TRIAGED', actor: 'p-002' });
  check('受理 TRIAGED', t1.status === 200 && t1.data.state === 'TRIAGED');
  const t2 = await j(`${B}/service-requests/${id}/transitions`, 'POST', { next_state: 'ASSIGNED', actor: 'p-002', assignee: 'p-002', sla: '今日' });
  check('分派 ASSIGNED', t2.status === 200 && t2.data.state === 'ASSIGNED');
  const t3 = await j(`${B}/service-requests/${id}/transitions`, 'POST', { next_state: 'IN_PROGRESS', actor: 'p-002' });
  check('开始处理 IN_PROGRESS', t3.status === 200 && t3.data.state === 'IN_PROGRESS');
  const t4 = await j(`${B}/service-requests/${id}/transitions`, 'POST', { next_state: 'AWAITING_ACCEPTANCE', actor: 'p-002', evidence_ref: 'EVD-2601' });
  check('处理完成(留证) AWAITING', t4.status === 200 && t4.data.state === 'AWAITING_ACCEPTANCE');

  // 6. done≠verified：执行者自验 403
  const self = await j(`${B}/service-requests/${id}/transitions`, 'POST', { next_state: 'CLOSED', actor: 'p-002', verifier: 'p-002' });
  check('执行者自验被拒 403', self.status === 403, (self.data || {}).error || '');

  // 7. 验收人(王栌鑫 p-003)关闭 → ResultRef
  const t5 = await j(`${B}/service-requests/${id}/transitions`, 'POST', { next_state: 'CLOSED', actor: 'p-003', verifier: 'p-003' });
  check('验收人关闭 CLOSED', t5.status === 200 && t5.data.state === 'CLOSED', t5.data.result_ref);

  // 8. 员工查看结果
  const results = await j('/api/v1/poms/me/results?person_id=p-001', 'GET');
  const mine = (results.data.results || []).find(r => r.source_object_id === id);
  check('M10 过去报告可见该结果', !!mine && mine.verification === 'verified');

  console.log('\n双端闭环自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
