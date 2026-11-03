import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPersonLifecycleService } from '../apps/bff/person-lifecycle.js';

function event({ id = 'evt-offboard-1', type = 'person.offboarded', revision = 1, action = 'offboard', status = 'inactive' } = {}) {
  return {
    event_id: id,
    event_type: type,
    event_version: 1,
    tenant_id: 'tenant-hengjian',
    source_system: 'M01_KERNEL',
    object_type: 'Person',
    object_id: 'person-1',
    revision,
    occurred_at: '2026-11-03T02:00:00Z',
    effective_at: '2026-11-03T02:00:00Z',
    correlation_id: id,
    trace_id: id,
    idempotency_key: `tenant-hengjian:M01_KERNEL:Person:person-1:${revision}:${type}`,
    person: {
      person_id: 'person-1', emp_code: 'E001',
      in_progress_work_items: [{ id: 'work-1', title: '待办事项' }],
      active_sessions: ['session-1'],
    },
    status,
    employment_action: action,
    occurred_by: '朱剑军',
  };
}

function serviceFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'm10-person-lifecycle-'));
  const service = createPersonLifecycleService({ file: join(dir, 'state.json') });
  return { service, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('离职关闭工作台和会话，把办理中的工作转给重新安排队列并生成清单', () => {
  const { service, cleanup } = serviceFixture();
  try {
    const result = service.apply(event());
    assert.equal(result.status, 'synced');
    assert.deepEqual(new Set(result.closed_items), new Set(['workspace', 'session', 'task_access']));
    const state = service.snapshot();
    assert.equal(state.people['tenant-hengjian:person-1'].access, 'revoked');
    assert.equal(state.sessions['session-1'].status, 'rejected');
    assert.equal(state.work_items['work-1'].status, 'reassignment_required');
    assert.deepEqual(state.checklists.map((item) => item.item_type), ['workspace', 'session', 'task_access']);
  } finally { cleanup(); }
});

test('复职只恢复基础访问，权限和智能体配备仍需确认', () => {
  const { service, cleanup } = serviceFixture();
  try {
    service.apply(event());
    const result = service.apply(event({
      id: 'evt-reinstate-1', type: 'person.reinstated', revision: 2, action: 'rehire', status: 'active',
    }));
    assert.equal(result.status, 'pending_confirmation');
    assert.deepEqual(result.pending_confirmation, { permissions: true, agents: true });
    assert.equal(service.snapshot().people['tenant-hengjian:person-1'].access, 'basic_pending_confirmation');
  } finally { cleanup(); }
});

test('重复事件只返回原结果，不重复关闭或生成清单', () => {
  const { service, cleanup } = serviceFixture();
  try {
    const first = service.apply(event());
    const replay = service.apply(event());
    assert.equal(replay.duplicate, true);
    assert.equal(replay.event_id, first.event_id);
    assert.equal(service.snapshot().events.length, 1);
    assert.equal(service.snapshot().checklists.length, 3);
  } finally { cleanup(); }
});
