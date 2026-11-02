'use strict';
// 会议助手待办接入自查（真实快照驱动，数据量无关）：
// 断言 BFF /me/todos 的 meeting 段与 adapters/meeting 一致、分类可落地、取消态不出现
const http = require('http');
const path = require('path');
const meeting = require(path.join(__dirname, '..', '..', 'adapters', 'meeting'));

function get(p) { return new Promise(r => http.get({ host: '127.0.0.1', port: 4173, path: p }, x => { let d = ''; x.setEncoding('utf8'); x.on('data', c => d += c); x.on('end', () => r({ s: x.statusCode, b: d })); })); }

(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { ok ? (pass++, console.log('  [PASS] ' + n + (d ? ' | ' + d : ''))) : (fail++, console.log('  [FAIL] ' + n + (d ? ' | ' + d : ''))); };

  const snap = meeting.loadSnapshot();
  ck('快照可读（live 或 sample）', Array.isArray(snap.items), 'items=' + (snap.items || []).length + ' live=' + !!snap.live);

  const ppl = JSON.parse((await get('/api/v1/plm2/people')).b).people;
  const samples = ppl.filter(p => (snap.items || []).some(x => x.owner === p.name || x.ownerLoginId === p.username)).slice(0, 4);
  ck('会议快照责任人可映射到 M10 人员', samples.length > 0, samples.map(p => p.name).join(','));

  for (const p of samples) {
    const t = JSON.parse((await get('/api/v1/plm2/me/todos?user=' + p.id)).b);
    const m = t.meeting || {};
    const expect = meeting.listMine({ name: p.name, username: p.username }).items.map(x => x.id).sort();
    const got = (m.items || []).map(x => x.id).sort();
    ck(p.name + '：BFF 会议待办与适配器一致', JSON.stringify(expect) === JSON.stringify(got), 'n=' + got.length);
    ck(p.name + '：条目带来源标识', (m.items || []).every(i => i.source === 'MEETING' && i.sourceLabel === '会议助手'));
    ck(p.name + '：无已取消项', (m.items || []).every(i => i.category !== '已取消'));
  }

  const t0 = JSON.parse((await get('/api/v1/plm2/me/todos?user=' + ppl[0].id)).b);
  ck('PLM 待办未被覆盖', typeof t0.todoCount === 'number' && Array.isArray(t0.overdue));
  ck('会议元数据（connected/updatedAt）', !!t0.meeting && t0.meeting.updatedAt !== undefined);

  const pg = (await get('/plm2')).b;
  ['meetingRowHtml', 'meetingDetail', 'meetingBanner', '会议助手待办已并入'].forEach(k => ck('页面含：' + k, pg.includes(k)));
  const g = pg.match(/const TODO_GROUPS = \[([^\]]+)\]/);
  const groups = g ? g[1].split(',').map(s => s.trim().replace(/'/g, '')) : [];
  ck('分组含「异常」', groups.includes('异常'), groups.join('/'));

  const allCats = [...new Set((snap.items || []).map(x => meeting.listAll().items.find(y => y.id === x.id)).filter(Boolean).map(y => y.category))];
  const visible = allCats.filter(c => c !== '已取消');
  ck('所有会议分类都能落到待办分组', visible.every(c => groups.includes(c)), visible.join(','));

  console.log('\n会议助手待办接入自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
