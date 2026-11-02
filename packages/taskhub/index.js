'use strict';
// packages/taskhub — M10 总任务库（统一视图 + 本地短期库 + 按责任人分发）
// 红线：不写专业库。本库只存「引用 + 展示字段 + 快照时间」，业务事实仍归源系统；
//       源系统不可用时回落到本地快照并明确标注 stale/过期（不假装成功）。
// 归集：MEETING（行政类 → 会议中心）、PLM2（业务类 → 订单/采购/生产/研发）
// 抽取：规则抽取（非大模型）→ 一律 pending-review 进候选池，人工确认后才入总库。
const fs = require('fs');
const path = require('path');
const plm2 = require('../../adapters/plm2');
const meeting = require('../../adapters/meeting');
const hubAdapter = require('../../adapters/hub');

const STORE = process.env.TASKHUB_STORE || path.join(__dirname, '..', '..', 'configs', 'tasks-master.json');
const TTL_MINUTES = 60;
const MAX_EXTRACT_PER_RUN = 200;
const HORIZON_DAYS = 30;

const DOMAINS = {
  ADMIN: { label: '行政', bizSys: 'meeting', bizLabel: '会议中心' },
  ORDER: { label: '订单', bizSys: 'plm2', bizLabel: 'PLM 订单' },
  PURCHASE: { label: '采购', bizSys: 'plm2', bizLabel: 'PLM 采购' },
  PRODUCTION: { label: '生产', bizSys: 'plm2', bizLabel: 'PLM 生产' },
  RD: { label: '研发', bizSys: 'plm2', bizLabel: 'PLM 研发' },
  OPS: { label: '经营', bizSys: 'hub', bizLabel: 'Hub 经营中心' }
};

const DOMAIN_RULES = [
  // 业务域优先于行政：'通知采购准备来料' 应归采购而非行政
  ['PURCHASE', /采购|供应商|议价|询价|到货|来料|物料齐套/],
  ['ORDER', /订单|客户|合同|交期|出货|发货|运输/],
  ['PRODUCTION', /生产|试产|量产|工装|试模|首件|样机|打样|检验|车间|产线|生试|工试|研试|电试|送检|送样|检测/],
  ['ADMIN', /会议|行政|考勤|报销|培训|通知|办公|后勤|用餐|门禁/]
];

function today() { return new Date().toISOString().slice(0, 10); }

function domainOf(text, fallback) {
  const s = String(text || '');
  for (const [d, re] of DOMAIN_RULES) if (re.test(s)) return d;
  return fallback || 'RD';
}

// 节点名优先（"生试/出货"是节点语义），项目名仅兜底
function domainOfNode(nodeName, projectName) {
  for (const [d, re] of DOMAIN_RULES) if (re.test(String(nodeName || ''))) return d;
  return domainOf(projectName, 'RD');
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    return {
      version: s.version || 1,
      updatedAt: s.updatedAt || null,
      horizonDays: s.horizonDays || HORIZON_DAYS,
      sources: s.sources || {},
      items: Array.isArray(s.items) ? s.items : [],
      candidates: Array.isArray(s.candidates) ? s.candidates : []
    };
  } catch (e) {
    return { version: 1, updatedAt: null, horizonDays: HORIZON_DAYS, sources: {}, items: [], candidates: [] };
  }
}

function save(store) {
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return store;
}

function statusOf(item, d) {
  const st = String(item.status || '').toLowerCase();
  if (st === 'done' || st === 'verified' || st === '已完成') return 'done';
  if (st === 'cancelled' || st === 'canceled' || st === '已取消') return 'cancelled';
  if (st === 'blocked' || st === '异常') return 'blocked';
  if (item.due && item.due < d) return 'overdue';
  if (st === 'in_progress' || st === 'in-progress') return 'in_progress';
  if (st === 'confirmed' || st === '已确认') return 'confirmed';
  if (st === 'candidate' || st === '候选') return 'candidate';
  return 'pending';
}

function keyOf(source, sourceId) { return source + ':' + sourceId; }

function makeItem(o) {
  const dom = DOMAINS[o.bizDomain] || DOMAINS.RD;
  return {
    id: 'T-' + keyOf(o.source, o.sourceId),
    key: keyOf(o.source, o.sourceId),
    source: o.source,
    sourceId: String(o.sourceId),
    sourceLabel: o.sourceLabel,
    bizDomain: o.bizDomain,
    bizDomainLabel: dom.label,
    bizSys: dom.bizSys,
    bizSysLabel: dom.bizLabel,
    title: o.title,
    detail: o.detail || '',
    ownerName: o.ownerName || '',
    ownerId: o.ownerId || null,
    duedSource: o.duedSource || (o.source === 'MEETING' ? 'meeting' : 'plm2'),
    due: o.due || null,
    priority: o.priority || 'medium',
    sourceStatus: o.status || '',
    status: o.status || '',
    origin: o.origin || 'sync',
    verifiedBy: o.verifiedBy || null,
    verifiedAt: o.verifiedAt || null,
    refs: o.refs || {},
    link: o.link || '',
    fetchedAt: o.fetchedAt || new Date().toISOString(),
    ttlMinutes: TTL_MINUTES
  };
}

// ── 归集器 ────────────────────────────────────────────────
function collectMeeting(d) {
  const all = meeting.listAll({ today: d });
  const people = plm2.getPeople();
  return {
    ok: true,
    meta: { live: all.live, sourceUpdatedAt: all.updatedAt, scope: all.scope, counts: all.counts },
    items: all.items.map(x => {
      const p = people.find(v => v.name === x.owner) || people.find(v => v.username && v.ownerLoginId && v.username === x.ownerLoginId);
      return makeItem({
        source: 'MEETING', sourceId: x.id, sourceLabel: '会议助手',
        bizDomain: 'ADMIN',
        title: x.title, detail: [x.blockedReason, x.dept, x.meetingTitle].filter(Boolean).join(' · '),
        ownerName: x.owner, ownerId: p ? p.id : null,
        due: x.due, priority: x.priority, status: x.status,
        refs: {
          meetingId: x.meetingId, meetingTitle: x.meetingTitle, meetingDate: x.meetingDate,
          meetingOrganizer: x.meetingOrganizer, meetingStatus: x.meetingStatus,
          proposer: x.proposer, dept: x.dept, sourceType: x.sourceType, category: x.category
        },
        link: x.link
      });
    })
  };
}

function collectPlmNodes(d, horizonDays) {
  const people = plm2.getPeople();
  const seen = new Set();
  const items = [];
  const limit = new Date(Date.parse(d) + (horizonDays || HORIZON_DAYS) * 86400000).toISOString().slice(0, 10);
  people.forEach(p => {
    const t = plm2.todosFor(p.name);
    [...t.overdue, ...t.todo].forEach(r => {
      if (!r.planDate) return; // 无计划日 = 未排期，不进总库（避免把"未开始节点"当任务刷屏）
      const k = r.projectNo + '|' + r.nodeCode;
      if (seen.has(k)) return;
      if (r.planDate > limit) return;
      seen.add(k);
      items.push(makeItem({
        source: 'PLM2', sourceId: k, sourceLabel: 'PLM',
        bizDomain: domainOfNode(r.nodeName, r.projectName),
        title: r.nodeName + '（' + r.projectNo + '）',
        detail: (r.projectName || '') + (r.assigned ? ' · 指派给我' : ''),
        ownerName: p.name, ownerId: p.id,
        due: r.planDate, priority: r.planDate < d ? 'high' : 'medium',
        status: r.status === 'DONE' ? 'done' : 'pending',
        refs: { projectNo: r.projectNo, nodeCode: r.nodeCode, projectName: r.projectName }
      }));
    });
  });
  return { ok: true, meta: { scanned: people.length }, items };
}

function collectPlmApprovals() {
  const items = [];
  plm2.listWorksheetApprovals().forEach(w => {
    items.push(makeItem({
      source: 'PLM2', sourceId: 'ws:' + w.id, sourceLabel: 'PLM 审批',
      bizDomain: domainOf(w.title || w.nodeName || '', 'RD'),
      title: '审批：' + (w.title || w.id),
      detail: '待审工作表（提交人 ' + (w.submittedBy || w.operator || '—') + '）',
      ownerName: w.reviewer || w.approver || '', due: w.dueDate || null,
      priority: 'high', status: 'pending',
      refs: { kind: 'worksheet', wsId: w.id, projectNo: w.projectNo, nodeCode: w.nodeCode }
    }));
  });
  plm2.listInitiations({}).filter(i => i.status && i.status !== 'APPROVED' && i.status !== 'REJECTED').forEach(i => {
    items.push(makeItem({
      source: 'PLM2', sourceId: 'init:' + i.initNo, sourceLabel: 'PLM 立项',
      bizDomain: 'RD', title: '立项审批：' + (i.projectName || i.initNo),
      detail: '阶段 ' + (i.stage || '—') + ' · 状态 ' + (i.status || '—'),
      ownerName: i.approver || i.creator || '', due: i.dueDate || null,
      priority: 'high', status: 'pending',
      refs: { kind: 'initiation', initNo: i.initNo }
    }));
  });
  return { ok: true, meta: {}, items };
}

async function collectHub(d) {
  const t = await hubAdapter.listTodos({ today: d });
  return {
    ok: true,
    meta: { api: t.api, connected: t.connected, unreadInbox: t.unreadInbox, counts: t.counts },
    items: t.items.map(x => makeItem({
      source: 'HUB', sourceId: x.id, sourceLabel: 'Hub',
      // Hub 条目始终归 Hub 经营中心（业务属性放 refs.hint，避免误标成 PLM 域）
      bizDomain: 'OPS',
      title: x.title, detail: x.detail || '',
      ownerName: x.ownerName || '', due: x.due, priority: x.priority,
      status: x.status,
      refs: Object.assign({ hubKind: x.kind, hint: domainOf(x.title + ' ' + (x.detail || ''), 'OPS') }, x.refs || {})
    }))
  };
}

// ── 总库刷新（本地短期库：源故障时保留旧快照并标 stale）────
async function refresh(opts) {
  const d = (opts && opts.today) || today();
  const store = load();
  const horizon = (opts && opts.horizonDays) || store.horizonDays || HORIZON_DAYS;
  const collectors = {
    MEETING: () => collectMeeting(d),
    PLM2: () => ({ ok: true, meta: {}, items: [...collectPlmNodes(d, horizon).items, ...collectPlmApprovals().items] }),
    HUB: async () => collectHub(d)
  };
  const keepLocal = store.items.filter(x => x.origin !== 'sync');
  const prevSync = {};
  store.items.filter(x => x.origin === 'sync').forEach(x => { prevSync[x.key] = x; });
  const next = [];
  const sources = {};
  for (const name of Object.keys(collectors)) {
    const prev = store.sources[name] || {};
    try {
      const r = await collectors[name]();
      sources[name] = {
        ok: true, lastAttempt: new Date().toISOString(), lastSuccess: new Date().toISOString(),
        error: null, cachedAt: new Date().toISOString(), itemCount: r.items.length,
        ttlMinutes: TTL_MINUTES, meta: r.meta || {}
      };
      next.push(...r.items);
    } catch (e) {
      sources[name] = {
        ok: false, lastAttempt: new Date().toISOString(), lastSuccess: prev.lastSuccess || null,
        error: e.message, cachedAt: prev.cachedAt || null,
        itemCount: Object.keys(prevSync).filter(k => k.startsWith(name + ':')).length,
        ttlMinutes: TTL_MINUTES, stale: true
      };
      next.push(...Object.keys(prevSync).filter(k => k.startsWith(name + ':')).map(k => prevSync[k]));
    }
  }
  const fresh = {};
  next.forEach(x => { fresh[x.key] = x; });
  store.items = [...Object.values(fresh), ...keepLocal];
  store.sources = sources;
  store.horizonDays = horizon;
  store.updatedAt = new Date().toISOString();
  save(store);
  return summarize(store, d);
}

function stubFor(bizDomain) { return DOMAINS[bizDomain] || DOMAINS.RD; }

function sourceHealth(store, nowMs) {
  const out = {};
  Object.keys(store.sources || {}).forEach(k => {
    const s = store.sources[k];
    const cachedAt = s.cachedAt ? Date.parse(s.cachedAt) : 0;
    const ageMin = cachedAt ? Math.round((nowMs - cachedAt) / 60000) : null;
    out[k] = Object.assign({}, s, {
      ageMinutes: ageMin,
      expired: ageMin === null ? true : ageMin > (s.ttlMinutes || TTL_MINUTES)
    });
  });
  return out;
}

function list(opts) {
  const o = opts || {};
  const d = o.today || today();
  const store = load();
  const nowMs = Date.now();
  const health = sourceHealth(store, nowMs);
  let items = store.items.map(x => {
    const st = statusOf(x, d);
    const dom = stubFor(x.bizDomain);
    const src = health[x.source] || {};
    return Object.assign({}, x, {
      status: st,
      statusText: { done: '已完成', blocked: '异常', overdue: '逾期', in_progress: '进行中', pending: '待办', cancelled: '已取消', confirmed: '已确认', candidate: '候选' }[st] || st,
      bizDomainLabel: dom.label, bizSys: dom.bizSys, bizSysLabel: dom.bizLabel,
      stale: !!(src.ok === false || src.expired)
    });
  });
  if (o.owner) items = items.filter(x => x.ownerName === o.owner);
  if (o.domain) items = items.filter(x => x.bizDomain === o.domain);
  if (o.source) items = items.filter(x => x.source === o.source);
  if (o.status) items = items.filter(x => x.status === o.status);
  if (o.q) { const q = String(o.q); items = items.filter(x => (x.title + x.detail + x.ownerName).includes(q)); }
  if (o.activeOnly) items = items.filter(x => x.status !== 'done');
  // 排序：未完成优先（逾期最前），已完成/已取消沉底，再按截止日升序
  const RANK = { overdue: 0, pending: 1, blocked: 2, in_progress: 3, confirmed: 4, candidate: 5, done: 8, cancelled: 9 };
  items.sort((a, b) => (RANK[a.status] - RANK[b.status]) || String(a.due || '9999').localeCompare(String(b.due || '9999')) || a.title.localeCompare(b.title));

  const byOwner = {}, byDomain = {}, byStatus = {};
  items.forEach(x => {
    const on = x.ownerName || '未分配';
    byOwner[on] = (byOwner[on] || 0) + 1;
    byDomain[x.bizDomain] = (byDomain[x.bizDomain] || 0) + 1;
    byStatus[x.status] = (byStatus[x.status] || 0) + 1;
  });
  return {
    updatedAt: store.updatedAt,
    horizonDays: store.horizonDays,
    total: items.length,
    items,
    counts: { byOwner, byDomain, byStatus },
    sources: health,
    candidates: store.candidates.filter(c => c.status === 'pending-review'),
    domains: Object.keys(DOMAINS).map(k => ({ code: k, label: DOMAINS[k].label, bizSys: DOMAINS[k].bizSys, bizSysLabel: DOMAINS[k].bizLabel })),
    notice: 'M10 总任务库只存引用与快照，不持有业务事实；修改请在源系统进行'
  };
}

// ── 规则抽取（非大模型；产物一律 pending-review）────────────
const SPLIT_RE = /[；;。]\s*|(?:^|\s)(?:[1-9]\d?)[.、)）]\s*|(?:^|\s)[①②③④⑤⑥⑦⑧⑨⑩]\s*/;
const DATE_RE = /(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})月(\d{1,2})日|(\d{1,2})\/(\d{1,2})/;
const HIGH_RE = /紧急|立即|尽快|ASAP|今日|今天|马上/;
const LOW_RE = /不急|有空|以后|下周再说/;

function pad(n) { return String(n).padStart(2, '0'); }

function parseDue(text, d) {
  const m = String(text || '').match(DATE_RE);
  if (!m) return null;
  let y, mo, da;
  if (m[1]) { y = +m[1]; mo = +m[2]; da = +m[3]; }
  else if (m[4]) { y = +d.slice(0, 4); mo = +m[4]; da = +m[5]; }
  else { y = +d.slice(0, 4); mo = +m[6]; da = +m[7]; }
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return y + '-' + pad(mo) + '-' + pad(da);
}

function matchOwner(text, people) {
  const sorted = people.slice().sort((a, b) => b.name.length - a.name.length);
  for (const p of sorted) {
    if (p.name && String(text).includes(p.name)) return p;
  }
  return null;
}

function splitText(text) {
  return String(text || '').split(SPLIT_RE).map(x => x.trim()).filter(Boolean);
}

// 标题里去掉已识别的日期短语（期限另存 due 字段），便于判重与展示
const DATE_TEXT_RE = /(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2})/;
function cleanTitle(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(DATE_TEXT_RE, '').replace(/\s{2,}/g, ' ').trim();
}

function fingerprint(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function extractCandidates(opts) {
  const d = (opts && opts.today) || today();
  const store = load();
  const people = plm2.getPeople();
  const knownCand = new Set(store.candidates.map(c => c.fingerprint));
  const produced = [];
  const skipped = [];

  function push(seg, meta) {
    if (produced.length >= MAX_EXTRACT_PER_RUN) return;
    const raw = String(seg).replace(/\s+/g, ' ').trim();
    const dueRaw = parseDue(raw, d);
    const title = cleanTitle(raw);
    if (title.length < 4) return;
    // 数据质量闸门：源数据编码损坏（连续 ? / 替换符）不产出候选，避免垃圾入总库
    if (/\?{2,}/.test(title) || title.indexOf('\uFFFD') >= 0) { skipped.push({ from: meta.source + ':' + meta.sourceId, reason: '源文本疑似编码损坏', sample: title.slice(0, 20) }); return; }
    // 未拆分的整句 = 该分库条目本身，归集器已会收录，不重复产出为候选
    if (meta.full && title === cleanTitle(meta.full)) return;
    // 已入总库的同名任务不重复产出（按来源+标题判重，避免把已归集项再提一次）
    if (store.items.some(x => x.source === meta.source && x.title === title)) return;
    const owner = matchOwner(title, people) || (meta.owner ? people.find(p => p.name === meta.owner) : null);
    const due = dueRaw || meta.due || null;
    const priority = HIGH_RE.test(title) ? 'high' : (LOW_RE.test(title) ? 'low' : 'medium');
    const bizDomain = domainOf(title, meta.bizDomain || 'RD');
    const fp = fingerprint(meta.source + '|' + title);
    if (knownCand.has(fp)) return;
    knownCand.add(fp);
    produced.push({
      id: 'C-' + fp,
      fingerprint: fp,
      status: 'pending-review',
      engine: 'rule-based',
      engineNote: '规则抽取（非大模型）：按分隔符拆分子任务 + 日期/紧急度/业务域关键词 + 人员字典识别责任人',
      confidence: (owner ? 0.4 : 0) + (due ? 0.3 : 0) + (0.3),
      title,
      detail: meta.detail || '',
      source: meta.source,
      sourceId: meta.sourceId,
      sourceLabel: meta.sourceLabel,
      bizDomain,
      due,
      priority,
      ownerName: owner ? owner.name : '',
      ownerId: owner ? owner.id : null,
      evidence: { from: meta.source + ':' + meta.sourceId, segment: title },
      createdAt: new Date().toISOString(),
      createdBy: (opts && opts.actor) || 'taskhub-extractor'
    });
  }

  // 分库 1：会议待办（长描述可再拆为多条子任务）
  // 只抽未完成项（已完成/已取消是历史记录，拆分只会制造噪音）
  const ACTIVE = ['pending', 'candidate', 'confirmed', 'in_progress', 'blocked'];
  meeting.listAll({ today: d }).items.forEach(it => {
    if (!ACTIVE.includes(String(it.status || ''))) return;
    splitText(it.title).forEach(seg => {
      push(seg, { source: 'MEETING', sourceId: it.id, sourceLabel: '会议助手', bizDomain: 'ADMIN', owner: it.owner, due: it.due, full: it.title });
    });
  });

  // 分库 2：PLM 工作/ECN 自由文本（原因、备注里常埋任务）
  try {
    plm2.listEcns('ADMIN').forEach(e => {
      const text = [e.reason, e.remark, e.description].filter(Boolean).join('；');
      if (!text) return;
      splitText(text).forEach(seg => push(seg, { source: 'PLM2', sourceId: 'ecn:' + (e.ecnNo || e.id), sourceLabel: 'PLM ECN', bizDomain: 'RD', full: text }));
    });
  } catch (e) { /* 源不可用不阻断其他分库 */ }

  // 分库 3：人工粘贴的原始文本（会议纪要 / 微信通知 / 口头交办）——一次粘贴，规则拆分
  if (opts && opts.text && String(opts.text).trim()) {
    splitText(opts.text).forEach(seg => push(seg, { source: 'TEXT', sourceId: 't:' + fingerprint(seg), sourceLabel: '粘贴文本' }));
  }

  store.candidates = [...store.candidates, ...produced];
  save(store);
  return { produced: produced.length, truncated: produced.length >= MAX_EXTRACT_PER_RUN, limit: MAX_EXTRACT_PER_RUN, skipped, candidates: produced, totalPending: store.candidates.filter(c => c.status === 'pending-review').length, engine: 'rule-based', reviewRequired: true };
}

function confirmCandidate(id, opts) {
  const o = opts || {};
  const store = load();
  const c = store.candidates.find(x => x.id === id && x.status === 'pending-review');
  if (!c) return { status: 404, body: { error: 'candidate not found or already reviewed' } };
  if (!o.reviewer) return { status: 400, body: { error: 'reviewer required（done ≠ verified：入总库须授权人确认）' } };
  const d = o.today || today();
  const ownerName = o.ownerName || c.ownerName || '';
  const owner = plm2.getPeople().find(p => p.name === ownerName);
  c.status = 'confirmed';
  c.reviewedBy = o.reviewer;
  c.reviewedAt = new Date().toISOString();
  const item = makeItem({
    source: c.source, sourceId: c.sourceId + '#c' + c.fingerprint, sourceLabel: c.sourceLabel,
    bizDomain: o.bizDomain || c.bizDomain, title: c.title, detail: c.detail,
    ownerName, ownerId: owner ? owner.id : null,
    due: o.due || c.due, priority: c.priority, status: 'pending',
    origin: 'extract', verifiedBy: o.reviewer, verifiedAt: c.reviewedAt,
    refs: { fromCandidate: c.id, evidence: c.evidence }
  });
  store.items = store.items.filter(x => x.key !== item.key).concat(item);
  store.candidates = store.candidates.map(x => x.id === c.id ? c : x);
  save(store);
  return { status: 200, body: { ok: true, item } };
}

function rejectCandidate(id, opts) {
  const o = opts || {};
  const store = load();
  const c = store.candidates.find(x => x.id === id && x.status === 'pending-review');
  if (!c) return { status: 404, body: { error: 'candidate not found or already reviewed' } };
  if (!o.reviewer) return { status: 400, body: { error: 'reviewer required' } };
  c.status = 'rejected';
  c.reviewedBy = o.reviewer;
  c.reviewedAt = new Date().toISOString();
  c.rejectReason = o.reason || '';
  save(store);
  return { status: 200, body: { ok: true, candidate: c } };
}

// 按责任人分发：仅对总库本地条目（extract/manual）生效；
// 引用条目（sync）责任人归源系统，返回 409 让用户回源系统改，避免双写。
function assignItem(id, opts) {
  const o = opts || {};
  const store = load();
  const it = store.items.find(x => x.id === id);
  if (!it) return { status: 404, body: { error: 'task not found' } };
  if (!o.ownerName) return { status: 400, body: { error: 'ownerName required' } };
  if (!o.reviewer) return { status: 400, body: { error: 'reviewer required（分发属于变更动作，须留痕）' } };
  const owner = plm2.getPeople().find(p => p.name === o.ownerName);
  if (it.origin === 'sync') {
    return { status: 409, body: { error: '该任务责任人由源系统持有，请在 ' + it.bizSysLabel + ' 调整（M10 不双写）', source: it.source, sourceId: it.sourceId } };
  }
  it.ownerName = o.ownerName;
  it.ownerId = owner ? owner.id : null;
  it.assignedBy = o.reviewer;
  it.assignedAt = new Date().toISOString();
  save(store);
  return { status: 200, body: { ok: true, item: it } };
}

function summarize(store, d) {
  const s = list({ today: d });
  return {
    updatedAt: store.updatedAt, total: s.total, counts: s.counts,
    sources: s.sources, pendingCandidates: s.candidates.length
  };
}

function reset() {
  save({ version: 1, updatedAt: null, horizonDays: HORIZON_DAYS, sources: {}, items: [], candidates: [] });
}

module.exports = {
  STORE, DOMAINS, load, save, refresh, list, summarize,
  extractCandidates, confirmCandidate, rejectCandidate, assignItem, reset,
  statusOf, domainOf, domainOfNode, parseDue, fingerprint, splitText
};
