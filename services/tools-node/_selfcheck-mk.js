const http = require('http');
function j(p) { return new Promise(r => http.get({ host: '127.0.0.1', port: 4173, path: p }, x => { let d = ''; x.on('data', c => d += c); x.on('end', () => r({ s: x.statusCode, b: d })); })); }
(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { ok ? (pass++, console.log('  [PASS] ' + n + (d ? ' | ' + d : ''))) : (fail++, console.log('  [FAIL] ' + n + (d ? ' | ' + d : ''))); };
  const P = JSON.parse((await j('/api/v1/plm2/projects')).b).projects.find(x => x.owner === '虞周峰');
  // ① 历史模板接口（PLM 真实表）
  const h = JSON.parse((await j('/api/v1/plm2/ws-history?projectNo=' + encodeURIComponent(P.projectNo) + '&nodeCode=SPEC')).b);
  ck('历史模板接口可用', h.source === 'plm' && Array.isArray(h.records), `source=${h.source} count=${h.count} model=${(h.records[0]||{}).model}`);
  ck('历史记录含项目相关字段', h.count === 0 || (h.records[0].project_no === P.projectNo || h.records[0].projectNo === P.projectNo), JSON.stringify(Object.keys(h.records[0]||{}).slice(0,6)));
  const h404 = await j('/api/v1/plm2/ws-history?projectNo=NOPE&nodeCode=SPEC');
  ck('历史接口 404 校验', h404.s === 404);
  // ② 页面要素
  const pg = (await j('/plm2')).b;
  ['mkLoadHist', 'mkTools', '甘特预览', '导出Excel', '审批流程图', '打开资料制作（真实模板 + 历史带入 + 工具）', "makeDoc('", '历史模板：'].forEach(k => ck('页面含：' + k, pg.includes(k)));
  ck('待办行有制作按钮（todoRowHtml 内 makeDoc）', pg.includes("event.stopPropagation();makeDoc("));
  ck('节点编辑弹窗有打开制作（ndBody 内）', pg.includes("ndModal').hidden=true;makeDoc("));
  console.log('\n模板历史+工具+入口自查: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
