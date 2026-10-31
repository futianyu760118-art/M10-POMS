'use strict';
// packages/capture — 输入采集与离线暂存（L0）。
// 幂等：相同 Idempotency-Key 不重复写入；M10 发起，专业中心入账。
const m01 = require('../../adapters/m01');
const m02 = require('../../adapters/m02');
const crypto = require('crypto');

const STORE = new Map(); // idempotency_key -> capture_id

function submitCapture(input) {
  const { actor_id, idempotency_key, capture_type, device_id, captured_at, product_ref, values } = input || {};
  if (!idempotency_key) throw Object.assign(new Error('Idempotency-Key required'), { status: 400 });
  if (STORE.has(idempotency_key)) {
    // 幂等重放：返回已有记录，不重复写
    return { capture_id: STORE.get(idempotency_key), replay: true, status: 'accepted' };
  }

  // 服务端执行前再鉴权
  const identity = m01.getIdentity(actor_id);
  if (!m01.authorize(identity, 'capture')) {
    throw Object.assign(new Error('permission denied'), { status: 403 });
  }

  const capture_id = 'cap_' + crypto.randomBytes(6).toString('hex');
  const record = {
    capture_id,
    capture_type,
    device_id: device_id || null,
    captured_at: captured_at || new Date().toISOString(),
    product_ref: product_ref || null,
    values: values || {},
    schema_version: '1.0',
    correlation_id: null,
    trace_id: 'tr_' + crypto.randomBytes(4).toString('hex'),
    idempotency_key,
    sync_state: 'synced',
    provenance: { actor_id: identity.actor_id, tenant_id: identity.tenant_id }
  };
  STORE.set(idempotency_key, capture_id);

  // 进入专业源业务系统人机审核（M02 占位）
  const evidence = m02.submitEvidence(record);
  return { capture_id, status: 'pending-review', evidence_id: evidence.evidence_id, evidence_status: evidence.status };
}

module.exports = { submitCapture, STORE };
