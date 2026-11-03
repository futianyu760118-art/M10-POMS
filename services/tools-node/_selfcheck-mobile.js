'use strict';
// 统一登录 + 手机工作台自查（真实 PLM/HLC/会议；Hub 凭据不同会如实失败）
// 用法：先 npm start（4173），再 node services/tools-node/_selfcheck-mobile.js
const http = require('http');

function req(p, m, b, cookie) {
  return new Promise((resolve, reject) => {
    const h = {};
    if (b) h['Content-Type'] = 'application/json';
    if (cookie) h.Cookie = cookie;
    const q = http.request({ host: '127.0.0.1', port: 4173, path: p, method: m || 'GET', headers: h }, x => {
      x.setEncoding('utf8'); let d = ''; x.on('data', c => d += c);
      x.on('end', () => resolve({ s: x.statusCode, b: d, h: x.headers }));
    });
    q.on('error', reject);
    if (b) q.write(JSON.stringify(b));
    q.end();
  });
}
const j = (r) => { try { return JSON.parse(r.b); } catch (e) { return {}; } };

(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { if (ok) { pass++; console.log('  [PASS] ' + n + (d ? ' | ' + d : '')); } else { fail++; console.log('  [FAIL] ' + n + (d ? ' | ' + d : '')); } };

  // 页面
  const login = await req('/login');
  ck('统一登录页可访问', login.s === 200 && login.b.includes('统一登录') && login.b.includes('各系统连接情况'));
  const m = await req('/m');
  ck('手机工作台可访问（岗位选择 + 品质检验）', m.s === 200 && m.b.includes('AEOS 手机工作台') && m.b.includes('品质检验') && m.b.includes('selCompany') && m.b.includes('selDept') && m.b.includes('selPos'));
  ck('手机端四个页签（待办/采集/审批/我的）', ['tab-todos', 'tab-capture', 'tab-approval', 'tab-mine'].every(k => m.b.includes(k)));
  ck('手机端支持摄像头扫码（无摄像头时降级手输）', m.b.includes('btnScan') && m.b.includes('BarcodeDetector') && m.b.includes('打不开摄像头'));
  ck('手机端支持拍照留证并随采集提交', m.b.includes('photoInput') && m.b.includes("capture=\"environment\"") && m.b.includes('evidence: state.photo'));
  ck('首页卡片按岗位定制（顺序可配）', m.b.includes('function quickCardsFor') && m.b.includes('function renderQuick') && m.b.includes("cap:IQC") && m.b.includes("tab:approval"));
  const portal = await req('/portal');
  ck('门户含统一登录与手机端入口', portal.b.includes('href="/login"') && portal.b.includes('href="/m"'));

  // 岗位数据：全部 24 个岗位可枚举
  const comps = j(await req('/api/v1/org/companies')).companies || [];
  ck('公司可枚举', comps.length === 2, comps.map(c => c.short).join(','));
  let total = 0; const deptSummary = [];
  for (const c of comps) {
    const d = j(await req('/api/v1/org/departments?company=' + c.id)).departments || [];
    for (const dep of d) {
      const p = j(await req('/api/v1/org/positions?company=' + c.id + '&department=' + encodeURIComponent(dep))).positions || [];
      total += p.length;
      if (c.id === 'hengjian') deptSummary.push(dep + ':' + p.length);
    }
  }
  ck('24 个岗位都能选到', total === 24, '共 ' + total + '（' + deptSummary.join(' ') + '）');

  // 品质检验：按岗位权限返回采集类型（真实数据）
  const qc = j(await req('/api/v1/plm2/capture-types?role=QUALITY')).captureTypes || [];
  ck('质检岗位可做来料检验与拍照', qc.some(t => t.code === 'IQC') && qc.some(t => t.code === 'PHOTO'), qc.map(t => t.code).join(','));
  const eng = j(await req('/api/v1/plm2/capture-types?role=ENGINEER')).captureTypes || [];
  ck('工程岗位不能做 IQC（按岗位限制）', !eng.some(t => t.code === 'IQC') && eng.length > 0, eng.map(t => t.code).join(','));
  const mats = j(await req('/api/v1/plm2/materials?role=QUALITY')).materials || [];
  ck('真实物料可扫码匹配', mats.length > 0, '物料 ' + mats.length + ' 条');

  // 真实提交一条采集（写入 M10 本地采集记录，操作人用「自检机器人」，不污染真人列表）
  if (mats.length) {
    const cap = await req('/api/v1/plm2/captures', 'POST', {
      partNo: mats[0].partNo, captureType: 'IQC',
      values: { supplier: '自检', batch: 'SELFCHECK', dimension: '10', appearance: '合格', function: '合格', note: '自检用，可忽略' },
      operator: '自检机器人', role: 'QUALITY',
      evidence: [{ kind: 'photo', name: '现场.jpg', takenAt: new Date().toISOString(), dataUrl: 'data:image/jpeg;base64,AAAA' }],
      idempotency_key: 'selfcheck-cap-' + Date.now()
    });
    const cj = j(cap);
    ck('品质检验提交成功并进入待审核', (cap.s === 201 || cap.s === 200) && cj.status === 'pending-review', cj.captureId || cj.error);
    ck('照片证据随采集保存', (cj.evidence || []).length === 1 && cj.evidence[0].kind === 'photo');
    const list = j(await req('/api/v1/plm2/captures?operator=' + encodeURIComponent('自检机器人'))).captures || [];
    ck('按操作人可查回自己的采集', list.some(x => x.captureId === cj.captureId), '共 ' + list.length + ' 条');
  }

  // 统一登录
  const bad = await req('/api/v1/sso/login', 'POST', { username: 'admin', password: 'wrong-pass' });
  ck('错误密码不伪造成功（401）', bad.s === 401 && j(bad).systems && !Object.values(j(bad).systems).some(x => x.ok));

  const ok = await req('/api/v1/sso/login', 'POST', { username: 'admin', password: '736669' });
  const okj = j(ok);
  const cookie = ((ok.h['set-cookie'] || [''])[0] || '').split(';')[0];
  ck('正确账号登录成功并下发 M10 会话', ok.s === 200 && cookie.startsWith('m10sess='), cookie ? 'cookie 已下发' : '无 cookie');
  ck('PLM 连接成功（真实账号）', okj.systems && okj.systems.plm && okj.systems.plm.ok === true, okj.systems && okj.systems.plm && okj.systems.plm.name);
  ck('HLC 通过 PLM 令牌自动连接', okj.systems && okj.systems.hlc && okj.systems.hlc.ok === true);
  ck('未通过的子系统如实标记', Object.keys(okj.systems || {}).every(k => typeof okj.systems[k].ok === 'boolean'), Object.keys(okj.systems || {}).map(k => k + '=' + okj.systems[k].ok).join(','));
  ck('不把各系统令牌返回浏览器', !/token|cookie/i.test(ok.b.replace(/m10sess/g, '')));

  const st = j(await req('/api/v1/sso/status', 'GET', null, cookie));
  ck('会话状态可查（登录后）', st.loggedIn === true && st.user && st.user.name);
  const logout = await req('/api/v1/sso/logout', 'POST', {}, cookie);
  ck('退出登录', logout.s === 200);
  ck('退出后会话失效', j(await req('/api/v1/sso/status', 'GET', null, cookie)).loggedIn === false);

  console.log('\n统一登录与手机端自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
