'use strict';
// 人员变动（离职/调岗）自查：M07 提交 → M01 办理；高风险需人工确认；页面（PC/微信同页）与权限
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.env.SELFCHECK_PORT || 4196);
const ACTOR = '系统管理员';

let COOKIE = '';
function req(p, m, b) {
  return new Promise((resolve, reject) => {
    const h = {};
    if (b) h['Content-Type'] = 'application/json';
    if (COOKIE) h.Cookie = COOKIE;
    const q = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m || 'GET', headers: h }, x => {
      x.setEncoding('utf8'); let d = ''; x.on('data', c => d += c);
      x.on('end', () => resolve({ s: x.statusCode, b: d, h: x.headers }));
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
  const hlcWrites = [], m01Writes = [];

  // mock M07（HLC 人事）
  const hlc = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', c => b += c);
    rq.on('end', () => {
      const u = new URL(rq.url, 'http://x');
      const ok = (data) => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(data)); };
      if (rq.method === 'POST' && u.pathname === '/api/auth/login') return ok({ token: 'hlc-mock' });
      if (rq.method === 'GET' && u.pathname === '/api/hrm/departments') return ok({ items: [{ id: 'd1', name: '研发部' }], total: 1 });
      if (rq.method === 'GET' && u.pathname === '/api/hrm/positions') return ok({ items: [{ id: 'pos1', name: '研发工程师' }], total: 1 });
      if (rq.method === 'GET' && u.pathname === '/api/hrm/employees') return ok({ items: [{ id: 'e1', name: '张三', employee_no: 'E001', job_title: '研发工程师', department_id: 'd1', position_id: 'pos1', status: 'active' }], total: 1 });
      if (rq.method === 'GET' && u.pathname === '/api/hrm/resignations') return ok({ items: [{ id: 'r1', employeeId: 'e1', employee: { name: '张三', employee_no: 'E001', job_title: '研发工程师', department_id: 'd1', position_id: 'pos1' }, applyDate: '2026-11-01', expectedLeaveDate: '2026-11-30', reason: '个人原因', handoverItems: '资料与客户交接', status: 'submitted' }], total: 1 });
      if (rq.method === 'GET' && u.pathname === '/api/hrm/employee-changes') return ok({ items: [], total: 0 });
      if (rq.method === 'POST' && u.pathname === '/api/hrm/resignations') { hlcWrites.push({ kind: 'create', body: JSON.parse(b || '{}') }); return ok({ id: 'r-new' }); }
      if (rq.method === 'POST' && u.pathname === '/api/hrm/resignations/r-new/submit') { hlcWrites.push({ kind: 'submit' }); return ok({ ok: true, status: 'submitted' }); }
      if (rq.method === 'GET' && u.pathname === '/api/hrm/approvals/pending') return ok([{ id: 'a1', businessType: 'resignation', title: '张三 离职申请', applicantName: '马雅雯', createdAt: '2026-11-01T10:00:00' }]);
      if (rq.method === 'POST' && u.pathname === '/api/hrm/approvals/a1/approve') { hlcWrites.push({ kind: 'approve' }); return ok({ ok: true }); }
      rs.writeHead(404, { 'Content-Type': 'application/json' }); rs.end('{}');
    });
  });
  await new Promise(r => hlc.listen(0, '127.0.0.1', r));

  // mock M01（身份内核）
  const m01 = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', c => b += c);
    rq.on('end', () => {
      const u = new URL(rq.url, 'http://x');
      const ok = (data, headers) => { rs.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, headers || {})); rs.end(JSON.stringify(data)); };
      if (rq.method === 'POST' && u.pathname === '/auth/demo/login') return ok({ logged_in: true }, { 'Set-Cookie': 'm01_demo_session=mock; HttpOnly; Path=/' });
      if (rq.method === 'GET' && u.pathname === '/kernel/v1/status') {
        return ok({ master: { agent_id: 'A_MASTER', tenant_id: 'TENANT_A', status: 'active' }, persons: [{ person_id: 'P1', tenant_id: 'TENANT_A', profile: { display_name: '张三', employee_code: 'E001' }, status: 'active' }], approvals: [] });
      }
      if (rq.method === 'POST' && u.pathname === '/kernel/v1/quick/person-action') {
        const body = JSON.parse(b || '{}');
        m01Writes.push({ body });
        return ok({ ok: true, decision: 'EXECUTED', trace_id: 't1', approval: null });
      }
      rs.writeHead(404, { 'Content-Type': 'application/json' }); rs.end('{}');
    });
  });
  await new Promise(r => m01.listen(0, '127.0.0.1', r));

  const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'bff', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      HLC_API: 'http://127.0.0.1:' + hlc.address().port,
      M01_API: 'http://127.0.0.1:' + m01.address().port,
      PLM_POLL_MS: '0',
      TASKHUB_STORE: path.join(os.tmpdir(), 'personnel-selfcheck-' + process.pid + '.json')
    }),
    stdio: 'ignore'
  });
  try {
    let up = false;
    for (let i = 0; i < 40; i++) { try { const r = await req('/api/v1/mobile/me'); if (r.s === 200) { up = true; break; } } catch (e) { /* wait */ } await sleep(250); }
    if (!up) throw new Error('BFF 未就绪');

    const denied = await req('/api/v1/personnel/status');
    ck('未登录不呈现人员变动（401）', denied.s === 401);
    const bind = await req('/api/v1/mobile/bind', 'POST', { phone: '13900000009', username: 'admin', password: '736669' });
    COOKIE = ((bind.h['set-cookie'] || [''])[0] || '').split(';')[0];
    ck('人事/管理员登录后可访问', bind.s === 200 && !!COOKIE);

    const page = await req('/personnel');
    ck('人员变动页可访问（离职/M01 办理/明细）', page.s === 200 && ['离职申请', 'M01 办理', '交接事项', '微信'].every(k => page.b.includes(k)));
    const wx = await req('/wechat');
    ck('微信入口页可访问（同微系统）', wx.s === 200 && wx.b.includes('微信') && wx.b.includes('/m'));
    const mpage = await req('/m');
    ck('手机端按本人角色显示人事入口与工具', mpage.b.includes('personnelLink') && mpage.b.includes('function isHr') && mpage.b.includes('ROLE_PROFILE') && mpage.b.includes('p.tools.includes'));

    const st = j(await req('/api/v1/personnel/status'));
    ck('M07 / M01 均已连接', st.m07 && st.m07.ok === true && st.m01 && st.m01.ok === true);

    const ch = j(await req('/api/v1/personnel/changes'));
    const r1 = (ch.resignations || [])[0] || {};
    ck('离职申请带岗位/部门/交接信息', r1.employeeName === '张三' && r1.jobTitle === '研发工程师' && r1.deptName === '研发部' && !!r1.handoverItems, r1.jobTitle + ' / ' + r1.deptName);
    ck('员工可选（新建离职用）', (j(await req('/api/v1/personnel/employees')).items || []).some(e => e.id === 'e1' && e.jobTitle === '研发工程师'));

    const created = await req('/api/v1/personnel/resignations', 'POST', { employeeId: 'e1', reason: '个人原因', handoverItems: '资料交接', actor: ACTOR });
    ck('在 M07 提交离职成功（含岗位交接）', created.s === 201 && hlcWrites.some(w => w.kind === 'create' && w.body.employeeId === 'e1' && w.body.reason === '个人原因'));
    ck('提交后自动进入审批（工作流）', hlcWrites.some(w => w.kind === 'submit'), hlcWrites.map(w => w.kind).join(','));
    const noActor = await req('/api/v1/personnel/resignations', 'POST', { employeeId: 'e1', reason: 'x' });
    ck('无操作人不得提交（403）', noActor.s === 403);

    const appr = j(await req('/api/v1/personnel/approvals'));
    ck('待审批可读', (appr.items || []).some(a => a.id === 'a1'));
    const ap = await req('/api/v1/personnel/approvals/a1/approve', 'POST', { actor: ACTOR });
    ck('审批操作走 M07 且留操作人', ap.s === 200 && hlcWrites.some(w => w.kind === 'approve'));

    const persons = j(await req('/api/v1/personnel/m01/persons'));
    ck('M01 人员可读', (persons.persons || []).some(p => p.personId === 'P1' && p.name === '张三'));

    const noConfirm = await req('/api/v1/personnel/m01/handle', 'POST', { personId: 'P1', action: 'offboard', actor: ACTOR });
    ck('M01 办理未确认被拒（428）且未调用 M01', noConfirm.s === 428 && m01Writes.length === 0, j(noConfirm).error);
    const handled = await req('/api/v1/personnel/m01/handle', 'POST', { personId: 'P1', action: 'offboard', confirm: true, actor: ACTOR });
    ck('人工确认后在 M01 办理成功', handled.s === 200 && j(handled).decision === 'EXECUTED' && m01Writes.some(w => w.body.action === 'offboard' && w.body.person_id === 'P1'));
    ck('办理结果带流水号/审批信息', !!j(handled).traceId, j(handled).traceId || '');
  } finally {
    try { child.kill(); } catch (e) { /* ignore */ }
    try { hlc.close(); } catch (e) { /* ignore */ }
    try { m01.close(); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(path.join(os.tmpdir(), 'personnel-selfcheck-' + process.pid + '.json')); } catch (e) { /* ignore */ }
  }

  console.log('\n人员变动自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
