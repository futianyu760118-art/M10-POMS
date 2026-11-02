'use strict';
// adapters/meeting — 会议助手待办接入（数据源：会议助手 /api/actions/mine 快照）
// 真实同步：scripts/sync-meeting-todos.js（MEETING_API + MEETING_COOKIE）
const fs = require('fs');
const path = require('path');

const SNAPSHOT = path.join(__dirname, '..', '..', 'configs', 'meeting-actions.json');

function loadSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')); }
  catch (e) { return { source: 'meeting-assistant', live: false, items: [], updatedAt: null, error: e.message }; }
}

const OWNER_ALIAS = { '包跃': ['包跃', 'baoyue'], '虞周峰': ['虞周峰', 'yuzhoufeng'], '孙周杰': ['孙周杰', 'sunzhoujie'], '聂晓敏': ['聂晓敏', 'niexiaomin'], '王栌鑫': ['王栌鑫', 'wangluxin'], '系统管理员': ['系统管理员', 'admin'], '朱剑军': ['朱剑军', 'zhujianjun'] };

function matchOwner(item, person) {
  if (!person) return false;
  const names = OWNER_ALIAS[person.name] || [person.name, person.username].filter(Boolean);
  const owner = String(item.owner || '').trim();
  const login = String(item.ownerLoginId || '').trim();
  return names.some(n => n && (n === owner || n.toLowerCase() === login.toLowerCase()));
}

// 状态映射：会议助手 → 我的待办分类
function classify(item, today) {
  if (item.status === 'done') return '已完成';
  if (item.status === 'blocked') return '异常';
  if (item.dueDate && item.dueDate < today) return '逾期';
  return '待办';
}

/**
 * 取某人会议待办
 * @param {{name:string, username?:string}} person
 * @returns {{source:string, live:boolean, updatedAt:string|null, connected:boolean, items:Array, counts:Object}}
 */
function listMine(person, opts) {
  const snap = loadSnapshot();
  const today = (opts && opts.today) || new Date().toISOString().slice(0, 10);
  const items = (snap.items || []).filter(x => matchOwner(x, person)).map(x => ({
    id: x.id,
    title: x.description,
    source: 'MEETING',
    sourceLabel: '会议助手',
    meetingTitle: x.meetingTitle || '',
    meetingDate: x.meetingDate || '',
    proposer: x.proposer || '',
    due: x.dueDate || null,
    priority: x.priority || 'medium',
    status: x.status,
    blockedReason: x.blockReason || null,
    completedAt: x.completedAt || null,
    category: classify(x, today),
    action: 'openMeeting',
    link: (opts && opts.meetingBase || '')
  }));
  const counts = { total: items.length, overdue: 0, todo: 0, done: 0, anomaly: 0 };
  items.forEach(i => {
    if (i.category === '逾期') counts.overdue++;
    else if (i.category === '异常') counts.anomaly++;
    else if (i.category === '已完成') counts.done++;
    else counts.todo++;
  });
  return {
    source: snap.source || 'meeting-assistant',
    live: !!snap.live,
    updatedAt: snap.updatedAt || null,
    connected: !!snap.items && snap.items.length > 0,
    items, counts
  };
}

module.exports = { listMine, loadSnapshot };
