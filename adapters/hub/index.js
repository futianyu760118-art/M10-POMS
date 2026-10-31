'use strict';
// Hub Agent Runtime 的 mock adapter（Owner Hub / M11）。
// Hub 为 Runtime 真相源，POMS 只引用；不得把 Hub 服务端令牌放浏览器里。
const HUB_CONNECTED = process.env.HUB_CONNECTED === '1';

const AGENTS = [
  { agent_id: 'agent-main', hub_agent_id: 'hub-main', name: '岗位主 Agent', role: 'personal', skills: ['任务拆解', '对象查询', 'Guard 前置校验'], autonomy_level: 'assist', guard_policy: '高风险动作需人工审批', status: HUB_CONNECTED ? 'connected' : 'simulated' },
  { agent_id: 'agent-quality', hub_agent_id: 'hub-quality', name: '品质检验子 Agent', role: 'pro', skills: ['检验模板加载', '测量记录', '结果汇总'], autonomy_level: 'assist', guard_policy: '不可自验 done=verified', status: HUB_CONNECTED ? 'connected' : 'simulated' },
  { agent_id: 'agent-sales', hub_agent_id: 'hub-sales', name: '销售开发子 Agent', role: 'pro', skills: ['公开线索检索', '线索评分', '跟进记录'], autonomy_level: 'supervised', guard_policy: '遵守隐私，禁止私自抓取', status: HUB_CONNECTED ? 'connected' : 'simulated' }
];

function listAgents() {
  return AGENTS.map(a => ({ ...a }));
}

function openSession(agentId) {
  if (!HUB_CONNECTED) {
    const err = new Error('Hub unavailable');
    err.status = 503;
    throw err; // 未连接时不提供虚假成功
  }
  return { session_id: 'ses_' + Date.now(), agent_id: agentId, status: 'created' };
}

module.exports = { listAgents, openSession, HUB_CONNECTED };
