'use strict';
/**
 * 从会议助手同步「我的待办」到 M10 快照
 * 用法：
 *   MEETING_API=http://<会议助手地址> MEETING_COOKIE="<登录会话Cookie>" node scripts/sync-meeting-todos.js
 * 说明：
 *   - 会议助手 /api/actions/mine 需要用户会话，必须提供 Cookie（浏览器 F12 复制）
 *   - 未提供配置时明确报错退出，不伪造成功
 *   - 输出 configs/meeting-actions.json（供 M10 adapters/meeting 读取）
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const API = process.env.MEETING_API;
const COOKIE = process.env.MEETING_COOKIE;
const OUT = path.join(__dirname, '..', 'configs', 'meeting-actions.json');

if (!API || !COOKIE) {
  console.error('[sync-meeting] 缺少配置：请设置 MEETING_API 与 MEETING_COOKIE');
  console.error('  例：MEETING_API=http://192.168.0.71:3000 MEETING_COOKIE="next-auth.session-token=..." node scripts/sync-meeting-todos.js');
  process.exit(1);
}

function get(urlStr, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET',
      headers: { Cookie: cookie, Accept: 'application/json' }
    }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => {
        const text = Buffer.concat(c).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + text.slice(0, 200)));
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('非 JSON 响应: ' + text.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('超时')));
    req.end();
  });
}

(async () => {
  const base = API.replace(/\/$/, '');
  const json = await get(base + '/api/actions/mine', COOKIE);
  if (!json || json.success !== true || !Array.isArray(json.data)) {
    console.error('[sync-meeting] 返回结构异常：' + JSON.stringify(json).slice(0, 200));
    process.exit(2);
  }
  const items = json.data.map(x => ({
    id: x.id, description: x.description, owner: x.owner, ownerLoginId: x.ownerLoginId,
    proposer: x.proposer, dueDate: x.due_date, dueDateType: x.due_date_type,
    priority: x.priority, status: x.status,
    meetingId: x.meeting_id, meetingTitle: x.meeting_title, meetingDate: x.meeting_date,
    meetingOrganizer: x.meeting_organizer, meetingStatus: x.meeting_status,
    blockReason: x.block_reason, completedAt: x.completed_at
  }));
  const out = {
    source: 'meeting-assistant', repo: 'https://gitee.com/ningbohengjianguangdian/meeting.git',
    api: 'GET /api/actions/mine', live: true, updatedAt: new Date().toISOString(), items
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(`[sync-meeting] 已同步 ${items.length} 条待办 -> ${OUT}`);
})().catch(e => { console.error('[sync-meeting] 同步失败：' + e.message); process.exit(3); });
