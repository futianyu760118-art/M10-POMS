'use strict';
// packages/assembly — 岗位功能装配引擎（L0 技术验证）。
// 输入：tenant/actor/positions/grants/object_ref/product_family/model_id/process_revision/device_capabilities/context_revision
// 读取 M01 Policy -> 能力包兼容匹配 -> 生成 UI Manifest -> 每次敏感 Action 服务端重新授权。
const fs = require('fs');
const path = require('path');
const m01 = require('../../adapters/m01');
const m08 = require('../../adapters/m08');
const ui = require('../ui');

function loadTenant(tenantId) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'configs', 'tenants', tenantId + '.json'), 'utf8'));
}

function assemble(input) {
  const { actor_id, product_family, model_id, process_revision, device_capabilities, context_revision } = input || {};
  const identity = m01.getIdentity(actor_id);
  const tenant = loadTenant(identity.tenant_id);

  // 跨租户默认拒绝：请求的产品族必须与租户配置一致（公共代码零产品侵入）
  if (product_family && tenant.product_family !== product_family) {
    throw Object.assign(new Error('cross-tenant product family denied'), { status: 403 });
  }

  // 产品包兼容匹配
  let product_pack = null;
  if (product_family) {
    product_pack = m08.getInspectionTemplate(product_family, model_id, process_revision);
  }

  // 白名单 UI schema，拒绝任意注入
  const ui_schema = ui.whitelist(identity.capabilities, product_family || null, device_capabilities || {});

  return {
    manifest_id: 'm_' + Date.now().toString(36),
    tenant_id: identity.tenant_id,
    actor_id: identity.actor_id,
    positions: identity.positions,
    policy_revision: identity.policy_revision,
    capability_ids: identity.capabilities,
    ui_schema_version: ui_schema.version,
    ui_schema: ui_schema.sections,
    product_pack: product_pack ? { pack_id: product_pack.pack_id, fields: product_pack.fields, status: product_pack.status } : null,
    context_revision: context_revision || null,
    expires_at: Date.now() + 60 * 60 * 1000,
    note: 'UI 隐藏 ≠ 权限控制；敏感 Action 由服务端重新鉴权。'
  };
}

module.exports = { assemble };
