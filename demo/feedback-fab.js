/* 页面反馈组件：每个页面右上角/右下角注入「反馈」悬浮按钮 + 提交表单，写回 PLM 反馈中心。 */
(function () {
  if (window.__feedbackFabLoaded) return;
  window.__feedbackFabLoaded = true;

  var css = [
    '#__fbFab{position:fixed;right:18px;bottom:18px;z-index:9990;width:44px;height:44px;border-radius:50%;border:0;background:#2563eb;color:#fff;font-size:13px;cursor:pointer;box-shadow:0 4px 16px rgba(37,99,235,.35);display:flex;align-items:center;justify-content:center}',
    '#__fbFab:hover{background:#1d4ed8}',
    '#__fbMask{position:fixed;inset:0;background:rgba(10,20,35,.5);z-index:9995;display:none;align-items:center;justify-content:center}',
    '#__fbMask.on{display:flex}',
    '#__fbBox{background:#fff;border-radius:14px;width:92%;max-width:420px;max-height:86vh;overflow:auto;padding:18px;box-shadow:0 12px 40px rgba(15,39,68,.25)}',
    '#__fbBox h3{margin:0 0 14px;font-size:16px}',
    '#__fbBox label{display:block;font-size:12px;color:#6b7280;margin:10px 0 5px}',
    '#__fbBox .row{display:flex;gap:8px;flex-wrap:wrap}',
    '#__fbBox .opt{border:1px solid #d5dfec;background:#fff;border-radius:18px;padding:4px 12px;font-size:12px;cursor:pointer;color:#374151}',
    '#__fbBox .opt.on{background:#eff6ff;border-color:#93c5fd;color:#1d4ed8}',
    '#__fbBox input,#__fbBox textarea{width:100%;box-sizing:border-box;border:1px solid #d5dfec;border-radius:9px;padding:9px 11px;font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
    '#__fbBox textarea{min-height:80px;resize:vertical}',
    '#__fbBox .btns{display:flex;gap:8px;margin-top:14px;justify-content:flex-end}',
    '#__fbBox button.btn{border:1px solid #d5dfec;background:#fff;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}',
    '#__fbBox button.btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}',
    '#__fbBox .path{font-size:11px;color:#9ca3af;margin-top:10px;word-break:break-all}'
  ].join('\n');

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }

  var fab = document.createElement('button');
  fab.id = '__fbFab';
  fab.textContent = '反馈';
  fab.title = '提交问题/建议反馈';
  document.body.appendChild(fab);

  var mask = document.createElement('div');
  mask.id = '__fbMask';
  mask.innerHTML = '<div id="__fbBox">' +
    '<h3>问题反馈</h3>' +
    '<label>类型</label><div class="row" data-k="type">' +
    '<span class="opt on" data-v="suggestion">建议</span><span class="opt" data-v="issue">问题</span><span class="opt" data-v="inquiry">咨询</span></div>' +
    '<label>严重度</label><div class="row" data-k="severity">' +
    '<span class="opt" data-v="low">低</span><span class="opt on" data-v="medium">中</span><span class="opt" data-v="high">高</span></div>' +
    '<label>标题</label><input id="__fbTitle" maxlength="256" placeholder="一句话概括问题或建议">' +
    '<label>描述</label><textarea id="__fbDesc" maxlength="2000" placeholder="请描述问题现象、复现步骤或建议内容"></textarea>' +
    '<div class="btns"><button class="btn" id="__fbCancel">取消</button><button class="btn primary" id="__fbSubmit">提交</button></div>' +
    '<div class="path">所在页面：' + esc(location.pathname) + '</div>' +
    '</div>';
  document.body.appendChild(mask);

  var val = { type: 'suggestion', severity: 'medium' };
  function bindGroups() {
    mask.querySelectorAll('.row[data-k]').forEach(function (row) {
      row.querySelectorAll('.opt').forEach(function (o) {
        o.onclick = function () {
          row.querySelectorAll('.opt').forEach(function (x) { x.classList.remove('on'); });
          o.classList.add('on');
          val[row.getAttribute('data-k')] = o.getAttribute('data-v');
        };
      });
    });
  }
  bindGroups();

  function toast(msg, ok) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);background:' + (ok ? '#15803d' : '#b91c1c') + ';color:#fff;padding:9px 16px;border-radius:22px;font-size:13px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.2)';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }

  fab.onclick = function () { mask.classList.add('on'); };
  mask.querySelector('#__fbCancel').onclick = function () { mask.classList.remove('on'); };
  mask.addEventListener('click', function (e) { if (e.target === mask) mask.classList.remove('on'); });

  mask.querySelector('#__fbSubmit').onclick = async function () {
    var title = mask.querySelector('#__fbTitle').value.trim();
    var desc = mask.querySelector('#__fbDesc').value.trim();
    if (!title && !desc) { toast('请填写反馈标题或描述', false); return; }
    var btn = mask.querySelector('#__fbSubmit'); btn.disabled = true; btn.textContent = '提交中…';
    try {
      var r = await fetch('/api/v1/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: val.type, severity: val.severity, title: title, description: desc, pagePath: location.pathname })
      });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      toast('反馈已提交，编号 ' + (j.feedback && j.feedback.id ? '#' + j.feedback.id : ''), true);
      mask.classList.remove('on');
      mask.querySelector('#__fbTitle').value = '';
      mask.querySelector('#__fbDesc').value = '';
    } catch (e) {
      toast('反馈提交失败：' + e.message, false);
    } finally {
      btn.disabled = false; btn.textContent = '提交';
    }
  };
})();
