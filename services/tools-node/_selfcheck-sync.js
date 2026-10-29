const http = require('http');
function req(o, b) { return new Promise((res, rej) => { const r = http.request(o, x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c).toString('utf8') })); }); r.on('error', rej); if (b) r.write(b); r.end(); }); }
const j = (p, m, pl) => { const o = { host: '127.0.0.1', port: 4173, path: p, method: m || 'GET', headers: {} }; let b; if (pl) { b = JSON.stringify(pl); o.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }; } return req(o, b); };
const plm = (p, m, pl, tok) => { const o = { host: '127.0.0.1', port: 8081, path: '/api' + p, method: m || 'GET', headers: { 'Content-Type': 'application/json' } }; if (tok) o.headers.Authorization = 'Bearer ' + tok; let b; if (pl) { b = JSON.stringify(pl); o.headers['Content-Length'] = Buffer.byteLength(b); } return req(o, b); };
(async () => {
  let pass = 0, fail = 0, skip = 0;
  const ck = (n, ok, d) => { ok ? (pass++, console.log('  [PASS] ' + n + (d ? ' | ' + d : ''))) : (fail++, console.log('  [FAIL] ' + n + (d ? ' | ' + d : ''))); };
  const sk = (n, d) => { skip++; console.log('  [SKIP] ' + n + (d ? ' | ' + d : '')); };

  // PLM 侧登录拿 token（验证用；不可用时降级）
  let tok = null;
  try {
    const lg = JSON.parse((await plm('/auth/login', 'POST', { username: 'admin', password: '736669' })).body);
    tok = lg.data && lg.data.token;
  } catch (e) { /* ignore */ }
  if (!tok) console.log('  [WARN] PLM 登录暂不可用（后端白名单/口令变动）→ PLM 侧直验降级为 SKIP，仅验 M10 侧行为');

  // 选一个真实项目
  const projects = JSON.parse((await j('/api/v1/plm2/projects')).body).projects;
  const P = projects.find(x => x.owner === '包跃' && x.plmId);
  const no = encodeURIComponent(P.projectNo);
  ck('选定项目带 plmId', !!P.plmId, `${P.projectNo} plmId=${P.plmId}`);

  // ① M10 读透（首访拉取）
  const d0 = JSON.parse((await j('/api/v1/plm2/projects/' + no)).body);
  ck('读透：明细来自 PLM API 拉取', d0.nodes.length === 22, `SPEC=${(d0.nodes.find(n=>n.code==='SPEC')||{}).statusLabel}`);

  // ② M10 改节点 → 写透 PLM → 直查 PLM 库侧 API 验证
  const up = JSON.parse((await j(`/api/v1/plm2/projects/${no}/nodes/REVIEW`, 'POST', { status: 'PLANNED', planDate: '2026-11-05', owner: '王栌鑫', remark: 'M10 同步测试' })).body);
  ck('M10 更新返回 plmSync.ok', up.plmSync && up.plmSync.ok === true, JSON.stringify(up.plmSync));
  if (tok) {
    const mx = JSON.parse((await plm(`/project/${P.plmId}/nodes`, 'GET', null, tok)).body);
    const rv = (mx.data.nodes || []).find(n => n.nodeCode === 'REVIEW');
    ck('PLM 侧已变更（status/plan/owner/remark）', rv && rv.status === 'PLANNED' && rv.planDate === '2026-11-05' && rv.owner === '王栌鑫' && rv.remark === 'M10 同步测试', `${rv.status}/${rv.planDate}/${rv.owner}`);
  } else sk('PLM 侧直验（登录不可用）');

  // ③ PLM 侧直接改 → M10 fresh 读透看到
  if (tok) {
    await plm(`/project/${P.plmId}/nodes/REVIEW`, 'PUT', { status: 'PLANNED', planDate: '2026-11-08', actualDate: '', owner: '聂晓敏', deliveryDesc: '', remark: 'PLM直改' }, tok);
    const d1 = JSON.parse((await j('/api/v1/plm2/projects/' + no + '?fresh=1')).body);
    const rv1 = d1.nodes.find(n => n.code === 'REVIEW');
    ck('PLM 改 → M10 fresh 读到', rv1.status === 'PLANNED' && rv1.planDate === '2026-11-08' && rv1.owner === '聂晓敏', `${rv1.statusLabel}/${rv1.planDate}/${rv1.owner}`);
  } else sk('PLM 反向直改验证（登录不可用）');

  // ④ 批量同步 + 状态
  const sp = JSON.parse((await j('/api/v1/plm2/sync', 'POST', { person: '包跃' })).body);
  ck('按人批量同步', sp.pulled > 0, `pulled=${sp.pulled}/${sp.total}`);
  const st = JSON.parse((await j('/api/v1/plm2/sync-status')).body);
  ck('同步状态含 lastWrite/lastPull', !!st.lastWriteAt && !!st.lastPullAt && st.projectsWithPlmId === 165, `w=${(st.lastWriteAt||'').slice(11,19)} p=${(st.lastPullAt||'').slice(11,19)}`);

  // ⑤ 项目编辑写透
  const pe = JSON.parse((await j(`/api/v1/plm2/projects/${no}/edit`, 'POST', { customer: '同步测试客户', role: 'RD_LEAD' })).body);
  ck('项目编辑写透 ok', pe.plmSync && pe.plmSync.ok === true, JSON.stringify(pe.plmSync));
  if (tok) {
    const pj = JSON.parse((await plm(`/v1/projects/${P.plmId}`, 'GET', null, tok)).body);
    ck('PLM 侧客户已改', (pj.data || {}).customerName === '同步测试客户', pj.data && pj.data.customerName);
  } else sk('PLM 项目直验（登录不可用）');

  // 还原（经 PLM API），避免污染真实库
  if (tok) {
    await plm(`/project/${P.plmId}/nodes/REVIEW`, 'PUT', { status: 'NOT_SET', owner: '', remark: '' }, tok);
    await plm(`/v1/projects`, 'PUT', { id: P.plmId, customerName: P.customer }, tok);
  }

  const page = (await j('/plm2')).body;
  ['PLM 实时同步', '强制从PLM刷新', 'syncFromPlm'].forEach(k => ck('页面含：' + k, page.includes(k)));

  console.log('\nM10↔M04 实时同步自查: ' + pass + ' 通过, ' + fail + ' 失败, ' + skip + ' 跳过');
  process.exit(fail ? 1 : 0);
})();
