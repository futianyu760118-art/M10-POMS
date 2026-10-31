'use strict';
// adapters/plm2/sync — M10 ↔ M04 PLM 实时同步层（经 PLM REST API，不直连库写入）。
// 用法：putNode / getNodeMatrix / putProject；登录令牌自动缓存与续期。
const http = require('http');

const API_BASE = process.env.PLM_API || 'http://127.0.0.1:8081';
const _u = API_BASE.replace(/^https?:\/\//, '');
const HOST = _u.split(':')[0];
const PORT = Number(_u.split(':')[1] || 80);
const USER = process.env.PLM_USER || 'admin';
const PASS = process.env.PLM_PASS || '736669';

let token = null, tokenAt = 0;

function call(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const s = body ? JSON.stringify(body) : null;
    const o = { host: HOST, port: PORT, path: '/api' + apiPath, method, headers: { 'Content-Type': 'application/json' } };
    if (token) o.headers.Authorization = 'Bearer ' + token;
    if (s) o.headers['Content-Length'] = Buffer.byteLength(s);
    const q = http.request(o, x => {
      const c = []; x.on('data', d => c.push(d));
      x.on('end', () => {
        const txt = Buffer.concat(c).toString('utf8');
        let j = null; try { j = JSON.parse(txt); } catch (e) { /* non-json */ }
        resolve({ status: x.statusCode, body: j, raw: txt });
      });
    });
    q.on('error', reject);
    q.setTimeout(8000, () => q.destroy(new Error('PLM API 超时')));
    if (s) q.write(s);
    q.end();
  });
}

async function login() {
  const r = await call('POST', '/auth/login', { username: USER, password: PASS });
  const t = r.body && r.body.data && r.body.data.token;
  if (r.status === 200 && t) { token = t; tokenAt = Date.now(); return t; }
  throw Object.assign(new Error('PLM 登录失败(' + r.status + ')'), { status: 502 });
}

async function authed(method, apiPath, body) {
  if (!token || Date.now() - tokenAt > 25 * 60 * 1000) await login();
  let r = await call(method, apiPath, body);
  if (r.status === 401) { token = null; await login(); r = await call(method, apiPath, body); }
  return r;
}

/** 节点写回：PUT /api/project/{id}/nodes/{code} body{status,planDate,actualDate,owner?,deliveryDesc?,remark?} */
async function putNode(plmId, code, payload) {
  try {
    const r = await authed('PUT', `/project/${plmId}/nodes/${encodeURIComponent(code)}`, payload);
    const ok = r.status === 200 && (!r.body || r.body.code === undefined || r.body.code === 200);
    return { ok, status: r.status, msg: ok ? '' : (r.body && r.body.message) || String(r.status) };
  } catch (e) { return { ok: false, status: 0, msg: e.message }; }
}

/** 节点矩阵拉取：GET /api/project/{id}/nodes → {project,nodes[],summary} */
async function getNodeMatrix(plmId) {
  const r = await authed('GET', `/project/${plmId}/nodes`);
  if (r.status === 200 && r.body && r.body.data && Array.isArray(r.body.data.nodes)) return r.body.data;
  throw Object.assign(new Error('矩阵拉取失败(' + r.status + ')'), { status: 502 });
}

/** 项目写回：PUT /api/v1/projects body{ id, projectName?, owner?, currentGate?, customerName?, riskLevel? } */
async function putProject(plmId, payload) {
  try {
    const r = await authed('PUT', '/v1/projects', Object.assign({ id: plmId }, payload));
    const ok = r.status === 200 && (!r.body || r.body.code === undefined || r.body.code === 200);
    return { ok, status: r.status, msg: ok ? '' : (r.body && r.body.message) || String(r.status) };
  } catch (e) { return { ok: false, status: 0, msg: e.message }; }
}

/** 用指定账密登录（M10 统一认证：与 M04 同一账号体系），返回 {token, claims} */
async function loginWith(username, password) {
  const r = await call('POST', '/auth/login', { username, password });
  const t = r.body && r.body.data && r.body.data.token;
  if (r.status === 200 && t) {
    token = t; tokenAt = Date.now();
    return { token: t, vo: r.body.data };
  }
  const msg = (r.body && r.body.message) || ('登录失败(' + r.status + ')');
  throw Object.assign(new Error(msg), { status: r.status === 200 ? 401 : r.status });
}

/** 用指定令牌取当前用户（GET /auth/info → LoginVO），校验令牌有效性 */
async function infoWith(tok) {
  const saved = token; token = tok;
  try {
    const r = await call('GET', '/auth/info', null);
    if (r.status === 200 && r.body && r.body.data) return r.body.data;
    throw Object.assign(new Error((r.body && r.body.message) || '令牌无效'), { status: 401 });
  } finally { token = saved; }
}

/** 资料归档：POST /api/v1/rd/sheets/{type}（同步到 PLM 对应业务表） */
async function createSheet(type, payload) {
  try {
    const r = await authed('POST', `/v1/rd/sheets/${encodeURIComponent(type)}`, payload);
    const ok = r.status === 200 && (!r.body || r.body.code === undefined || r.body.code === 200);
    return { ok, status: r.status, msg: ok ? '' : (r.body && r.body.message) || String(r.status) };
  } catch (e) { return { ok: false, status: 0, msg: e.message }; }
}

/** 历史模板：GET /api/v1/rd/sheets/{type}?projectNo=（该项目该类型已归档的真实记录） */
async function listSheets(type, projectNo) {
  const r = await authed('GET', `/v1/rd/sheets/${encodeURIComponent(type)}?projectNo=${encodeURIComponent(projectNo)}&page=1&size=20`);
  if (r.status === 200 && r.body) return r.body.data;
  throw Object.assign(new Error('历史模板拉取失败(' + r.status + ')'), { status: 502 });
}

module.exports = { putNode, getNodeMatrix, putProject, login, loginWith, infoWith, createSheet, listSheets, API_BASE };
