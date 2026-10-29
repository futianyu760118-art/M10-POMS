'use strict';
// M08 品质检验 mock adapter（Owner M08）。
// 检验事实由 M08 人机审核；done != verified，执行者不可无授权自验。
const fs = require('fs');
const path = require('path');

const FAMILY_PACK = { 'led-light': 'lighting.json', 'timer': 'timer.json' };

function getInspectionTemplate(productFamily, modelId, processRevision) {
  const file = FAMILY_PACK[productFamily];
  if (!file) throw Object.assign(new Error('unknown product family'), { status: 404 });
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'capability-packs', file), 'utf8'));
  // 型号与工艺版本匹配；错配拒绝。
  if (modelId && pack.product_model !== 'EXAMPLE_ONLY' && pack.product_model !== modelId) {
    throw Object.assign(new Error('model/process_revision mismatch'), { status: 409 });
  }
  return { pack_id: pack.pack_id, fields: pack.fields, status: pack.status, process_revision: processRevision || null };
}

function reviewCapture(captureId, reviewer) {
  // 只有授权验证者才能把 submitted -> verified
  return {
    result_id: 'res_' + captureId,
    capture_id: captureId,
    actual_result: 'reviewed',
    status: 'verified',
    verified_by: reviewer,
    verified_at: new Date().toISOString()
  };
}

module.exports = { getInspectionTemplate, reviewCapture };
