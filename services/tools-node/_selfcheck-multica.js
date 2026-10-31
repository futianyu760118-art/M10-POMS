const http = require('http');
function req(o, b) { return new Promise((res, rej) => { const r = http.request(o, x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c) })); }); r.on('error', rej); if (b) r.write(b); r.end(); }); }
async function j(p, m, pl) { const o = { host: '127.0.0.1', port: 4173, path: p, method: m || 'GET', headers: {} }; let b; if (pl) { b = JSON.stringify(pl); o.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }; } const r = await req(o, b); let d = null; try { d = JSON.parse(r.body.toString('utf8')); } catch (e) {} return { status: r.status, data: d }; }
(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { ok ? (pass++, console.log('  [PASS] ' + n + (d ? ' | ' + d : ''))) : (fail++, console.log('  [FAIL] ' + n + (d ? ' | ' + d : ''))); };
  const API = '/api/v1/plm2';
  const ppl = (await j(API + '/people')).data.people;
  const bao = ppl.find(p => p.name === '包跃');

  // 待办含无节点列表
  const t = (await j(API + '/me/todos?user=' + bao.id)).data;
  ck('待办接口含 none 列表字段', Array.isArray(t.none) && typeof t.noneCount === 'number', 'noneCount=' + t.noneCount);

  // 项目编辑
  const projects = (await j(API + '/projects')).data.projects;
  const pj = projects.find(p => p.owner === '包跃');
  const pe1 = await j(`${API}/projects/${encodeURIComponent(pj.projectNo)}/edit`, 'POST', { name: '测试改名', role: 'ENGINEER' });
  ck('工程师编辑项目被拒 403', pe1.status === 403);
  const pe2 = await j(`${API}/projects/${encodeURIComponent(pj.projectNo)}/edit`, 'POST', { owner: '孙周杰', gate: 'G2', risk: 'yellow', role: 'RD_LEAD' });
  ck('研发主管编辑项目生效', pe2.status === 200 && pe2.data.owner === '孙周杰' && pe2.data.gate === 'G2', 'owner→孙周杰');
  const pe3 = await j(`${API}/projects/${encodeURIComponent(pj.projectNo)}/edit`, 'POST', { owner: '包跃', role: 'RD_LEAD' });
  ck('恢复负责人', pe3.status === 200 && pe3.data.owner === '包跃');

  // 物料编辑
  const mats = (await j(API + '/materials')).data.materials;
  const m0 = mats[0];
  const me1 = await j(`${API}/materials/${encodeURIComponent(m0.partNo)}/edit`, 'POST', { name: '改名测试', role: 'SALES' });
  ck('销售编辑物料被拒 403', me1.status === 403);
  const me2 = await j(`${API}/materials/${encodeURIComponent(m0.partNo)}/edit`, 'POST', { name: m0.name, series: 'SZ-TEST', phase: 'MASS_PRODUCTION', role: 'ENGINEER' });
  ck('工程师编辑物料生效', me2.status === 200 && me2.data.series === 'SZ-TEST' && me2.data.phaseLabel === '量产');

  // 页面含 Multica 待办 + 编辑能力
  const plm = (await req({ host: '127.0.0.1', port: 4173, path: '/plm2', method: 'GET' })).body.toString('utf8');
  ['renderTodosView', 'setTodoScope', 'setTodoView', '指派给我', '我负责的项目', '看板', 'openPrjEdit', 'openMatEdit', 'matModal', 'prjModal'].forEach(k => ck('页面含：' + k, plm.includes(k)));

  console.log('\nMultica待办+全内容可编辑自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
