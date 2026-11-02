const http = require('http');
function get(p) { return new Promise(r => http.get({ host: '127.0.0.1', port: 4173, path: p }, x => { let d = ''; x.on('data', c => d += c); x.on('end', () => r({ s: x.statusCode, b: d })); })); }
(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { ok ? (pass++, console.log('  [PASS] ' + n + (d ? ' | ' + d : ''))) : (fail++, console.log('  [FAIL] ' + n + (d ? ' | ' + d : ''))); };
  const ppl = JSON.parse((await get('/api/v1/plm2/people')).b).people;
  const bao = ppl.find(p => p.name === '包跃'), yu = ppl.find(p => p.name === '虞周峰'), nie = ppl.find(p => p.name === '聂晓敏');

  const t = JSON.parse((await get('/api/v1/plm2/me/todos?user=' + bao.id)).b);
  ck('包跃：PLM 待办仍在', t.todoCount > 0, 'plm todo=' + t.todoCount);
  ck('包跃：会议待办已并入 3 条', t.meeting && t.meeting.items.length === 3, JSON.stringify(t.meeting.counts));
  ck('会议待办含来源标识', t.meeting.items.every(i => i.source === 'MEETING' && i.sourceLabel === '会议助手'));
  ck('会议待办状态归一（逾期/待办/已完成）', t.meeting.items.map(i => i.category).sort().join(',') === '已完成,待办,逾期', t.meeting.items.map(i => i.category).join(','));
  ck('会议待办 owner 过滤（虞周峰 1 条）', JSON.parse((await get('/api/v1/plm2/me/todos?user=' + yu.id)).b).meeting.items.length === 1);
  ck('会议待办 owner 过滤（聂晓敏 0 条）', JSON.parse((await get('/api/v1/plm2/me/todos?user=' + nie.id)).b).meeting.items.length === 0);
  ck('会议元数据（connected/updatedAt）', t.meeting.connected === true && !!t.meeting.updatedAt);

  const pg = (await get('/plm2')).b;
  ['meetingRowHtml', 'meetingDetail', 'meetingBanner', '会议助手待办已并入'].forEach(k => ck('页面含：' + k, pg.includes(k)));
  const g = pg.match(/const TODO_GROUPS = \[([^\]]+)\]/);
  const groups = g ? g[1].split(',').map(s => s.trim().replace(/'/g, '')) : [];
  ck('分组含「异常」（虞周峰会议待办分类）', groups.includes('异常'), groups.join('/'));

  const yuT = JSON.parse((await get('/api/v1/plm2/me/todos?user=' + yu.id)).b);
  const yuCats = yuT.meeting.items.map(i => i.category);
  ck('虞周峰会议待办分类均能在分组中落地', yuCats.every(c => groups.includes(c)), yuCats.join(','));

  console.log('\n会议助手待办接入自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
