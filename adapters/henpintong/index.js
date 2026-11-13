'use strict';
// adapters/henpintong — 恒聘通（HLC / M07 人力后勤）数据供给 API 只读接入
// 鉴权：AppKey + AppSecret + HMAC-SHA256 签名（X-App-Key / X-Timestamp / X-Signature）
// 只读引用：员工/部门/岗位/组织/合同/请假申请/考勤/薪资/招聘 共 14 个接口。
// 不写业务数据；不可达时明确 503，不做虚假成功。
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const LOCAL_CONF = path.join(__dirname, '..', '..', 'configs', 'henpintong.local.json');
function localConf() { try { return JSON.parse(fs.readFileSync(LOCAL_CONF, 'utf8')); } catch (e) { return {}; } }
function apiBase() { return (process.env.HENG_PINTONG_API || localConf().api || 'https://hengpintong.com/api/v1/external').replace(/\/$/, ''); }
function appKey() { return process.env.HENG_PINTONG_APP_KEY || localConf().appKey || ''; }
function appSecret() { return process.env.HENG_PINTONG_APP_SECRET || localConf().appSecret || ''; }

const ENDPOINTS = {
  employees: { code: 'employees.list', path: '/employees/list', label: '员工列表' },
  departments: { code: 'departments.list', path: '/departments/list', label: '部门列表' },
  positions: { code: 'positions.list', path: '/positions/list', label: '岗位列表' },
  organizationsTree: { code: 'organizations.tree', path: '/organizations/tree', label: '组织树' },
  contracts: { code: 'contracts.list', path: '/contracts/list', label: '合同列表' },
  employeeRequests: { code: 'employee_requests.list', path: '/employee-requests/list', label: '员工申请' },
  attendancePunches: { code: 'attendance.punches.list', path: '/attendance/punches/list', label: '原始打卡' },
  attendanceTimesheets: { code: 'attendance.timesheets.list', path: '/attendance/timesheets/list', label: '日考勤明细' },
  attendanceSummaries: { code: 'attendance.summaries.list', path: '/attendance/summaries/list', label: '月度考勤汇总' },
  attendanceSchedules: { code: 'attendance.schedules.list', path: '/attendance/schedules/list', label: '排班日历' },
  payrollSalaryProfiles: { code: 'payroll.salary_profiles.list', path: '/payroll/salary-profiles/list', label: '薪资档案' },
  payrollRecords: { code: 'payroll.records.list', path: '/payroll/records/list', label: '月度工资' },
  recruitmentCandidates: { code: 'recruitment.candidates.list', path: '/recruitment/candidates/list', label: '招聘候选人' },
  recruitmentOffers: { code: 'recruitment.offers.list', path: '/recruitment/offers/list', label: 'Offer 列表' }
};

function configured() { return !!(apiBase() && appKey() && appSecret()); }

// 待签名串：timestamp + app_key + endpoint_code + query_string；HMAC-SHA256 后转 hex 小写
function signHeaders(endpointCode, queryString) {
  const ts = String(Math.floor(Date.now() / 1000));
  const str = ts + appKey() + endpointCode + queryString;
  const sig = crypto.createHmac('sha256', appSecret()).update(str, 'utf8').digest('hex');
  return { 'X-App-Key': appKey(), 'X-Timestamp': ts, 'X-Signature': sig };
}

function buildQuery(params) {
  if (!params) return '';
  const keys = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '');
  keys.sort();
  return keys.map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]))).join('&');
}

function get(key, params) {
  const ep = ENDPOINTS[key];
  if (!ep) { const e = new Error('未知的恒聘通接口：' + key); e.status = 400; return Promise.reject(e); }
  if (!configured()) { const e = new Error('未配置恒聘通（HENG_PINTONG_API / HENG_PINTONG_APP_KEY / HENG_PINTONG_APP_SECRET）'); e.status = 503; return Promise.reject(e); }
  const qs = buildQuery(params);
  const headers = Object.assign({ Accept: 'application/json' }, signHeaders(ep.code, qs));
  return new Promise((resolve, reject) => {
    const u = new URL(apiBase() + ep.path + (qs ? '?' + qs : ''));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET', headers, timeout: 12000
    }, res => {
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) { /* non-json */ }
        if (res.statusCode === 200 && json && json.code === 0) return resolve({ ok: true, data: json.data, raw: json });
        const msg = (json && (json.message || json.msg)) || ('恒聘通返回 ' + res.statusCode);
        const e = new Error(typeof msg === 'string' ? msg : '恒聘通请求失败');
        e.status = res.statusCode === 200 ? 502 : res.statusCode;
        reject(e);
      });
    });
    req.on('error', e => { const er = new Error('恒聘通连接失败：' + e.message); er.status = 503; reject(er); });
    req.setTimeout(12000, () => req.destroy(new Error('恒聘通请求超时')));
    req.end();
  });
}

async function status() {
  if (!configured()) return { connected: false, configured: false, api: apiBase() || null, error: '未配置恒聘通（HENG_PINTONG_APP_KEY/APP_SECRET）' };
  try {
    await get('employees', { page: 1, page_size: 1 });
    return { connected: true, configured: true, api: apiBase(), checkedAt: new Date().toISOString() };
  } catch (e) {
    return { connected: false, configured: true, api: apiBase(), error: e.message, checkedAt: new Date().toISOString() };
  }
}

// 各只读接口的封装（惰性导出，签名在每个请求内计算）
function listEmployees(p) { return get('employees', p); }
function listDepartments(p) { return get('departments', p); }
function listPositions(p) { return get('positions', p); }
function organizationsTree(p) { return get('organizationsTree', p); }
function listContracts(p) { return get('contracts', p); }
function listEmployeeRequests(p) { return get('employeeRequests', p); }
function listAttendanceSummaries(p) { return get('attendanceSummaries', p); }
function listPayrollRecords(p) { return get('payrollRecords', p); }

const KIND_LABEL = { leave: '请假', overtime: '加班', business_trip: '出差', clock_fix: '补卡', other: '员工申请' };

// HLC 待办：员工申请（请假/加班/出差/补卡）→ 待办总表统一归集
async function listTodos(opts) {
  const o = opts || {};
  const out = [];
  const counts = { leave: 0, overtime: 0, business_trip: 0, clock_fix: 0, other: 0 };
  const r = await get('employeeRequests', { page: 1, page_size: 50 });
  const items = (r.data && (r.data.items || r.data.list)) || [];
  items.forEach(x => {
    const st = String(x.status || '').toLowerCase();
    if (st === 'rejected' || st === 'cancelled' || st === 'canceled' || st === 'approved') return; // 只留待处理/处理中
    const type = String(x.requestType || '').toLowerCase();
    const kind = type.includes('leave') ? 'leave'
      : type.includes('overtime') ? 'overtime'
      : type.includes('trip') ? 'business_trip'
      : type.includes('clock') ? 'clock_fix' : 'other';
    counts[kind] = (counts[kind] || 0) + 1;
    out.push({
      id: 'hpt:' + (x.id || ''),
      kind,
      title: KIND_LABEL[kind] + '：' + (x.employeeName || x.title || ''),
      owner: x.employeeName || '',
      ownerId: x.employeeId || null,
      due: (x.startTime || '').slice(0, 10) || null,
      priority: 'medium', status: 'pending', domain: 'ADMIN',
      refs: { hptId: x.id, employeeId: x.employeeId, requestType: x.requestType, title: x.title, status: x.status }
    });
  });
  return { source: 'henpintong', today: o.today || new Date().toISOString().slice(0, 10), items: out, counts };
}

module.exports = {
  configured, status, ENDPOINTS, get, signHeaders, buildQuery,
  listEmployees, listDepartments, listPositions, organizationsTree, listContracts,
  listEmployeeRequests, listAttendanceSummaries, listPayrollRecords, listTodos
};
