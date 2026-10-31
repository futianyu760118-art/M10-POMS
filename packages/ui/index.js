'use strict';
// packages/ui — 安全白名单 UI-schema（L0）。
// 只允许已登记的能力/页面渲染，拒绝任意 schema 注入。
const SECTIONS = {
  quality: { id: 'inspect', title: '检验采集', kind: 'form', secure: true },
  capture: { id: 'capture', title: '证据采集', kind: 'capture', secure: true },
  'rd-design': { id: 'design', title: '结构与图纸', kind: 'list' },
  bom: { id: 'bom', title: 'BOM 与物料', kind: 'list' },
  ecn: { id: 'ecn', title: 'ECN 变更', kind: 'list' },
  lead: { id: 'lead', title: '公开线索开发', kind: 'list' },
  quote: { id: 'quote', title: '询盘与报价', kind: 'list' },
  delivery: { id: 'delivery', title: '生产与交付', kind: 'list' },
  finance: { id: 'finance', title: '应收回款', kind: 'view' }
};

function whitelist(capabilityIds, productFamily, deviceCapabilities) {
  const sections = (capabilityIds || [])
    .filter(id => SECTIONS[id])
    .map(id => SECTIONS[id]);
  return {
    version: '1.0',
    device: {
      has_camera: !!deviceCapabilities.camera,
      has_mic: !!deviceCapabilities.mic
    },
    sections
  };
}

module.exports = { whitelist, SECTIONS };
