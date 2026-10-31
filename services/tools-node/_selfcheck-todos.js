const http = require('http');
function req(o, b) { return new Promise((res, rej) => { const r = http.request(o, x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c) })); }); r.on('error', rej); if (b) r.write(b); r.end(); }); }
async function j(p, m, pl) { const o = { host: '127.0.0.1', port: 4173, path: p, method: m || 'GET', headers: {} }; let b; if (pl) { b = JSON.stringify(pl); o.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }; } const r = await req(o, b); let d = null; try { d = JSON.parse(r.body.toString('utf8')); } catch (e) {} return { status: r.status, data: d }; }
(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { ok ? (pass++, console.log('  [PASS] ' + n + (d ? ' | ' + d : ''))) : (fail++, console.log('  [FAIL] ' + n + (d ? ' | ' + d : ''))); };
  const API = '/api/v1/plm2';
  const ppl = (await j(API + '/people')).data.people;
  const bao = ppl.find(p => p.name === '包跃'), yu = ppl.find(p => p.name === '虞周峰');

  // 与真实库对账（DB 实测：包跃 0/1630/174；虞周峰 0/438/2）
  const tb = (await j(API + '/me/todos?user=' + bao.id)).data;
  ck('包跃待办与真实库一致', tb.overdueCount === 0 && tb.todoCount === 1630 && tb.doneCount === 174, `逾期${tb.overdueCount}/待办${tb.todoCount}/完成${tb.doneCount}`);
  ck('包跃待办含项目字段', tb.todo.length > 0 && !!tb.todo[0].projectNo && !!tb.todo[0].nodeName, tb.todo[0].projectNo + ' · ' + tb.todo[0].nodeName);
  const ty = (await j(API + '/me/todos?user=' + yu.id)).data;
  ck('虞周峰待办与真实库一致', ty.todoCount === 438 && ty.doneCount === 2, `待办${ty.todoCount}/完成${ty.doneCount}`);

  const dy = (await j(API + '/me/dept-todos?user=' + yu.id)).data;
  ck('虞周峰部门待办 scope=DEPT 含研发中心', dy.scope === 'DEPT' && dy.departments.some(d => d.deptName === '研发中心'), '部门数 ' + dy.departments.length);
  const rd = dy.departments.find(d => d.deptName === '研发中心');
  ck('研发中心聚合含成员明细', rd.members.length > 0 && rd.members.every(m => typeof m.todoCount === 'number'), '成员 ' + rd.members.length + ' 人');
  const db2 = (await j(API + '/me/dept-todos?user=' + bao.id)).data;
  ck('包跃部门待办 scope=SELF', db2.scope === 'SELF');

  const ov = (await j(API + '/me/overview?user=' + bao.id)).data;
  ck('overview 含 todosModule 且=1630/174', ov.todosModule && ov.todosModule.todoCount === 1630 && ov.todosModule.doneCount === 174);

  const plm = (await req({ host: '127.0.0.1', port: 4173, path: '/plm2', method: 'GET' })).body.toString('utf8');
  ck('页面含 PLM 待办模块与部门聚合', plm.includes('me/todos') && plm.includes('dept-todos') && plm.includes('逾期'));

  console.log('\nPLM 我的待办模块自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
