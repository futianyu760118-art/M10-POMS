const http = require('http');
function req(o, b) { return new Promise((res, rej) => { const r = http.request(o, x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c) })); }); r.on('error', rej); if (b) r.write(b); r.end(); }); }
async function j(p, m, pl) { const o = { host: '127.0.0.1', port: 4173, path: p, method: m || 'GET', headers: {} }; let b; if (pl) { b = JSON.stringify(pl); o.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }; } const r = await req(o, b); let d = null; try { d = JSON.parse(r.body.toString('utf8')); } catch (e) {} return { status: r.status, data: d }; }
(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { ok ? (pass++, console.log('  [PASS] ' + n + (d ? ' | ' + d : ''))) : (fail++, console.log('  [FAIL] ' + n + (d ? ' | ' + d : ''))); };
  const API = '/api/v1/plm2';
  const today = new Date().toISOString().slice(0, 10);

  const projects = (await j(API + '/projects')).data.projects;
  const cand = projects.find(p => p.owner === '包跃');
  const det0 = (await j(API + '/projects/' + encodeURIComponent(cand.projectNo))).data;
  const n0 = det0.nodes.find(x => x.code === 'SPEC');
  ck('节点行含新字段（责任人默认/交付物默认/状态标签）', n0.owner === cand.owner && !!n0.deliveryDesc && !!n0.statusLabel, `${n0.owner} · ${n0.deliveryDesc}`);

  const bad = await j(`${API}/projects/${encodeURIComponent(cand.projectNo)}/nodes/RD_TRIAL`, 'POST', { status: 'IN_PROGRESS' });
  ck('待办无计划日 422', bad.status === 422, bad.data.error);

  const ok = await j(`${API}/projects/${encodeURIComponent(cand.projectNo)}/nodes/RD_TRIAL`, 'POST', { status: 'PLANNED', planDate: '2026-10-30' });
  ck('已计划+计划日保存', ok.status === 200 && ok.data.node.status === 'PLANNED' && ok.data.node.planDate === '2026-10-30');

  const doneClr = await j(`${API}/projects/${encodeURIComponent(cand.projectNo)}/nodes/RD_TRIAL`, 'POST', { status: 'NOT_SET', actualDate: '' });
  const done = await j(`${API}/projects/${encodeURIComponent(cand.projectNo)}/nodes/RD_TRIAL`, 'POST', { status: 'DONE' });
  ck('DONE 自动实际日=当天', done.status === 200 && done.data.node.actualDate === today, done.data.node.actualDate);

  const assign = await j(`${API}/projects/${encodeURIComponent(cand.projectNo)}/nodes/SPEC`, 'POST', { owner: '王栌鑫' });
  ck('责任人指派覆盖默认', assign.data.node.owner === '王栌鑫' && assign.data.node.ownerAssigned === true);

  const tB = (await j(API + '/me/todos?user=' + (await j(API + '/people')).data.people.find(p => p.name === '包跃').id)).data;
  const nsTarget = det0.nodes.find(x => x.status === 'NOT_SET');
  const noneR = await j(`${API}/projects/${encodeURIComponent(cand.projectNo)}/nodes/${nsTarget.code}`, 'POST', { status: 'NONE' });
  const tA = (await j(API + '/me/todos?user=' + (await j(API + '/people')).data.people.find(p => p.name === '包跃').id)).data;
  ck('无节点不计入待办（接口级）', tA.todoCount === tB.todoCount - 1 && tA.noneCount === tB.noneCount + 1, `${nsTarget.code}: ${tB.todoCount}→${tA.todoCount}`);

  const plm = (await req({ host: '127.0.0.1', port: 4173, path: '/plm2', method: 'GET' })).body.toString('utf8');
  ['无节点', '✔确认', 'ndModal', 'editNode', '交付物', '计划日期（待办类状态必填）', '责任人（默认项目负责人'].forEach(k => ck('页面含：' + k, plm.includes(k)));

  console.log('\n项目明细表自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
