'use strict';
// 手机端自查：手机号绑定登录（不暴露第三方令牌）、账号/岗位/待办与 PLM 同步、简洁操作界面、采集链路、登录留痕
// 用法：先 npm start（4173），再 node services/tools-node/_selfcheck-mobile.js
const http = require('http');

function req(p, m, b, cookie) {
  return new Promise((resolve, reject) => {
    const h = { 'User-Agent': 'selfcheck-mobile' };
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
const PHONE = '13900000001';

(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { if (ok) { pass++; console.log('  [PASS] ' + n + (d ? ' | ' + d : '')); } else { fail++; console.log('  [FAIL] ' + n + (d ? ' | ' + d : '')); } };

  /* ---- 页面 ---- */
  const loginPage = await req('/m/login');
  ck('手机登录页可访问且简洁（手机号+账号+密码）', loginPage.s === 200 && loginPage.b.includes('手机绑定登录') && loginPage.b.includes('phone') && !loginPage.b.includes('选择岗位'));
  const m = await req('/m');
  ck('手机工作台可访问', m.s === 200 && m.b.includes('AEOS 手机工作台'));
  ck('界面不再有岗位选择等多余内容', !/selCompany|selDept|selPos|quickCardsFor|岗位职责/.test(m.b));
  ck('保留核心页签（待办/采集/审批/我的）', ['tab-todos', 'tab-capture', 'tab-approval', 'tab-mine'].every(k => m.b.includes(k)));
  ck('我的页含手机号与最近登录记录', m.b.includes('手机号') && m.b.includes('最近登录记录'));
  ck('扫码与拍照留证仍在', m.b.includes('BarcodeDetector') && m.b.includes('capture="environment"') && m.b.includes('evidence: state.photo'));
  ck('料号可选 + 模糊查找', m.b.includes('matSugg') && m.b.includes('btnListMat') && m.b.includes('filter(m => matMatch'));
  ck('待办有分类且可直接处理', m.b.includes('TODO_CATS') && m.b.includes('window.todoAct'));
  ck('默认隐藏已完成/已作废', m.b.includes('chkHideDone') && m.b.includes('hideDone: true'));
  ck('PLM 节点可编辑（编辑 sheet + 同步 PLM）', m.b.includes('editSheet') && m.b.includes('openEditSheet') && m.b.includes('btnEdSave'));
  ck('找回 AI 录入工具（8002：OCR 识别料号 + 语音转文字，模拟如实标注）', m.b.includes('btnOcr') && m.b.includes('btnAsr') && m.b.includes(':8002') && m.b.includes('（模拟）'));

  /* ---- 未登录 ---- */
  ck('未登录状态可查（loggedIn=false）', j(await req('/api/v1/mobile/me')).loggedIn === false);
  ck('未登录访问记录接口被拒（401）', (await req('/api/v1/mobile/logins')).s === 401);

  /* ---- 绑定：失败也留痕 ---- */
  const bad = await req('/api/v1/mobile/bind', 'POST', { phone: '123', username: 'admin', password: '736669' });
  ck('手机号格式校验', bad.s === 400 && /11 位手机号/.test(j(bad).error));
  const badPwd = await req('/api/v1/mobile/bind', 'POST', { phone: PHONE, username: 'admin', password: 'wrong-pass' });
  ck('错误密码不伪造成功（401）', badPwd.s === 401);

  /* ---- 绑定成功：账号/岗位/部门与 PLM 同步 ---- */
  const ok = await req('/api/v1/mobile/bind', 'POST', { phone: PHONE, username: 'admin', password: '736669' });
  const cookie = ((ok.h['set-cookie'] || [''])[0] || '').split(';')[0];
  const user = j(ok).user || {};
  ck('手机号绑定成功并下发设备凭证', ok.s === 200 && cookie.startsWith('mdev='), cookie ? 'mdev 已下发' : '无 cookie');
  ck('返回体不含各系统令牌', !/eyJ|token|cookie/i.test(ok.b));
  ck('账号来自 PLM（姓名/账号）', user.username === 'admin' && !!user.name, user.name);
  ck('岗位由 PLM 角色映射', user.role === 'ADMIN' && user.position === '系统管理员', user.role + '/' + user.position);
  const people = j(await req('/api/v1/plm2/people')).people || [];
  const p0 = people.find(x => x.id === user.personId);
  ck('部门与 M10/PLM 人员一致', !!p0 && user.dept && (p0.dept === user.dept || p0.dept === 'RD' && user.dept === '研发中心'), user.dept + ' / ' + (p0 && p0.dept));
  ck('待办人员映射到 PLM 人员 ID', !!user.personId);

  /* ---- 自动登录（下次打开直接进） ---- */
  const me = j(await req('/api/v1/mobile/me', 'GET', null, cookie));
  ck('同机再次进入自动识别（me.loggedIn）', me.loggedIn === true && me.user && me.user.phone === PHONE);

  /* ---- 登录留痕 ---- */
  const logs = j(await req('/api/v1/mobile/logins', 'GET', null, cookie)).logins || [];
  ck('绑定与失败尝试都有记录', logs.some(x => x.ok && x.kind === 'bind') && logs.some(x => !x.ok), '共 ' + logs.length + ' 条');
  ck('记录含时间与账号', logs.every(x => !!x.at && (x.username || x.name)));

  /* ---- 待办：与 PLM/会议/总表同源 ---- */
  const todos = j(await req('/api/v1/plm2/me/todos?user=' + (user.personId || 0)));
  ck('待办走同一个人（PLM 计数结构存在）', typeof todos.todoCount === 'number' && Array.isArray(todos.overdue));
  ck('会议待办与总表待办同源可读', !!todos.meeting && Array.isArray(todos.taskhub && todos.taskhub.items));

  /* ---- 品质检验链路 ---- */
  const qc = j(await req('/api/v1/plm2/capture-types?role=QUALITY')).captureTypes || [];
  ck('质检岗位可做来料检验与拍照', qc.some(t => t.code === 'IQC') && qc.some(t => t.code === 'PHOTO'), qc.map(t => t.code).join(','));
  const eng = j(await req('/api/v1/plm2/capture-types?role=ENGINEER')).captureTypes || [];
  ck('工程岗位不能做 IQC（按岗位限制）', !eng.some(t => t.code === 'IQC') && eng.length > 0, eng.map(t => t.code).join(','));
  const mats = j(await req('/api/v1/plm2/materials?role=QUALITY')).materials || [];
  ck('真实物料可扫码匹配', mats.length > 0, '物料 ' + mats.length + ' 条');
  if (mats.length) {
    const key = String(mats[0].partNo).slice(0, 6);
    const fuzzy = j(await req('/api/v1/plm2/materials?role=QUALITY&q=' + encodeURIComponent(key)));
    ck('料号支持模糊查找', (fuzzy.materials || []).length > 0, '关键字 ' + key + ' 命中 ' + fuzzy.matched + ' 条');
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
  }

  /* ---- 退出与换账号 ---- */
  const out = await req('/api/v1/mobile/logout', 'POST', {}, cookie);
  ck('退出登录成功', out.s === 200);
  ck('退出后设备凭证失效', j(await req('/api/v1/mobile/me', 'GET', null, cookie)).loggedIn === false);
  const ok2 = await req('/api/v1/mobile/bind', 'POST', { phone: PHONE, username: 'admin', password: '736669' });
  const cookie2 = ((ok2.h['set-cookie'] || [''])[0] || '').split(';')[0];
  const logs2 = j(await req('/api/v1/mobile/logins', 'GET', null, cookie2)).logins || [];
  ck('重新绑定后历史记录仍在（可追溯）', logs2.length >= 3 && logs2.some(x => x.kind === 'logout'), '共 ' + logs2.length + ' 条');

  console.log('\n手机端自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
