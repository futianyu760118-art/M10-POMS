const http = require('http');
function req(o, b) { return new Promise((res, rej) => { const r = http.request(o, x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c).toString('utf8') })); }); r.on('error', rej); if (b) r.write(b); r.end(); }); }
(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { ok ? (pass++, console.log('  [PASS] ' + n + (d ? ' | ' + d : ''))) : (fail++, console.log('  [FAIL] ' + n + (d ? ' | ' + d : ''))); };
  const API = '/api/v1/plm2';

  const login = await req({ host: '127.0.0.1', port: 4173, path: API + '/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ username: 'admin', password: '736669' }));
  const auth = JSON.parse(login.body);
  ck('登录成功', login.status === 200 && !!auth.token, auth.realName + '/' + auth.role);

  // 页面行为
  const pg = (await req({ host: '127.0.0.1', port: 4173, path: '/plm2' })).body;
  ck('导航无「我的概览」（工作台页不呈现）', !pg.includes('我的概览'));
  ck('默认页=我的待办（state.page:\'todos\'）', pg.includes("page:'todos'"));
  ck('登录后直达用户界面（bootAfterLogin 守卫）', pg.includes("if (!state.auth) { showLogin(); return; }"));
  ck('待办页为首页第一个导航', pg.indexOf('我的待办') < pg.indexOf('ECN 变更审批'));

  // 登录即映射到「本人」界面（/auth/me 返回 personId，前端 state.person 即用）
  const me = await req({ host: '127.0.0.1', port: 4173, path: API + '/auth/me', headers: { Authorization: 'Bearer ' + auth.token } });
  const meJ = JSON.parse(me.body);
  ck('/auth/me 返回本人 personId（界面按登录人呈现）', me.status === 200 && meJ.personId !== null && meJ.realName === auth.realName, 'person=' + meJ.personId + ' role=' + meJ.role);
  const todos = await req({ host: '127.0.0.1', port: 4173, path: API + '/me/todos?user=' + meJ.personId, headers: { Authorization: 'Bearer ' + auth.token } });
  const tj = JSON.parse(todos.body);
  ck('登录人待办接口可用（对应界面数据源）', todos.status === 200 && typeof tj.todoCount === 'number', 'todo=' + tj.todoCount + '/total=' + tj.total);

  console.log('\n登录直达自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
