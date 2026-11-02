'use strict';
// 会议中心全量接入自查：用本地 mock 会议助手验证「登录 → /api/actions 全量 → 快照 → 适配器 → 总库」
// 不接触真实会议库，不产出虚假业务数据；mock 数据仅用于验证链路。
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.env.MOCK_PORT || 4298);
const TMP = path.join(os.tmpdir(), 'meeting-full-' + process.pid);
const SNAP = path.join(TMP, 'meeting-actions.json');
const STORE = path.join(TMP, 'tasks-master.json');

const MOCK_ITEMS = [
  { id: 'A1', description: '083S 首件检验报告提交评审', owner: '包跃', ownerLoginId: 'baoyue', dept: '研发部', proposer: '虞周峰', due_date: '2026-10-30', priority: 'high', status: 'pending', meetingId: 'M1', meetingTitle: '研发周会', meeting_date: '2026-10-27', meeting_status: 'locked' },
  { id: 'A2', description: '补充三角支架试模照片与不良率数据', owner: '包跃', ownerLoginId: 'baoyue', dept: '研发部', proposer: '虞周峰', due_date: '2026-11-05', priority: 'medium', status: 'in_progress', meetingId: 'M1', meetingTitle: '研发周会', meeting_date: '2026-10-27', meeting_status: 'locked' },
  { id: 'A3', description: '驱动电源重新送检测试', owner: '虞周峰', ownerLoginId: 'yuzhoufeng', dept: '研发部', proposer: '朱剑军', due_date: '2026-10-29', priority: 'high', status: 'blocked', blockedBy: '供应商未到料', meetingId: 'M2', meetingTitle: '技术评审', meeting_date: '2026-10-25', meeting_status: 'locked' },
  { id: 'A4', description: '夹子一代降本核算交付', owner: '包跃', ownerLoginId: 'baoyue', dept: '研发部', proposer: '朱剑军', due_date: '2026-10-26', priority: 'low', status: 'done', meetingId: 'M2', meetingTitle: '技术评审', meeting_date: '2026-10-25', meeting_status: 'locked' },
  { id: 'A5', description: '路灯 ECN 变更影响面评估', owner: '孙周杰', ownerLoginId: 'sunzhoujie', dept: '研发部', proposer: '虞周峰', due_date: '2026-11-06', priority: 'medium', status: 'pending', meetingId: 'M3', meetingTitle: 'ECN 专题', meeting_date: '2026-10-28', meeting_status: 'locked' },
  { id: 'A6', description: '（已取消）旧款模具封存', owner: '孙周杰', ownerLoginId: 'sunzhoujie', dept: '研发部', proposer: '虞周峰', due_date: '2026-11-01', priority: 'low', status: 'cancelled', meetingId: 'M3', meetingTitle: 'ECN 专题', meeting_date: '2026-10-28', meeting_status: 'locked' },
  { id: 'A7', description: '行政考勤异常汇总（10 月）', owner: '聂晓敏', ownerLoginId: 'niexiaomin', dept: '行政部', proposer: '朱剑军', due_date: '2026-11-03', priority: 'medium', status: 'pending', source_type: 'batch' }
];

function json(res, code, obj, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && u.pathname === '/api/auth/login') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      let loginid = '';
      try { loginid = JSON.parse(b).loginid || ''; } catch (e) { /* ignore */ }
      if (!loginid) return json(res, 400, { success: false, error: '请输入OA登录账号' });
      return json(res, 200, { success: true, data: { name: '系统管理员', dept: '信息部', role: 'admin' } },
        { 'Set-Cookie': 'meeting_session=mock-token-' + loginid + '; HttpOnly; SameSite=Lax; Path=/' });
    });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/api/actions/mine') {
    const cookie = req.headers.cookie || '';
    if (!/meeting_session=/.test(cookie)) return json(res, 401, { success: false, error: '未登录' });
    return json(res, 200, { success: true, data: MOCK_ITEMS.filter(x => x.owner === '包跃') });
  }
  if (req.method === 'GET' && u.pathname === '/api/actions') {
    const cookie = req.headers.cookie || '';
    if (!/meeting_session=/.test(cookie)) return json(res, 401, { success: false, error: '未登录' });
    const st = u.searchParams.get('status');
    const data = st ? MOCK_ITEMS.filter(x => st.split(',').includes(x.status)) : MOCK_ITEMS;
    return json(res, 200, { success: true, data });
  }
  return json(res, 404, { success: false, error: 'not found' });
});

function run(cmd, args, env) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { cwd: ROOT, env: Object.assign({}, process.env, env) });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);
    p.on('close', code => resolve({ code, out }));
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { if (ok) { pass++; console.log('  [PASS] ' + n + (d ? ' | ' + d : '')); } else { fail++; console.log('  [FAIL] ' + n + (d ? ' | ' + d : '')); } };

  fs.mkdirSync(TMP, { recursive: true });
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const API = 'http://127.0.0.1:' + PORT;
  try {
    const noAuth = await run(process.execPath, [path.join(ROOT, 'scripts', 'sync-meeting-todos.js')], { MEETING_API: API, MEETING_COOKIE: '', MEETING_LOGINID: '' });
    ck('缺鉴权时明确报错退出（不伪造成功）', noAuth.code === 1 && /缺少鉴权/.test(noAuth.out));

    const r1 = await run(process.execPath, [path.join(ROOT, 'scripts', 'sync-meeting-todos.js')], { MEETING_API: API, MEETING_LOGINID: 'admin', MEETING_OUT: SNAP });
    ck('登录 + 全量拉取成功', r1.code === 0, r1.out.split('\n')[0]);
    const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
    ck('快照 scope=all / live=true', snap.scope === 'all' && snap.live === true);
    ck('所有待办全部接入（含完成/阻塞/取消）', snap.items.length === MOCK_ITEMS.length, snap.items.length + ' 条');
    ck('状态计数如实', snap.counts.pending === 3 && snap.counts.in_progress === 1 && snap.counts.done === 1 && snap.counts.blocked === 1 && snap.counts.cancelled === 1, JSON.stringify(snap.counts));
    ck('取消项保留在快照（总库可见）', snap.items.some(x => x.status === 'cancelled'));

    const r2 = await run(process.execPath, [path.join(ROOT, 'scripts', 'sync-meeting-todos.js')], { MEETING_API: API, MEETING_COOKIE: 'meeting_session=mock-token-admin', MEETING_SCOPE: 'mine', MEETING_OUT: SNAP });
    ck('Cookie 模式 + 仅本人可用', r2.code === 0 && JSON.parse(fs.readFileSync(SNAP, 'utf8')).items.length === 3);

    // 全量快照供适配器/总库使用
    await run(process.execPath, [path.join(ROOT, 'scripts', 'sync-meeting-todos.js')], { MEETING_API: API, MEETING_LOGINID: 'admin', MEETING_OUT: SNAP });
    process.env.MEETING_SNAPSHOT_FILE = SNAP;
    process.env.TASKHUB_STORE = STORE;
    delete require.cache[require.resolve(path.join(ROOT, 'adapters', 'meeting'))];
    delete require.cache[require.resolve(path.join(ROOT, 'packages', 'taskhub'))];
    const meeting = require(path.join(ROOT, 'adapters', 'meeting'));
    const taskhub = require(path.join(ROOT, 'packages', 'taskhub'));

    const all = meeting.listAll({ today: '2026-11-02' });
    ck('适配器 listAll 返回全量', all.items.length === MOCK_ITEMS.length && all.live === true);
    const bao = meeting.listMine({ name: '包跃', username: 'baoyue' }, { today: '2026-11-02' });
    ck('我的待办按人过滤且排除已取消', bao.items.length === 3 && bao.items.every(x => x.category !== '已取消'), '包跃 ' + bao.items.length + ' 条');
    ck('责任人可按 loginId 匹配', meeting.listMine({ name: '虞周峰', username: 'yuzhoufeng' }, { today: '2026-11-02' }).items.length === 1);
    ck('其他责任人按人过滤（聂晓敏 1 条，行政批次项）', meeting.listMine({ name: '聂晓敏' }, { today: '2026-11-02' }).items.length === 1);

    taskhub.reset();
    const rf = await taskhub.refresh({ today: '2026-11-02' });
    const s = taskhub.list({ today: '2026-11-02', source: 'MEETING' });
    ck('总库归集会议全量', s.items.length === MOCK_ITEMS.length, s.items.length + ' 条');
    ck('行政类全部归会议中心', s.items.every(x => x.bizSys === 'meeting' && x.bizDomain === 'ADMIN'));
    ck('责任人映射到 M10 人员', s.items.filter(x => x.ownerName === '包跃').every(x => x.ownerId > 0));
    ck('已取消状态如实呈现', s.items.some(x => x.status === 'cancelled' && x.statusText === '已取消'));
    ck('源健康度含会议范围', s.sources.MEETING.ok === true && s.sources.MEETING.meta.scope === 'all', JSON.stringify(s.sources.MEETING.meta.counts));

    taskhub.reset();
    process.env.MEETING_SNAPSHOT_FILE = path.join(ROOT, 'configs', 'meeting-actions.json');
    delete process.env.TASKHUB_STORE;
  } finally {
    server.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n会议中心全量接入自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
