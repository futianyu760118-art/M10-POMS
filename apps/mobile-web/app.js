'use strict';
// PWA 示例：通过 BFF 获取装配结果（L0）。
const ACTORS = [
  { id: 'u-1001', label: '张三 · 恒剑 质检员' },
  { id: 'u-1002', label: '李四 · 恒剑 质检员+研发（兼岗）' },
  { id: 'u-2001', label: '王五 · 贞观 质检员' }
];

function init() {
  const sel = document.getElementById('actor');
  sel.innerHTML = '';
  ACTORS.forEach(a => {
    const o = document.createElement('option');
    o.value = a.id; o.textContent = a.label;
    sel.add(o);
  });
}

async function load() {
  const actor = document.getElementById('actor').value;
  const family = document.getElementById('family').value;
  const params = new URLSearchParams({ actor_id: actor });
  if (family) params.set('product_family', family);
  const res = await fetch('/poms/v1/me/manifest?' + params.toString());
  const data = await res.json();
  const raw = document.getElementById('raw');
  const sum = document.getElementById('summary');
  raw.textContent = JSON.stringify(data, null, 2);
  if (res.ok) {
    const chips = (data.capability_ids || []).map(c => `<span class="chip">${c}</span>`).join('');
    const pack = data.product_pack
      ? `<div class="badge">产品包 ${data.product_pack.pack_id} · ${data.product_pack.status}</div>`
      : '<div class="badge">未选择产品包</div>';
    sum.innerHTML = `<div>${chips}</div><div style="margin-top:8px">${pack}</div>`;
  } else {
    sum.innerHTML = `<div class="badge">错误 ${res.status}</div>`;
  }
}

init();
document.getElementById('actor') && load();
