'use strict';
// Hub Agent Runtime 适配器（Owner Hub / M11 / M13）
// Hub 是 Runtime 真相源，POMS 只引用；不得把 Hub 令牌放到浏览器里。
// 双模式：
//   - 真实 HTTP（配置 HUB_PASSWORD 或 configs/hub.local.json）：登录 → 读 /api/operating-center
//   - 未配置/未连接：listTodos 明确抛 503，不提供虚假成功
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const LOCAL_CONF = path.join(__dirname, '..', '..', 'configs', 'hub.local.json');
const HUB_CONNECTED = process.env.HUB_CONNECTED === '1';

function conf() {
  if (process.env.HUB_DISABLED === '1') return { api: '', account: '', password: '' };
  let file = {};
  try { file = JSON.parse(fs.readFileSync(LOCAL_CONF, 'utf8')); } catch (e) { /* 无本地配置 */ }
  return {
    api: (process.env.HUB_API || file.api || 'http://127.0.0.1:8787').replace(/\/$/, ''),
    account: process.env.HUB_ACCOUNT || file.account || 'admin',
    password: process.env.HUB_PASSWORD || file.password || ''
  };
}

function configured() { const c = conf(); return !!(c.api && c.password); }

const AGENTS = [
  { agent_id: 'agent-main', hub_agent_id: 'hub-main', name: '岗位主 Agent', role: 'personal', skills: ['任务拆解', '对象查询', 'Guard 前置校验'], autonomy_level: 'assist', guard_policy: '高风险动作需人工审批', status: HUB_CONNECTED ? 'connected' : 'simulated' },
  { agent_id: 'agent-quality', hub_agent_id: 'hub-quality', name: '品质检验子 Agent', role: 'pro', skills: ['检验模板加载', '测量记录', '结果汇总'], autonomy_level: 'assist', guard_policy: '不可自验 done=verified', status: HUB_CONNECTED ? 'connected' : 'simulated' },
  { agent_id: 'agent-sales', hub_agent_id: 'hub-sales', name: '销售开发子 Agent', role: 'pro', skills: ['公开线索检索', '线索评分', '跟进记录'], autonomy_level: 'supervised', guard_policy: '遵守隐私，禁止私自抓取', status: HUB_CONNECTED ? 'connected' : 'simulated' }
];

function listAgents() {
  // Agent 运行态以 Hub Runtime 为准：仅 HUB_CONNECTED=1 时视为已连接，其余标注 simulated
  return AGENTS.map(a => ({ ...a }));
}

/**
 * 从 M13 Hub 拉取真实「AI 港湾」Agent（已向 M01 注册），映射为 M10 智能体格式；
 * 未连接/失败时回退静态列表（标 simulated）。
 */
async function listHarborAgents() {
  if (configured() || HUB_CONNECTED) {
    try {
      const data = await getJson('/api/harbor');
      const agents = (Array.isArray(data.agents) ? data.agents : []).map(a => ({
        agent_id: a.id, hub_agent_id: a.id, name: a.name || a.id,
        role: (a.hierarchyLevel === 'L2' || /中枢|经营|编/.test(a.role || '')) ? 'personal' : 'pro',
        skills: Array.isArray(a.skills) ? a.skills : [],
        autonomy_level: a.autonomyLevel || 'assist',
        guard_policy: (a.instructions || '').slice(0, 80) || '高风险动作需人工审批',
        description: a.description || '', status: 'connected', provider: a.provider || ''
      }));
      if (agents.length) return { agents, source: 'hub-harbor' };
    } catch (e) { /* 港湾不可达回退静态列表 */ }
  }
  return { agents: AGENTS.map(a => ({ ...a })), source: 'static' };
}

let SESSION = { cookie: '', at: 0 };

function request(urlStr, opts) {
  const o = opts || {};
  const u = new URL(urlStr);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const body = o.body ? Buffer.from(JSON.stringify(o.body)) : null;
    const headers = Object.assign({ Accept: 'application/json' }, o.headers || {});
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    const req = lib.request({ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: o.method || 'GET', headers, timeout: 15000 }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Hub 请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

async function login() {
  const c = conf();
  if (!c.password) {
    const err = new Error('Hub 未配置登录凭据（HUB_PASSWORD 或 configs/hub.local.json）');
    err.status = 503;
    throw err;
  }
  const r = await request(c.api + '/api/auth/login', { method: 'POST', body: { account: c.account, password: c.password } });
  if (r.status !== 200) {
    const err = new Error('Hub 登录失败 HTTP ' + r.status + '：' + r.text.slice(0, 160));
    err.status = r.status === 401 ? 401 : 502;
    throw err;
  }
  const sc = r.headers['set-cookie'] || [];
  const cookie = (Array.isArray(sc) ? sc : [sc]).map(x => String(x).split(';')[0]).filter(Boolean).join('; ');
  if (!cookie) {
    const err = new Error('Hub 登录未返回会话 Cookie');
    err.status = 502;
    throw err;
  }
  SESSION = { cookie, at: Date.now() };
  return cookie;
}

async function getJson(pathname, retry) {
  const c = conf();
  const cookie = SESSION.cookie && (Date.now() - SESSION.at < 20 * 60 * 1000) ? SESSION.cookie : await login();
  const r = await request(c.api + pathname, { headers: { Cookie: cookie } });
  if (r.status === 401 && !retry) { SESSION = { cookie: '', at: 0 }; return getJson(pathname, true); }
  if (r.status !== 200) {
    const err = new Error('Hub ' + pathname + ' HTTP ' + r.status + '：' + r.text.slice(0, 160));
    err.status = r.status;
    throw err;
  }
  try { return JSON.parse(r.text); } catch (e) {
    const err = new Error('Hub ' + pathname + ' 非 JSON 响应'); err.status = 502; throw err;
  }
}

/**
 * Hub 待办：经营事项(cases) + 收件箱(inbox，排除 autopilot_result) + 待人工决策
 * @returns {{connected:boolean, api:string, items:Array, counts:Object}}
 */
async function listTodos(opts) {
  if (!configured() && !HUB_CONNECTED) {
    const err = new Error('Hub 未连接：需配置 HUB_PASSWORD / configs/hub.local.json（不做虚假成功）');
    err.status = 503;
    throw err;
  }
  const today = (opts && opts.today) || new Date().toISOString().slice(0, 10);
  const data = await getJson('/api/operating-center');
  const items = [];
  const CASE_ST = { open: 'pending', in_review: 'in_progress', awaiting_approval: 'blocked', closed: 'done' };

  (Array.isArray(data.cases) ? data.cases : []).forEach(c => {
    const st = CASE_ST[c.status] || 'pending';
    items.push({
      id: 'case:' + c.id, kind: 'case', title: c.title || ('经营事项 ' + (c.entityId || c.id)),
      ownerName: c.ownerRole || '', due: c.dueAt || null, priority: st === 'blocked' ? 'high' : 'medium',
      status: st, detail: [c.status, c.ownerRole, c.entityId].filter(Boolean).join(' · '),
      refs: { hubCaseId: c.id, entityId: c.entityId || null, evidenceRefs: c.evidenceRefs || [] },
      updatedAt: c.updatedAt || null
    });
  });

  (Array.isArray(data.inbox) ? data.inbox : []).filter(x => x.kind !== 'autopilot_result').forEach(x => {
    const pending = x.state === 'unread';
    items.push({
      id: 'inbox:' + x.id, kind: x.kind === 'decision_required' ? 'decision' : 'message',
      title: x.title || 'Hub 工作消息', ownerName: '', due: x.dueAt || null,
      priority: x.kind === 'decision_required' ? 'high' : 'medium',
      status: pending ? 'pending' : 'in_progress',
      detail: [x.kind === 'decision_required' ? '需人工决策' : '工作消息', x.caseId ? '事项 ' + x.caseId : null].filter(Boolean).join(' · '),
      refs: { hubInboxId: x.id, caseId: x.caseId || null, state: x.state || null },
      updatedAt: x.updatedAt || null
    });
  });

  const counts = { total: items.length };
  items.forEach(i => { counts[i.status] = (counts[i.status] || 0) + 1; });
  return { connected: true, api: conf().api, today, items, counts, unreadInbox: data.unreadInboxCount || 0 };
}

async function status() {
  if (!configured() && !HUB_CONNECTED) return { connected: false, mode: 'unconfigured', checkedAt: new Date().toISOString() };
  try {
    const d = await getJson('/api/auth/session');
    return { connected: !!d.authenticated, mode: 'http', api: conf().api, account: d.account || null, checkedAt: new Date().toISOString() };
  } catch (e) {
    return { connected: false, mode: 'http', api: conf().api, error: e.message, checkedAt: new Date().toISOString() };
  }
}

async function postJson(pathname, body, retry) {
  const c = conf();
  const cookie = SESSION.cookie && (Date.now() - SESSION.at < 20 * 60 * 1000) ? SESSION.cookie : await login();
  const r = await request(c.api + pathname, { method: 'POST', body, headers: { Cookie: cookie } });
  if (r.status === 401 && !retry) { SESSION = { cookie: '', at: 0 }; return postJson(pathname, body, true); }
  if (r.status !== 200) {
    const err = new Error('Hub ' + pathname + ' HTTP ' + r.status + '：' + r.text.slice(0, 160));
    err.status = r.status;
    throw err;
  }
  try { return JSON.parse(r.text); } catch (e) {
    const err = new Error('Hub ' + pathname + ' 非 JSON 响应'); err.status = 502; throw err;
  }
}

/**
 * M13 中枢智能体：调用 Hub 的真实 Agent Runtime 生成每日优先级问题（Codex 驱动）。
 * @param {{role?:string, today?:string}} opts
 */
async function dailyQuestions(opts) {
  const o = opts || {};
  const today = o.today || new Date().toISOString().slice(0, 10);
  const role = o.role || 'personal';
  const data = await postJson('/api/daily-questions/generate', { dateKey: today, role });
  return { connected: true, today, role, data };
}

/**
 * M13 中枢智能体：核查中台实时检索（基于 Hub 实时经营快照回答自由文本问题）。
 * @param {{query:string, source?:string}} opts
 */
async function search(opts) {
  const o = opts || {};
  const query = String(o.query || '').trim().slice(0, 160);
  if (!query) { const e = new Error('请输入问题'); e.status = 400; throw e; }
  const data = await postJson('/api/attention/search', { query, live: true });
  return { connected: true, query, source: 'all', data };
}

function openSession(agentId) {
  if (!HUB_CONNECTED) {
    const err = new Error('Hub unavailable');
    err.status = 503;
    throw err; // 未连接时不提供虚假成功
  }
  return { session_id: 'ses_' + Date.now(), agent_id: agentId, status: 'created' };
}

/** 用给定账号密码登录（统一登录用），成功则复用该会话 */
async function loginWith(account, password) {
  const c = conf();
  if (!c.api) return { ok: false, error: '未配置 Hub 地址' };
  try {
    const r = await request(c.api + '/api/auth/login', { method: 'POST', body: { account, password } });
    if (r.status !== 200) return { ok: false, status: r.status, error: 'Hub 账号或密码不正确' };
    const sc = r.headers['set-cookie'] || [];
    const cookie = (Array.isArray(sc) ? sc : [sc]).map(x => String(x).split(';')[0]).filter(Boolean).join('; ');
    if (!cookie) return { ok: false, error: 'Hub 登录未返回会话' };
    SESSION = { cookie, at: Date.now() };
    return { ok: true, account };
  } catch (e) { return { ok: false, error: 'Hub 连接失败：' + e.message }; }
}

module.exports = { listAgents, listHarborAgents, openSession, listTodos, status, configured, loginWith, dailyQuestions, search, HUB_CONNECTED, conf };
