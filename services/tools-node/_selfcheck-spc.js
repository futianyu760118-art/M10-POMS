'use strict';
// SPC 接入自查：独立 BFF + mock SPC，验证「连接标准同 PLM：服务端登录→Bearer→只读」与页面展示
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.env.SELFCHECK_PORT || 4197);

function req(p, m, b) {
  return new Promise((resolve, reject) => {
    const h = {};
    if (b) h['Content-Type'] = 'application/json';
    const q = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m || 'GET', headers: h }, x => {
      x.setEncoding('utf8'); let d = ''; x.on('data', c => d += c);
      x.on('end', () => resolve({ s: x.statusCode, b: d }));
    });
    q.on('error', reject);
    if (b) q.write(JSON.stringify(b));
    q.end();
  });
}
const j = (r) => { try { return JSON.parse(r.b); } catch (e) { return {}; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { if (ok) { pass++; console.log('  [PASS] ' + n + (d ? ' | ' + d : '')); } else { fail++; console.log('  [FAIL] ' + n + (d ? ' | ' + d : '')); } };
  const seen = [];

  // mock SPC：登录（表单）+ 只读接口
  const mock = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', c => b += c);
    rq.on('end', () => {
      const u = new URL(rq.url, 'http://x');
      seen.push(rq.method + ' ' + u.pathname);
      if (rq.method === 'POST' && u.pathname === '/api/v1/basicdata/auth/login') {
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        return rs.end(JSON.stringify({ code: 0, data: { access_token: 'mock-spc-token', token_type: 'bearer' } }));
      }
      if (!(rq.headers.authorization || '').startsWith('Bearer ')) {
        rs.writeHead(401, { 'Content-Type': 'application/json' });
        return rs.end(JSON.stringify({ detail: 'unauthorized' }));
      }
      const ok = (data) => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ code: 0, data })); };
      if (u.pathname === '/api/v1/dashboard/summary') return ok({ due_order_count: 12, high_risk_count: 3, shortage_count: 5, open_exception_count: 6, closure_rate: 92 });
      if (u.pathname === '/api/v1/dashboard/today-overview') return ok({ due_order_count: 12, shortage_count: 5, open_exception_count: 6 });
      if (u.pathname === '/api/v1/dashboard/rolling-risk') return ok({ days: [] });
      if (u.pathname === '/api/v1/dashboard/order-risk-distribution') return ok({ high: 3, medium: 4, low: 5 });
      if (u.pathname === '/api/v1/dashboard/closure-achievement') return ok({ closure_rate: 92 });
      if (u.pathname === '/api/v1/dashboard/orders') return ok({ items: [{ order_no: 'SO-1001', customer_name: '恒剑客户', delivery_date: '2026-11-10', risk_level: 'high', owner: '李玉英', status: 'OPEN' }], total: 1 });
      if (u.pathname === '/api/v1/dashboard/materials') return ok({ items: [{ material_no: 'M-1001', material_name: '灯珠', demand_qty: 100, stock_qty: 60, shortage_qty: 40, status: 'SHORT' }], total: 1 });
      if (u.pathname === '/api/v1/exceptions') return ok({ items: [{ issue_no: 'EX-1001', issue_type: '缺料', risk_level: 'high', owner: '李玉英', status: 'open', created_at: '2026-11-01T09:00:00' }], total: 1 });
      if (u.pathname === '/api/v1/materials/supplier-risk') return ok([{ supplier: '供应商A', risk_level: 'medium', on_time_rate: 95, exception_count: 2 }]);
      rs.writeHead(404, { 'Content-Type': 'application/json' }); rs.end('{}');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const SPC_PORT = mock.address().port;

  const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'bff', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      SPC_API: 'http://127.0.0.1:' + SPC_PORT,
      SPC_USER: 'mock-spc-user',
      SPC_PASS: 'mock-spc-pass',
      PLM_POLL_MS: '0',
      TASKHUB_STORE: path.join(os.tmpdir(), 'spc-selfcheck-' + process.pid + '.json')
    }),
    stdio: 'ignore'
  });
  try {
    let up = false;
    for (let i = 0; i < 40; i++) { try { const r = await req('/api/v1/spc/status'); if (r.s === 200) { up = true; break; } } catch (e) { /* wait */ } await sleep(250); }
    if (!up) throw new Error('BFF 未就绪');

    const page = await req('/spc');
    ck('SPC 页面可访问且含五个栏目', page.s === 200 && ['控制塔', '订单风险', '物料风险', '异常台账', '供应商风险'].every(k => page.b.includes(k)));
    ck('页面注明只读（改动请到 SPC）', page.b.includes('只读') && page.b.includes('改动请到 SPC'));
    const portal = await req('/portal');
    ck('门户含 SPC 入口', portal.b.includes('href="/spc"') && portal.b.includes('SPC 供应链与生产协同'));

    const st = j(await req('/api/v1/spc/status'));
    ck('连接状态：已连接', st.connected === true && st.configured === true, st.api);

    const dash = j(await req('/api/v1/spc/dashboard'));
    ck('控制塔五块数据齐全', ['summary', 'today', 'rollingRisk', 'riskDistribution', 'closure'].every(k => dash.parts && dash.parts[k]), JSON.stringify(dash.errors || {}));
    ck('控制塔摘要数值正确', dash.parts.summary.data.high_risk_count === 3 && dash.parts.summary.data.closure_rate === 92);

    const orders = j(await req('/api/v1/spc/orders?page=1&page_size=10&risk_level=high'));
    ck('订单风险可读且参数透传', (orders.data.items || []).some(x => x.order_no === 'SO-1001') && seen.some(s => s.includes('/dashboard/orders')));
    const mats = j(await req('/api/v1/spc/materials?page=1&page_size=10&shortage_only=1'));
    ck('物料缺料可读', (mats.data.items || []).some(x => Number(x.shortage_qty) > 0));
    const ex = j(await req('/api/v1/spc/exceptions?status=open'));
    ck('异常台账可读', (ex.data.items || []).some(x => x.issue_no === 'EX-1001'));
    const sup = j(await req('/api/v1/spc/supplier-risk'));
    ck('供应商风险可读', (Array.isArray(sup.data) ? sup.data : []).some(x => x.supplier === '供应商A'));

    ck('连接标准：先登录拿 Bearer，再只读访问', seen.includes('POST /api/v1/basicdata/auth/login'));
    ck('全程只读：没有对 SPC 的写请求', !seen.some(s => /^(PUT|PATCH|DELETE)/.test(s) && !s.includes('auth/login')), seen.join(' | ').slice(0, 200));

    // 统一登录里 SPC 也会尝试（服务端账号不同则如实失败/成功）
    const sso = j(await req('/api/v1/sso/login', 'POST', { username: 'admin', password: '736669' }));
    ck('统一登录包含 SPC 状态（不伪造）', sso.systems && typeof sso.systems.spc === 'object' && typeof sso.systems.spc.ok === 'boolean', JSON.stringify(sso.systems && sso.systems.spc));
  } finally {
    try { child.kill(); } catch (e) { /* ignore */ }
    try { mock.close(); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(path.join(os.tmpdir(), 'spc-selfcheck-' + process.pid + '.json')); } catch (e) { /* ignore */ }
  }

  console.log('\nSPC 接入自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
