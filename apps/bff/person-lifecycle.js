'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const CHECKLIST = [
  ['workspace', '工作台访问'],
  ['session', '登录会话'],
  ['task_access', '待办事项办理权限']
];
const STATUS_LABELS = {
  synced: '已完成', stale: '已跳过', pending_confirmation: '待管理员确认',
  pending: '待处理', retrying: '处理中', failed: '处理失败'
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return { version: 1, events: [], people: {}, sessions: {}, work_items: {}, checklists: [] };
}

function loadState(file) {
  if (!fs.existsSync(file)) return defaultState();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.assign(defaultState(), parsed);
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function eventFields(event) {
  for (const field of ['event_id', 'event_type', 'tenant_id', 'object_id', 'revision', 'idempotency_key', 'person']) {
    if (!event || event[field] === undefined || event[field] === null || event[field] === '') {
      throw new Error(`人员同步事件缺少必填内容：${field}`);
    }
  }
}

function createPersonLifecycleService({ file = path.join(ROOT, 'data', 'person-lifecycle.json'), initialState } = {}) {
  let state = initialState ? clone(initialState) : loadState(file);

  const persist = () => saveState(file, state);
  const snapshot = () => clone(state);

  function apply(event) {
    eventFields(event);
    const existing = state.events.find((item) => item.idempotency_key === event.idempotency_key);
    if (existing) return { ...clone(existing.result), duplicate: true };

    const current = state.events
      .filter((item) => item.object_id === event.object_id && item.tenant_id === event.tenant_id)
      .sort((a, b) => Number(b.revision) - Number(a.revision))[0];
    if (current && Number(event.revision) < Number(current.revision)) {
      return { status: 'stale', state: 'stale', event_id: event.event_id, duplicate: false };
    }

    const personId = String(event.object_id);
    const person = state.people[personId] || { tenant_id: event.tenant_id, emp_code: event.person.emp_code };
    person.tenant_id = event.tenant_id;
    person.emp_code = event.person.emp_code || person.emp_code;
    const result = {
      status: 'synced', state: 'active', event_id: event.event_id,
      closed_items: [], reassigned_tasks: [],
      pending_confirmation: { permissions: false, agents: false }, duplicate: false
    };

    if (event.event_type === 'person.offboarded') {
      person.status = 'inactive';
      person.access = 'revoked';
      person.revoked_at = new Date().toISOString();
      result.state = 'offboarded';
      result.closed_items = CHECKLIST.map(([type]) => type);
      for (const sessionId of event.person.active_sessions || []) {
        state.sessions[sessionId] = { person_id: personId, status: 'rejected', reason: '人员已离职' };
      }
      for (const item of event.person.in_progress_work_items || []) {
        if (!item || !item.id) continue;
        state.work_items[item.id] = {
          id: item.id, title: item.title || '待办事项', person_id: personId,
          status: 'reassignment_required', reason: '原办理人员已离职'
        };
        result.reassigned_tasks.push(item.id);
      }
      for (const [itemType, itemName] of CHECKLIST) {
        if (!state.checklists.some((item) => item.event_id === event.event_id && item.item_type === itemType)) {
          state.checklists.push({
            id: `check-${crypto.randomUUID()}`, event_id: event.event_id,
            tenant_id: event.tenant_id, person_id: personId,
            item_type: itemType, item_name: itemName, status: 'closed',
            detail: '离职后已关闭并保留历史记录'
          });
        }
      }
    } else if (event.event_type === 'person.reinstated') {
      person.status = 'active';
      person.access = 'basic_pending_confirmation';
      delete person.revoked_at;
      result.status = 'pending_confirmation';
      result.pending_confirmation = { permissions: true, agents: true };
    } else {
      throw new Error(`不支持的人员状态事件：${event.event_type}`);
    }

    result.status_text = STATUS_LABELS[result.status] || '处理中';

    state.people[personId] = person;
    const record = { ...event, result };
    state.events.push(record);
    persist();
    return clone(result);
  }

  return {
    apply,
    snapshot,
    isPersonAccessRevoked: (personId) => state.people[personId]?.access === 'revoked',
  };
}

const defaultPersonLifecycleService = createPersonLifecycleService();

module.exports = { createPersonLifecycleService, defaultPersonLifecycleService };
