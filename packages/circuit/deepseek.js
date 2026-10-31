'use strict';
// packages/circuit/deepseek.js — DeepSeek 大模型接入：BOM/需求 → 结构化电路（元件 + 网表）。
// key 优先取环境变量 DEEPSEEK_API_KEY，否则读 configs/deepseek.key（已 gitignore）。
const https = require('https');
const fs = require('fs');
const path = require('path');

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const f = path.join(__dirname, '..', '..', 'configs', 'deepseek.key');
    return fs.readFileSync(f, 'utf8').trim();
  } catch (e) { return ''; }
}

function chat(messages, opts) {
  return new Promise((resolve, reject) => {
    const key = apiKey();
    if (!key) return reject(new Error('缺少 DeepSeek API key（DEEPSEEK_API_KEY 或 configs/deepseek.key）'));
    const data = JSON.stringify(Object.assign({ model: 'deepseek-chat', messages, temperature: 0.2, max_tokens: 4000 }, opts));
    const req = https.request({
      host: 'api.deepseek.com', path: '/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'Content-Length': Buffer.byteLength(data) },
      timeout: 120000
    }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, raw: b }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('DeepSeek 调用超时')); });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

const PROMPT = `你是资深电源/照明电子工程师。请分析这份电路物料清单（BOM）或需求描述，只输出一个 JSON 对象（不要任何解释文字、不要 markdown 代码块），结构如下：
{"title":"电路标题","topology":"拓扑","components":[{"designator":"U1","type":"IC_LED_DRIVER","value":"LT3756","function":"主控"}],"connections":[{"net":"SW","nodes":["U1.SW","L1.2","Q1.drain","D1.anode"]}]}
要求：
1. components 的 type 用枚举：IC_LED_DRIVER / COB_LED / N_MOSFET / P_MOSFET / POWER_INDUCTOR / SCHOTTKY_DIODE / CURRENT_SENSE_RESISTOR / RESETTABLE_FUSE / NTC_THERMISTOR / ELECTROLYTIC_CAP / CERAMIC_CAP / BUTTON_DIMMING_INTERFACE / RESISTOR / GENERIC
2. connections 是网表：每个 net 名 + 节点列表（用 位号.引脚 表示，如 U1.SW、Q1.drain、L1.2）
3. 覆盖关键连接：输入、SW 开关节点、输出 LED 回路、电流采样、调光/温度检测、地
4. designator 用标准位号（U/LED/Q/L/D/R/F/NTC/C/SW）`;

// BOM/需求 → 结构化电路 { title, topology, components, connections }
async function analyze(text) {
  const r = await chat([{ role: 'user', content: PROMPT + '\n\n输入：\n' + String(text) }], { response_format: { type: 'json_object' } });
  if (r.status !== 200) {
    let msg = 'DeepSeek 调用失败(' + r.status + ')';
    try { const j = JSON.parse(r.raw); msg = j.error && j.error.message || msg; } catch (e) {}
    throw Object.assign(new Error(msg), { status: 502 });
  }
  const j = JSON.parse(r.raw);
  const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content) throw Object.assign(new Error('DeepSeek 返回为空'), { status: 502 });
  const parsed = JSON.parse(content);
  if (!parsed.components || !Array.isArray(parsed.components)) throw new Error('解析结果缺少 components');
  return parsed;
}

// 基于当前电路 + 修改指令 → 新结构化电路（AI 编辑）
async function editStructure(structure, instruction) {
  const prompt = '你是资深电源/照明电子工程师。这是当前电路的结构化描述（JSON）：\n' +
    JSON.stringify(structure) +
    '\n\n用户要求修改：' + String(instruction) +
    '\n\n请输出修改后的完整 JSON（结构必须与输入一致：title/topology/components/connections，type 仍用之前的枚举），只输出 JSON，不要解释。';
  const r = await chat([{ role: 'user', content: prompt }], { response_format: { type: 'json_object' }, temperature: 0.2 });
  if (r.status !== 200) {
    let msg = 'DeepSeek 调用失败(' + r.status + ')';
    try { const j = JSON.parse(r.raw); msg = j.error && j.error.message || msg; } catch (e) {}
    throw Object.assign(new Error(msg), { status: 502 });
  }
  const j = JSON.parse(r.raw);
  const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content) throw Object.assign(new Error('DeepSeek 返回为空'), { status: 502 });
  const parsed = JSON.parse(content);
  if (!parsed.components || !Array.isArray(parsed.components)) throw new Error('修改结果缺少 components');
  return parsed;
}

module.exports = { analyze, editStructure, chat, apiKey };
