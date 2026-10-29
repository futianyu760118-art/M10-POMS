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

  const ppl = await j(API + '/people', 'GET');
  const yu = (ppl.data.people || []).find(p => p.name === '虞周峰');
  check('真实人员 25 名', ppl.status === 200 && ppl.data.people.length === 25, '含虞周峰=' + !!yu);

  const prj = await j(API + '/projects', 'GET');
  check('真实项目 166 个', prj.status === 200 && prj.data.projects.length === 166);
  const first = prj.data.projects[0];
  check('项目含真实编号/负责人/门', /^HJ/.test(first.projectNo) && !!first.owner && !!first.gate, `${first.projectNo} ${first.gate} ${first.owner}`);

  const det = await j(API + '/projects/' + encodeURIComponent(first.projectNo), 'GET');
  check('项目详情 22 节点', det.status === 200 && det.data.nodes.length === 22, 'done=' + det.data.summary.done);
  check('状态标签已映射', !!det.data.statusLabel, det.data.statusLabel);

  const mat = await j(API + '/materials', 'GET');
  check('真实物料 40 个', mat.status === 200 && mat.data.materials.length === 40, mat.data.materials[0].partNo);

  const ecn = await j(API + '/ecns', 'GET');
  check('真实 ECN 导入', ecn.status === 200 && ecn.data.ecns.some(e => e.ecnNo === 'ECN202607310001'));

  const nw = await j(API + '/ecns', 'POST', { partNo: mat.data.materials[0].partNo, changeType: 'STRUCTURE', reason: '真实数据联调', applicant: '包跃' });
  check('创建 ECN 201/DRAFT', nw.status === 201 && nw.data.status === 'DRAFT', nw.data.ecnNo);

  if (yu) {
    const ov = await j(API + '/me/overview?user=' + yu.id, 'GET');
    check('虞周峰概览', ov.status === 200 && ov.data.user.name === '虞周峰', 'role=' + (ov.data.role || {}).code);
  }

  for (const p of ['/plm2', '/hlc', '/']) {
    const pg = await req({ host: '127.0.0.1', port: 4173, path: p, method: 'GET' });
    check('页面 ' + p + ' 200', pg.status === 200);
  }

  console.log('\n真实数据自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
