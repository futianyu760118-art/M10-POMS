'use strict';
// scripts/seed-hlc-demo.js — 经 M10 BFF 在真实 HLC 造各状态演示工单（可重复执行，每次新增一组）。
// 用法：先启动 HLC 预览栈(18280) 与 BFF(4173)，然后 node scripts/seed-hlc-demo.js
const B = process.env.BFF_BASE || 'http://localhost:4173';

async function get(p) { const r = await fetch(B + p); if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`); return r.json(); }
async function post(p, body) {
  const r = await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST ${p} -> ${r.status}: ${j.error || ''}`);
  return j;
}
const tr = (id, actor, next_state, extra = {}) =>
  post(`/api/v1/hlc/service-requests/${id}/transitions`, { next_state, actor, ...extra });
const stamp = () => new Date().toISOString().slice(5, 16).replace('T', ' ');

(async () => {
  const st = await get('/api/v1/hlc/status');
  if (!st.connected) { console.error(`真实 HLC 未连接（${st.error || '?'}），先启动 HLC 预览栈`); process.exit(1); }
  console.log(`HLC 已连接: ${st.api}（服务账号 ${st.serviceUser}，映射演员 ${st.mappedActors.join('/')}）`);

  const ts = stamp();
  const made = [];

  // 1) 待受理（SUBMITTED）
  const s1 = await post('/api/v1/hlc/service-requests', { type: 'logistics_repair', subject: `车间流水线传送带异响 ${ts}`, description: '待受理演示单', requester: 'p-001', idempotency_key: 'seed-sub-' + Date.now() });
  made.push(`SUBMITTED  ${s1.id}  ${s1.subject}`);

  // 2) 处理中（IN_PROGRESS，执行人 p-003）
  const s2 = await post('/api/v1/hlc/service-requests', { type: 'logistics_repair', subject: `二楼办公区空调不制冷 ${ts}`, description: '处理中演示单', requester: 'p-004', idempotency_key: 'seed-prog-' + Date.now() });
  await tr(s2.id, 'p-002', 'TRIAGED');
  await tr(s2.id, 'p-002', 'ASSIGNED', { assignee: 'p-003', sla: '1 天', note: '加急' });
  await tr(s2.id, 'p-003', 'IN_PROGRESS');
  made.push(`IN_PROGRESS ${s2.id}  ${s2.subject}`);

  // 3) 待验收（AWAITING_ACCEPTANCE，已留证据）
  const s3 = await post('/api/v1/hlc/service-requests', { type: 'logistics_repair', subject: `仓库卷帘门电机更换 ${ts}`, description: '待验收演示单', requester: 'p-001', idempotency_key: 'seed-wait-' + Date.now() });
  await tr(s3.id, 'p-002', 'TRIAGED');
  await tr(s3.id, 'p-002', 'ASSIGNED', { assignee: 'p-003', sla: '2 天' });
  await tr(s3.id, 'p-003', 'IN_PROGRESS');
  await tr(s3.id, 'p-003', 'AWAITING_ACCEPTANCE', { evidence_ref: 'EVD-' + Date.now() % 100000, note: '电机已更换，试运行正常' });
  made.push(`AWAITING…   ${s3.id}  ${s3.subject}`);

  // 4) 已关闭（CLOSED，含 ResultRef，供"过去报告"页演示）
  const s4 = await post('/api/v1/hlc/service-requests', { type: 'logistics_repair', subject: `三楼会议室投影仪维修 ${ts}`, description: '已关闭演示单', requester: 'p-001', idempotency_key: 'seed-closed-' + Date.now() });
  await tr(s4.id, 'p-002', 'TRIAGED');
  await tr(s4.id, 'p-002', 'ASSIGNED', { assignee: 'p-003', sla: '3 天' });
  await tr(s4.id, 'p-003', 'IN_PROGRESS');
  await tr(s4.id, 'p-003', 'AWAITING_ACCEPTANCE', { evidence_ref: 'EVD-' + (Date.now() + 1) % 100000, note: '更换灯泡与线缆' });
  const closed = await tr(s4.id, 'p-002', 'CLOSED', { note: '验收通过' });
  made.push(`CLOSED      ${s4.id}  ${s4.subject}  → ${closed.result_ref}`);

  console.log('\n已写入真实 HLC：');
  made.forEach(l => console.log('  ' + l));
  const list = await get('/api/v1/hlc/service-requests');
  console.log(`\n当前真实工单总数: ${list.requests.length}（source=${list.source}）`);
  console.log(`打开演示页: http://localhost:4173/hlc`);
})().catch(e => { console.error('种子失败:', e.message); process.exit(1); });
