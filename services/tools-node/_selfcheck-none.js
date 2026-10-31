const http = require('http');
function req(o, b) { return new Promise((res, rej) => { const r = http.request(o, x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c).toString('utf8') })); }); r.on('error', rej); if (b) r.write(b); r.end(); }); }
async function j(p, m, pl) { const o = { host: '127.0.0.1', port: 4173, path: p, method: m || 'GET', headers: {} }; let b; if (pl) { b = JSON.stringify(pl); o.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }; } const r = await req(o, b); let d = null; try { d = JSON.parse(r.body); } catch (e) {} return { status: r.status, data: d }; }
(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { ok ? (pass++, console.log('  [PASS] ' + n + (d ? ' | ' + d : ''))) : (fail++, console.log('  [FAIL] ' + n + (d ? ' | ' + d : ''))); };
  const API = '/api/v1/plm2';
  const ppl = (await j(API + '/people')).data.people;
  const bao = ppl.find(p => p.name === '包跃');
  const P = (await j(API + '/projects')).data.projects.find(p => p.owner === '包跃');
  const no = encodeURIComponent(P.projectNo);

  const t0 = (await j(API + '/me/todos?user=' + bao.id)).data;
  const s0 = (await j(API + '/projects/' + no)).data.summary;
  const setNone = await j(`${API}/projects/${no}/nodes/SPEC`, 'POST', { status: 'NONE' });
  const t1 = (await j(API + '/me/todos?user=' + bao.id)).data;
  const s1 = (await j(API + '/projects/' + no)).data.summary;

  ck('SPEC 置为无节点成功', setNone.status === 200);
  ck('待办总数剔除无节点', t1.total === t0.total - 1, `${t0.total}→${t1.total}（none ${t0.noneCount}→${t1.noneCount}）`);
  ck('项目进度分母剔除无节点', s1.total === s0.total - 1 && s1.noneCount === 1, `${s0.done}/${s0.total} → ${s1.done}/${s1.total}（none=${s1.noneCount}）`);
  ck('进度百分比不受无节点虚增', s1.done <= s1.total);
  const sum = t1.overdueCount + t1.todoCount + t1.doneCount;
  ck('三分类=总数（不含无节点）', sum === t1.total, `${sum}=${t1.total}`);

  console.log('\n无节点总数口径自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
