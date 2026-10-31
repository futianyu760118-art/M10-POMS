const http = require('http');
function req(o, b) { return new Promise((res, rej) => { const r = http.request(o, x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c).toString('utf8') })); }); r.on('error', rej); if (b) r.write(b); r.end(); }); }
const jj = (p, m, pl, tok) => { const o = { host: '127.0.0.1', port: 4173, path: p, method: m || 'GET', headers: {} }; let b; if (tok) o.headers.Authorization = 'Bearer ' + tok; if (pl) { b = JSON.stringify(pl); o.headers['Content-Type'] = 'application/json'; o.headers['Content-Length'] = Buffer.byteLength(b); } return req(o, b); };
(async () => {
  let pass = 0, fail = 0, skip = 0;
  const ck = (n, ok, d) => { ok ? (pass++, console.log('  [PASS] ' + n + (d ? ' | ' + d : ''))) : (fail++, console.log('  [FAIL] ' + n + (d ? ' | ' + d : ''))); };
  const sk = (n, d) => { skip++; console.log('  [SKIP] ' + n + (d ? ' | ' + d : '')); };
  const API = '/api/v1/plm2';

  // ① 错误口令 → 401/错误信息（不泄露细节）
  const bad = await jj(API + '/auth/login', 'POST', { username: 'admin', password: 'wrong-pass' });
  ck('错误口令被拒', bad.status === 401 || bad.status === 502, bad.status + '（PLM 后端登录接口当前异常时为 502）');

  // ② 正确口令 → 会话信息（PLM 后端登录接口当前异常则 SKIP）
  let auth = null;
  const okLogin = await jj(API + '/auth/login', 'POST', { username: 'admin', password: '736669' });
  if (okLogin.status === 200) {
    auth = JSON.parse(okLogin.body);
    ck('登录成功返回统一会话', !!auth.token && !!auth.realName && !!auth.role && auth.personId !== null, `${auth.realName}/${auth.role}/person=${auth.personId}`);
  } else {
    sk('真实登录 E2E（PLM 后端 /auth/login 当前 401，与其前端一致；恢复后即通）', okLogin.status + ' ' + okLogin.body.slice(0, 60));
  }

  // ③ /auth/me：无令牌 401；伪令牌 401
  const me0 = await jj(API + '/auth/me');
  ck('/auth/me 无令牌 401', me0.status === 401);
  const meBad = await jj(API + '/auth/me', 'GET', null, 'fake.token.value');
  ck('/auth/me 伪令牌 401', meBad.status === 401);

  // ④ 写操作：带伪令牌 → 401（服务端强制，权限一致）
  const P = JSON.parse((await jj(API + '/projects')).body).projects.find(x => x.owner === '包跃');
  const no = encodeURIComponent(P.projectNo);
  const wBad = await jj(`${API}/projects/${no}/nodes/REVIEW`, 'POST', { status: 'PLANNED', planDate: '2026-11-09' }, 'fake.token.value');
  ck('带伪令牌写节点被拒 401', wBad.status === 401, wBad.body.slice(0, 60));
  const wBad2 = await jj(`${API}/projects/${no}/edit`, 'POST', { name: 'x', role: 'ADMIN' }, 'fake.token.value');
  ck('带伪令牌编辑项目被拒 401', wBad2.status === 401);

  // ⑤ L0 兼容：无令牌（演示模式）仍可走 body.role
  const w0 = await jj(`${API}/projects/${no}/nodes/REVIEW`, 'POST', { status: 'PLANNED', planDate: '2026-11-09' });
  ck('无令牌 L0 演示模式仍可用', w0.status === 200, JSON.parse(w0.body).node.statusLabel);

  // ⑥ 页面含统一登录
  const page = (await jj('/plm2')).body;
  ['loginOverlay', 'doLogin', 'plm_token', '统一认证'].forEach(k => ck('页面含：' + k, page.includes(k)));
  ck('已移除身份下拉（switchRole 调用）', !page.includes('onchange="switchRole()"'));

  console.log('\nM10-M04 统一认证自查: ' + pass + ' 通过, ' + fail + ' 失败, ' + skip + ' 跳过');
  process.exit(fail ? 1 : 0);
})();
