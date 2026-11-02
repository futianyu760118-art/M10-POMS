'use strict';
/**
 * 从会议助手同步待办到 M10 快照（configs/meeting-actions.json）
 *
 * 全量模式（默认，接入会议中心所有待办）：
 *   MEETING_API=http://<会议助手> MEETING_LOGINID=<管理员loginid> node scripts/sync-meeting-todos.js
 *   # 或已有会话：MEETING_API=... MEETING_COOKIE="meeting_session=..." node scripts/sync-meeting-todos.js
 * 仅本人：MEETING_SCOPE=mine（走 /api/actions/mine）
 *
 * 可选：MEETING_STATUS=pending,in_progress（服务端过滤）、MEETING_OUT=输出路径、MEETING_TENANT
 * 说明：未提供配置时明确报错退出，不伪造成功；数量为 0 时如实写空并给出警告。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const API = (process.env.MEETING_API || '').replace(/\/$/, '');
const COOKIE = process.env.MEETING_COOKIE || '';
const LOGINID = process.env.MEETING_LOGINID || '';
const SCOPE = (process.env.MEETING_SCOPE || 'all').toLowerCase() === 'mine' ? 'mine' : 'all';
const STATUS = process.env.MEETING_STATUS || '';
const OUT = process.env.MEETING_OUT || path.join(__dirname, '..', 'configs', 'meeting-actions.json');

if (!API) {
  console.error('[sync-meeting] 缺少配置：MEETING_API');
  console.error('  全量：MEETING_API=http://<会议助手> MEETING_LOGINID=<管理员loginid> node scripts/sync-meeting-todos.js');
  console.error('  会话：MEETING_API=http://<会议助手> MEETING_COOKIE="meeting_session=..." node scripts/sync-meeting-todos.js');
  process.exit(1);
}
if (!COOKIE && !LOGINID) {
  console.error('[sync-meeting] 缺少鉴权：MEETING_COOKIE 或 MEETING_LOGINID（会议助手接口需要登录会话）');
  process.exit(1);
}

function call(urlStr, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const body = o.body ? Buffer.from(JSON.stringify(o.body)) : null;
    const headers = Object.assign({ Accept: 'application/json' }, o.headers || {});
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    const req = lib.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: o.method || 'GET', headers
    }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const text = Buffer.concat(c).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('超时')));
    if (body) req.write(body);
    req.end();
  });
}

const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};

(async () => {
  let cookie = COOKIE;

  if (!cookie && LOGINID) {
    const r = await call(API + '/api/auth/login', { method: 'POST', body: { loginid: LOGINID } });
    if (r.status !== 200) {
      console.error('[sync-meeting] 登录失败 HTTP ' + r.status + '：' + r.text.slice(0, 200));
      process.exit(2);
    }
    const sc = r.headers['set-cookie'] || [];
    const c = (Array.isArray(sc) ? sc : [sc]).map(x => String(x).split(';')[0]).filter(Boolean).join('; ');
    if (!c) {
      console.error('[sync-meeting] 登录响应未返回会话 Cookie（会议助手登录接口行为可能变化）');
      process.exit(2);
    }
    cookie = c;
    let who = {};
    try { const j = JSON.parse(r.text); who = (j && j.data) || {}; } catch (e) { /* ignore */ }
    console.log('[sync-meeting] 已登录：' + LOGINID + (who.name ? '（' + who.name + '，' + (who.role || '') + '）' : ''));
  }

  const endpoint = SCOPE === 'mine' ? '/api/actions/mine' : '/api/actions';
  const qs = [];
  if (STATUS) qs.push('status=' + encodeURIComponent(STATUS));
  const url = API + endpoint + (qs.length ? '?' + qs.join('&') : '');

  const r = await call(url, { headers: { Cookie: cookie } });
  if (r.status !== 200) {
    console.error('[sync-meeting] 拉取失败 HTTP ' + r.status + '：' + r.text.slice(0, 300));
    process.exit(2);
  }
  let json;
  try { json = JSON.parse(r.text); } catch (e) {
    console.error('[sync-meeting] 非 JSON 响应：' + r.text.slice(0, 200));
    process.exit(2);
  }
  const list = Array.isArray(json) ? json : (json.data || json.items || []);
  if (!Array.isArray(list)) {
    console.error('[sync-meeting] 响应结构未识别（期望数组或 data[]）：' + r.text.slice(0, 200));
    process.exit(2);
  }

  const items = list.map(x => ({
    id: x.id,
    description: x.description || x.title || '',
    owner: x.owner || '',
    ownerLoginId: x.ownerLoginId || x.owner_login_id || '',
    ownerOaId: x.ownerOaId || x.owner_oa_id || '',
    dept: x.dept || '',
    proposer: x.proposer || '',
    proposerDept: x.proposer_dept || x.proposerDept || '',
    proposerLoginId: x.proposerLoginId || x.proposer_login_id || '',
    dueDate: x.due_date || x.dueDate || null,
    dueDateType: x.due_date_type || x.dueDateType || 'date',
    priority: x.priority || 'medium',
    status: x.status || 'pending',
    sourceType: x.source_type || x.sourceType || '',
    blockReason: x.blockedBy || x.blockReason || null,
    completedAt: x.completedAt || x.completed_at || null,
    updatedAt: x.updatedAt || x.updated_at || null,
    meetingId: x.meetingId || x.meeting_id || null,
    meetingTitle: x.meetingTitle || x.meeting_title || '',
    meetingDate: x.meetingDate || x.meeting_date || '',
    meetingOrganizer: x.meetingOrganizer || x.meeting_organizer || '',
    meetingStatus: x.meetingStatus || x.meeting_status || ''
  })).filter(x => x.id && x.description);

  const counts = { total: items.length, pending: 0, in_progress: 0, done: 0, blocked: 0, cancelled: 0 };
  items.forEach(x => { if (counts[x.status] !== undefined) counts[x.status]++; });

  const out = {
    source: 'meeting-assistant',
    repo: 'https://gitee.com/ningbohengjianguangdian/meeting.git',
    live: true,
    scope: SCOPE,
    api: API,
    statusFilter: STATUS || null,
    updatedAt: new Date().toISOString(),
    today: todayStr(),
    counts,
    items
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');

  console.log('[sync-meeting] 已写入 ' + OUT);
  console.log('[sync-meeting] 范围=' + SCOPE + ' 共 ' + items.length + ' 条：待办 ' + counts.pending + ' / 进行中 ' + counts.in_progress + ' / 逾期未单列 / 完成 ' + counts.done + ' / 阻塞 ' + counts.blocked + ' / 取消 ' + counts.cancelled);
  if (!items.length) console.warn('[sync-meeting] 警告：接口返回 0 条，已如实写空（请确认权限/范围/状态过滤）');
})().catch(e => {
  console.error('[sync-meeting] 失败：' + (e && e.message ? e.message : e));
  process.exit(2);
});
