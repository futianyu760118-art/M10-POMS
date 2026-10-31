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

  const page = await req({ host: '127.0.0.1', port: 4173, path: '/plm2', method: 'GET' });
  const html = page.body.toString('utf8');
  check('/plm2 页面 200 且含填工作表', page.status === 200 && html.includes('fillWorksheet') && html.includes('wsModal'));

  const types = await j(API + '/worksheet-types', 'GET');
  check('工作表类型 8 类 + 节点映射 18 项', types.status === 200 && types.data.defs.length === 8 && Object.keys(types.data.nodeMap).length === 18);

  const ws = await j(API + '/worksheets', 'POST', { projectNo: 'XM2026-002', nodeCode: 'RD_TRIAL', data: { trialType: '研发试产', qty: '30', defectRate: '2', conclusion: '通过' }, operator: '王栌鑫' });
  check('填报研发试产(通过) 201', ws.status === 201 && ws.data.nodeDone === true, '节点→' + ws.data.nodeStatus);

  const proj = await j(API + '/projects/XM2026-002', 'GET');
  const rd = proj.data.nodes.find(n => n.code === 'RD_TRIAL');
  check('项目节点 RD_TRIAL 已 DONE 且证据1份', rd.status === 'DONE' && rd.worksheetCount === 1);
  check('项目进度统计更新', proj.data.summary.done === 8, 'done=' + proj.data.summary.done + '/22');

  const bad = await j(API + '/worksheets', 'POST', { projectNo: 'XM2026-001', nodeCode: 'MOLD', data: { x: 1 } });
  check('无在线工作表节点 422', bad.status === 422);

  const hlcPage = await req({ host: '127.0.0.1', port: 4173, path: '/hlc', method: 'GET' });
  check('/hlc 双端页面仍 200', hlcPage.status === 200);

  console.log('\n工作表联动自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
