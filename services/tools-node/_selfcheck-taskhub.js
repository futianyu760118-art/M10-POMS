'use strict';
// 总任务库 HTTP 自查：独立 BFF 实例 + 临时短期库（不污染真实 configs/tasks-master.json）
// 用法：node services/tools-node/_selfcheck-taskhub.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.env.SELFCHECK_PORT || 4199);
const STORE = path.join(os.tmpdir(), 'taskhub-selfcheck-' + process.pid + '.json');

function req(p, method, body) {
  return new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method || 'GET', headers: body ? { 'Content-Type': 'application/json' } : {} },
      x => { let d = ''; x.setEncoding('utf8'); x.on('data', c => d += c); x.on('end', () => resolve({ s: x.statusCode, b: d })); });
    q.on('error', reject);
    if (body) q.write(JSON.stringify(body));
    q.end();
  });
}
const j = (r) => { try { return JSON.parse(r.b); } catch (e) { return {}; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { if (ok) { pass++; console.log('  [PASS] ' + n + (d ? ' | ' + d : '')); } else { fail++; console.log('  [FAIL] ' + n + (d ? ' | ' + d : '')); } };

  // mock PLM：验证「总库改 PLM 状态 → 写透 PLM」链路（不触真实 PLM 生产数据）
  const plmCalls = [];
  const plmMock = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', c => b += c);
    rq.on('end', () => {
      if (rq.method === 'POST' && rq.url === '/api/auth/login') {
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        return rs.end(JSON.stringify({ code: 200, data: { token: 'mock' } }));
      }
      if (rq.method === 'PUT' && /^\/api\/project\/\d+\/nodes\//.test(rq.url)) {
        let body = {}; try { body = JSON.parse(b); } catch (e) { /* ignore */ }
        plmCalls.push({ url: rq.url, body });
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        return rs.end(JSON.stringify({ code: 200 }));
      }
      if (rq.method === 'GET' && /^\/api\/project\/\d+\/nodes$/.test(rq.url)) {
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        return rs.end(JSON.stringify({ code: 200, data: { project: {}, nodes: [], summary: {} } }));
      }
      rs.writeHead(404, { 'Content-Type': 'application/json' }); rs.end('{}');
    });
  });
  await new Promise(r => plmMock.listen(0, '127.0.0.1', r));
  const PLM_PORT = plmMock.address().port;

  const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'bff', 'server.js')], {
    cwd: ROOT, env: Object.assign({}, process.env, {
      PORT: String(PORT), TASKHUB_STORE: STORE,
      PLM_API: 'http://127.0.0.1:' + PLM_PORT, PLM_POLL_MS: '0'
    }), stdio: 'ignore'
  });
  try {
    let up = false;
    for (let i = 0; i < 40; i++) { try { const r = await req('/api/v1/tasks'); if (r.s === 200) { up = true; break; } } catch (e) { /* 未就绪 */ } await sleep(250); }
    if (!up) throw new Error('BFF 未在端口 ' + PORT + ' 就绪');

    // 实时同步通道（SSE）：订阅后再做变更，验证「总库/个人/部门」是否即时互传
    const sseEvents = [];
    const sseReq = http.get({ host: '127.0.0.1', port: PORT, path: '/api/v1/tasks/stream' }, res => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', d => {
        buf += d;
        const parts = buf.split('\n\n');
        buf = parts.pop();
        parts.forEach(p => {
          const line = p.split('\n').find(l => l.indexOf('data: ') === 0);
          if (!line) return;
          try { sseEvents.push(JSON.parse(line.slice(6))); } catch (e) { /* ignore */ }
        });
      });
    });
    sseReq.on('error', () => {});
    await sleep(300);
    ck('SSE 通道可订阅（hello）', sseEvents.some(e => e.kind === 'hello'));

    const page = await req('/taskhub');
    ck('页面 /taskhub 可访问', page.s === 200 && page.b.includes('总任务库'));
    const portal = await req('/portal');
    ck('门户含总任务库入口', portal.s === 200 && portal.b.includes('href="/taskhub"') && portal.b.includes('总任务库'));

    const pageSrc = page.b;
    ck('页面支持重复合并（groupRows + 可展开组）', pageSrc.includes('function groupRows') && pageSrc.includes('details class="grp"'));
    ck('页面支持状态多选（msStatus + toggleStatus）', pageSrc.includes('msStatusMenu') && pageSrc.includes('window.toggleStatus') && pageSrc.includes('__all__'));
    ck('页面支持驾驶舱穿透（drill + chips）', pageSrc.includes('window.drill') && pageSrc.includes('renderChips') && pageSrc.includes('class="kpi'));
    ck('页面支持三种呈现（列表/看板/表格）', pageSrc.includes('renderListMode') && pageSrc.includes('renderBoardMode') && pageSrc.includes('renderTableMode') && pageSrc.includes("setMode('board')") && pageSrc.includes("setMode('table')"));

    const t = j(await req('/api/v1/tasks'));
    ck('GET /api/v1/tasks 首次访问自动归集', t.total > 0, 'total=' + t.total);
    ck('条目带来源/业务域/状态/责任人', t.items.every(x => x.source && x.bizDomain && x.status && 'ownerName' in x));
    ck('行政类归会议中心', t.items.filter(x => x.source === 'MEETING').every(x => x.bizSys === 'meeting' && x.bizDomain === 'ADMIN'));
    ck('业务类归 PLM', t.items.filter(x => x.source === 'PLM2').every(x => x.bizSys === 'plm2' && ['RD', 'ORDER', 'PURCHASE', 'PRODUCTION'].includes(x.bizDomain)));
    ck('源健康度可用', !!(t.sources && t.sources.MEETING && t.sources.PLM2), Object.keys(t.sources || {}).join(','));
    ck('只存引用（origin=sync 且带 fetchedAt）', t.items.filter(x => x.origin === 'sync').every(x => x.sourceId && x.fetchedAt));

    const rf = j(await req('/api/v1/tasks/refresh', 'POST', {}));
    ck('POST /refresh 幂等（条数不膨胀）', rf.total === t.total, t.total + ' -> ' + rf.total);

    const TEXT = '通知采购准备来料检验 2026-11-20；虞周峰负责推进驱动电源送检 ASAP';
    const ex = j(await req('/api/v1/tasks/extract', 'POST', { text: TEXT }));
    const textCands = (ex.candidates || []).filter(c => c.source === 'TEXT');
    ck('POST /extract 从粘贴文本拆出候选', textCands.length === 2, 'text=' + textCands.length + ' total=' + ex.produced);
    ck('抽取标注规则引擎且需复核', ex.engine === 'rule-based' && ex.reviewRequired === true);
    ck('期限识别 2026-11-20', textCands.some(c => c.due === '2026-11-20'));
    ck('责任人识别 虞周峰', textCands.some(c => c.ownerName === '虞周峰'));
    ck('紧急度识别 high', textCands.some(c => c.priority === 'high'));
    ck('采购类归 PURCHASE（不误归行政）', textCands.some(c => /采购/.test(c.title) && c.bizDomain === 'PURCHASE'));
    ck('重复抽取不重复产出（去重）', (j(await req('/api/v1/tasks/extract', 'POST', { text: TEXT })).candidates || []).filter(c => c.source === 'TEXT').length === 0);

    const c0 = textCands[0];
    const noAuth = await req('/api/v1/tasks/candidates/' + encodeURIComponent(c0.id) + '/confirm', 'POST', { reviewer: '查无此人' });
    ck('非授权复核人确认被拒 403', noAuth.s === 403, j(noAuth).error);
    ck('缺复核人确认被拒 403（服务端鉴权）', (await req('/api/v1/tasks/candidates/' + encodeURIComponent(c0.id) + '/confirm', 'POST', {})).s === 403);
    const ok = await req('/api/v1/tasks/candidates/' + encodeURIComponent(c0.id) + '/confirm', 'POST', { reviewer: '系统管理员', ownerName: '包跃' });
    ck('授权复核人确认入总库（origin=extract）', ok.s === 200 && j(ok).item && j(ok).item.origin === 'extract', 'id=' + (j(ok).item || {}).id);
    ck('确认后留复核痕迹', (j(ok).item || {}).verifiedBy === '系统管理员');

    const syncItem = t.items.find(x => x.origin === 'sync');
    const blocked = await req('/api/v1/tasks/' + encodeURIComponent(syncItem.id) + '/assign', 'POST', { ownerName: '虞周峰', reviewer: '系统管理员' });
    ck('引用条目分发返回 409（M10 不双写）', blocked.s === 409, j(blocked).error);
    const local = await req('/api/v1/tasks/' + encodeURIComponent(j(ok).item.id) + '/assign', 'POST', { ownerName: '虞周峰', reviewer: '系统管理员' });
    ck('本地抽取条目可分发', local.s === 200 && j(local).item.ownerName === '虞周峰');

    const after = j(await req('/api/v1/tasks'));
    ck('确认后总库 +1', after.total === t.total + 1, t.total + ' -> ' + after.total);
    ck('短期库文件已落地', fs.existsSync(STORE));

    /* ---- 总库 → 个人/部门输出 & 双向即时同步 ---- */
    const people = j(await req('/api/v1/plm2/people')).people || [];
    const yu = people.find(p => p.name === '虞周峰');
    const person = j(await req('/api/v1/tasks/person?name=' + encodeURIComponent('虞周峰')));
    ck('GET /tasks/person 输出个人待办', person.counts && person.counts.total >= 1 && person.items.every(x => x.ownerName === '虞周峰'), 'total=' + (person.counts || {}).total);
    const dept = j(await req('/api/v1/tasks/dept?dept=' + encodeURIComponent((person.dept || '研发中心'))));
    ck('GET /tasks/dept 输出部门待办（含按人汇总）', dept.counts.total >= 1 && Array.isArray(dept.byOwner) && dept.byOwner.some(o => o.ownerName === '虞周峰'), 'total=' + dept.counts.total);

    // 个人待办页（/me/todos）应包含总库输出的任务
    const me = j(await req('/api/v1/plm2/me/todos?user=' + (yu ? yu.id : 0)));
    ck('/me/todos 携带总库个人待办段', Array.isArray((me.taskhub || {}).items) && me.taskhub.items.length >= 1, 'n=' + ((me.taskhub || {}).items || []).length);

    // 个人完成 → 即时回写总库（自有条目）
    const localId = j(ok).item.id;
    const pr = await req('/api/v1/tasks/' + encodeURIComponent(localId) + '/progress', 'POST', { status: 'done', actor: '虞周峰' });
    ck('个人待办完成回写总库', pr.s === 200 && j(pr).item.status === 'done');
    const afterDone = j(await req('/api/v1/tasks/person?name=' + encodeURIComponent('虞周峰')));
    ck('回写后个人视图状态即时更新', afterDone.items.some(x => x.id === localId && x.status === 'done'));

    // 引用条目不能在 M10 改状态（回源系统）
    const prSync = await req('/api/v1/tasks/' + encodeURIComponent(syncItem.id) + '/progress', 'POST', { status: 'done', actor: '虞周峰' });
    ck('引用条目改状态返回 409（不双写）', prSync.s === 409, j(prSync).error);
    // 非责任人且非管理角色不可改
    const prOther = await req('/api/v1/tasks/' + encodeURIComponent(localId) + '/progress', 'POST', { status: 'in_progress', actor: '沈建凯' });
    ck('非责任人改他人任务被拒 403', prOther.s === 403 || prOther.s === 400, 'HTTP ' + prOther.s);

    await sleep(500);
    ck('SSE 推送变更事件（confirm/assign/progress）', ['candidate', 'assign', 'progress'].every(k => sseEvents.some(e => e.kind === k)), sseEvents.map(e => e.kind).join(','));
    ck('活动日志可追溯', (j(await req('/api/v1/tasks/activities?limit=5')).activities || []).length >= 1);
    sseReq.destroy();

    /* ---- 总库 ↔ PLM 互相同步 ---- */
    const plmItem = t.items.find(x => x.source === 'PLM2' && x.origin === 'sync');
    ck('总库含 PLM 条目（可写透）', !!plmItem, plmItem ? plmItem.title : '');
    if (plmItem) {
      const pr2 = await req('/api/v1/tasks/' + encodeURIComponent(plmItem.id) + '/progress', 'POST', { status: 'done', actor: plmItem.ownerName });
      ck('PLM 任务完成写透 PLM（200）', pr2.s === 200 && j(pr2).plm && j(pr2).plm.ok === true, j(pr2).error || '');
      ck('PLM 收到节点写回（PUT status=DONE）', plmCalls.some(c => c.body && c.body.status === 'DONE'), plmCalls.length + ' 次');
      const after2 = j(await req('/api/v1/tasks'));
      ck('写透后总库状态为已完成', after2.items.some(x => x.id === plmItem.id && x.status === 'done'));
      const act = j(await req('/api/v1/tasks/activities?limit=5')).activities || [];
      ck('PLM 写透留痕（plm-progress）', act.some(a => a.kind === 'plm-progress'));
      const plms = j(await req('/api/v1/plm2/sync-status'));
      ck('PLM 同步状态可查（api/lastWriteAt）', !!plms.api && !!plms.lastWriteAt);
    }

    // 源故障降级：篡改快照健康度后条目仍在且标 stale
    const meetBase = after.items.filter(x => x.source === 'MEETING').length;
    const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    store.sources.MEETING.ok = false;
    store.sources.MEETING.cachedAt = '2026-10-01T00:00:00Z';
    fs.writeFileSync(STORE, JSON.stringify(store, null, 2), 'utf8');
    const deg = j(await req('/api/v1/tasks'));
    const mrows = deg.items.filter(x => x.source === 'MEETING');
    ck('源故障时本地短期库顶住（条目不丢）', mrows.length === meetBase, mrows.length + '/' + meetBase + ' 条');
    ck('源故障条目标注 stale', mrows.every(x => x.stale === true));
  } finally {
    try { child.kill(); } catch (e) { /* ignore */ }
    try { plmMock.close(); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(STORE); } catch (e) { /* ignore */ }
  }

  console.log('\n总任务库自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
