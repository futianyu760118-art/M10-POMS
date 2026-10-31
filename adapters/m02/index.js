'use strict';
// M02 Evidence / EDP 的 mock adapter（Owner M02）。
// 真实数据路径：采集 -> 专业源业务系统人机审核 -> M02 EDP 清洗/分类/质量校验 -> 归档。
const crypto = require('crypto');

function submitEvidence(capture) {
  const raw = JSON.stringify(capture);
  return {
    evidence_id: 'evt_' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12),
    source_system: 'M10-POMS',
    source_record_id: capture.capture_id,
    checksum: crypto.createHash('sha256').update(raw).digest('hex'),
    version: 1,
    confidence: 'pending-review',
    provenance: capture.provenance,
    status: 'pending' // 未经验证的数据标识 pending
  };
}

module.exports = { submitEvidence };
