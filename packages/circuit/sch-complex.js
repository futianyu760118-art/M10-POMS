'use strict';
// packages/circuit/sch-complex.js — 复杂电路原理图生成（DeepSeek 结构化输出 → .kicad_sch）。
// 元件符号内嵌；连接用 net label（同名即同网），无需手动画线。
const crypto = require('crypto');
const u = () => crypto.randomUUID();
const rnd = (x) => Math.round(x * 10000) / 10000;
const _fx = () => '(effects (font (size 1.27 1.27)))';

/* ============ 符号元数据（引脚：name 语义名 / num 编号 / x,y 位置 / angle 方向） ============ */
const SYM = {
  COB_LED: { body: [-2.54, -2.54, 2.54, 2.54], pins: [
    { name: 'anode', num: '1', x: -3.81, y: 0, angle: 180 },
    { name: 'cathode', num: '2', x: 3.81, y: 0, angle: 0 }] },
  POWER_INDUCTOR: { body: [-3.81, -1.27, 3.81, 1.27], pins: [
    { name: '1', num: '1', x: -3.81, y: 0, angle: 180 },
    { name: '2', num: '2', x: 3.81, y: 0, angle: 0 }] },
  SCHOTTKY_DIODE: { body: [-2.54, -2.54, 2.54, 2.54], pins: [
    { name: 'anode', num: '1', x: -3.81, y: 0, angle: 180 },
    { name: 'cathode', num: '2', x: 3.81, y: 0, angle: 0 }] },
  CURRENT_SENSE_RESISTOR: { body: [-2.54, -1.27, 2.54, 1.27], pins: [
    { name: '1', num: '1', x: -2.54, y: 0, angle: 180 },
    { name: '2', num: '2', x: 2.54, y: 0, angle: 0 }] },
  RESETTABLE_FUSE: { body: [-2.54, -1.27, 2.54, 1.27], pins: [
    { name: '1', num: '1', x: -2.54, y: 0, angle: 180 },
    { name: '2', num: '2', x: 2.54, y: 0, angle: 0 }] },
  NTC_THERMISTOR: { body: [-2.54, -1.27, 2.54, 1.27], pins: [
    { name: '1', num: '1', x: -2.54, y: 0, angle: 180 },
    { name: '2', num: '2', x: 2.54, y: 0, angle: 0 }] },
  ELECTROLYTIC_CAP: { body: [-2.54, -2.54, 2.54, 2.54], pins: [
    { name: '+', num: '1', x: -2.54, y: 0, angle: 180 },
    { name: '-', num: '2', x: 2.54, y: 0, angle: 0 }] },
  CERAMIC_CAP: { body: [-2.54, -1.27, 2.54, 1.27], pins: [
    { name: '1', num: '1', x: -2.54, y: 0, angle: 180 },
    { name: '2', num: '2', x: 2.54, y: 0, angle: 0 }] },
  BUTTON_DIMMING_INTERFACE: { body: [-2.54, -2.54, 2.54, 2.54], pins: [
    { name: '1', num: '1', x: -2.54, y: 0, angle: 180 },
    { name: '2', num: '2', x: 2.54, y: 0, angle: 0 }] },
  RESISTOR: { body: [-2.54, -1.27, 2.54, 1.27], pins: [
    { name: '1', num: '1', x: -2.54, y: 0, angle: 180 },
    { name: '2', num: '2', x: 2.54, y: 0, angle: 0 }] },
  GENERIC: { body: [-2.54, -1.27, 2.54, 1.27], pins: [
    { name: '1', num: '1', x: -2.54, y: 0, angle: 180 },
    { name: '2', num: '2', x: 2.54, y: 0, angle: 0 }] },
  N_MOSFET: { body: [-2.54, -3.81, 2.54, 3.81], pins: [
    { name: 'gate', num: '1', x: -5.08, y: 0, angle: 180 },
    { name: 'drain', num: '2', x: 0, y: 3.81, angle: 90 },
    { name: 'source', num: '3', x: 0, y: -3.81, angle: 270 }] },
  P_MOSFET: { body: [-2.54, -3.81, 2.54, 3.81], pins: [
    { name: 'gate', num: '1', x: -5.08, y: 0, angle: 180 },
    { name: 'drain', num: '2', x: 0, y: 3.81, angle: 90 },
    { name: 'source', num: '3', x: 0, y: -3.81, angle: 270 }] },
  IC_LED_DRIVER: { body: [-5.08, -1.27, 5.08, 10.16], pins: [
    { name: 'VIN', num: '1', x: -5.08, y: 8.89, angle: 180 },
    { name: 'GATE', num: '2', x: -5.08, y: 6.35, angle: 180 },
    { name: 'CS', num: '3', x: -5.08, y: 3.81, angle: 180 },
    { name: 'DIM', num: '4', x: -5.08, y: 1.27, angle: 180 },
    { name: 'SW', num: '5', x: 5.08, y: 8.89, angle: 0 },
    { name: 'LED', num: '6', x: 5.08, y: 6.35, angle: 0 },
    { name: 'NTC', num: '7', x: 5.08, y: 3.81, angle: 0 },
    { name: 'GND', num: '8', x: 5.08, y: 1.27, angle: 0 }] }
};

function symType(t) { return SYM[t] ? t : 'GENERIC'; }

/* 生成 lib_symbols 里的符号定义 */
function symbolDef(type) {
  const s = SYM[type];
  const [x1, y1, x2, y2] = s.body;
  const pins = s.pins.map(p =>
    `      (pin passive line (at ${p.x} ${p.y} ${p.angle}) (length 2.54) (name "${p.name}" ${_fx()}) (number "${p.num}" ${_fx()}))`
  ).join('\n');
  return `(symbol "m10:${type}"
    (pin_numbers (hide yes))
    (pin_names (offset 0.254))
    (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "${type === 'IC_LED_DRIVER' ? 'U' : type.slice(0, 1)}" (at 0 ${y2 + 2.54} 0) ${_fx()})
    (property "Value" "${type}" (at 0 ${y1 - 2.54} 0) ${_fx()})
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Description" "${type}" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "${type}_0_1"
      (rectangle (start ${x1} ${y1}) (end ${x2} ${y2})
        (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "${type}_1_1"
${pins})
    (embedded_fonts no))`;
}

/* 符号实例（Reference 放符号上方、Value 放符号下方，图纸 y 向下：上方 = loc.y - 顶部，下方 = loc.y - 底部） */
function symInstance(type, ref, value, x, y, rootUuid) {
  x = rnd(x); y = rnd(y);
  const s = SYM[type];
  const [bx1, by1, bx2, by2] = s.body;
  const refY = rnd(y - by2 - 1.27);   // 符号顶部（图纸 y 小）再往上
  const valY = rnd(y - by1 + 1.27);   // 符号底部（图纸 y 大）再往下
  const pins = s.pins.map(p => `    (pin "${p.num}" (uuid "${u()}"))`).join('\n');
  return `  (symbol
    (lib_id "m10:${type}")
    (at ${x} ${y} 0)
    (unit 1)
    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid "${u()}")
    (property "Reference" "${ref}" (at ${x} ${refY} 0) (effects (font (size 1.27 1.27)) (justify bottom)))
    (property "Value" "${value}" (at ${x} ${valY} 0) (effects (font (size 1.0 1.0)) (justify top)))
    (property "Footprint" "" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Datasheet" "" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Description" "${type}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (hide yes)))
${pins}
    (instances
      (project "m10-circuit"
        (path "/${rootUuid}"
          (reference "${ref}")
          (unit 1)
        )
      )
    )
  )`;
}

/* net label */
function netLabel(name, x, y, angle) {
  x = rnd(x); y = rnd(y);
  return `  (label "${name}" (at ${x} ${y} ${angle}) (effects (font (size 1.27 1.27)) (justify right)) (uuid "${u()}"))`;
}

/* 布局：元件网格排列，每行 4 个；IC 单独一行 */
function layout(components) {
  const pos = {};
  let row = 0, col = 0;
  const GAPX = 25.4, GAPY = 17.78;
  components.forEach(c => {
    const t = symType(c.type);
    if (t === 'IC_LED_DRIVER') {
      pos[c.designator] = { x: 76.2, y: 43.18, type: t };
    } else {
      pos[c.designator] = { x: 25.4 + col * GAPX, y: 101.6 - row * GAPY, type: t };
      col++;
      if (col >= 4) { col = 0; row++; }
    }
  });
  return pos;
}

/* 解析网表节点 "U1.SW" → {ref, pin} */
function parseNode(node) {
  const m = node.match(/^(.+?)\.(.+)$/);
  return m ? { ref: m[1], pin: m[2] } : { ref: node, pin: '1' };
}

/* 主生成 */
function genComplexSch(structure, rootUuid) {
  rootUuid = rootUuid || u();
  const comps = structure.components || [];
  const conns = structure.connections || [];
  const pos = layout(comps);
  const byRef = {};
  comps.forEach(c => { byRef[c.designator] = c; });

  // 收集用到的符号类型
  const usedTypes = [...new Set(comps.map(c => symType(c.type)))];
  const libSymbols = usedTypes.map(symbolDef).join('\n  ');

  const body = [];
  // 放置符号实例
  comps.forEach(c => {
    const p = pos[c.designator];
    body.push(symInstance(p.type, c.designator, c.value || c.type, p.x, p.y, rootUuid));
  });

  // 放置 net label：遍历网表，每个节点在对应引脚处放标签（同一节点去重，避免冗余网表导致标签重叠）
  const labels = [];
  const seenNodes = new Set();
  conns.forEach(conn => {
    const net = conn.net;
    (conn.nodes || []).forEach(node => {
      if (seenNodes.has(node)) return;
      seenNodes.add(node);
      const { ref, pin } = parseNode(node);
      const comp = byRef[ref];
      if (!comp) return;
      const t = symType(comp.type);
      const sym = SYM[t];
      const p = sym.pins.find(pp => pp.name === pin || pp.num === pin);
      if (!p) return;
      const loc = pos[ref];
      // label 放在引脚端点（图纸坐标 y 向下：符号坐标 y 需翻转，即 loc.y - p.y）
      labels.push(netLabel(net, loc.x + p.x, loc.y - p.y, p.angle === 180 ? 180 : 0));
    });
  });

  return `(kicad_sch
  (version 20250114)
  (generator "m10-circuit-ai")
  (generator_version "1.0")
  (uuid "${rootUuid}")
  (paper "A3")
  (title_block
    (title "${structure.title || '电路'}（${structure.topology || ''}）")
    (date "${new Date().toISOString().slice(0, 10)}"))
  (lib_symbols
  ${libSymbols}
  )
${body.join('\n')}
${labels.join('\n')}
  (sheet_instances
    (path "/" (page "1"))
  )
  (embedded_fonts no)
)`;
}

/* ============ PCB 生成（板框 + 元件封装 + 网表，不布线） ============ */
function padFor(p, netId, netName, idx, n) {
  const spacing = 2.54;
  const x = rnd((idx - (n - 1) / 2) * spacing);
  return `    (pad "${p.num}" thru_hole circle (at ${x} 0) (size 1.7 1.7) (drill 1.0) (layers "*.Cu" "*.Mask")${netId ? ` (net ${netId} "${netName}")` : ''} (uuid "${u()}"))`;
}

function fpFor(type, ref, value, x, y, pinNets) {
  const s = SYM[type];
  const n = s.pins.length;
  const w = n * 2.54 + 3.0;
  const pads = s.pins.map((p, i) => {
    const net = pinNets[p.name] || pinNets[p.num];
    return padFor(p, net ? net[0] : null, net ? net[1] : '', i, n);
  }).join('\n');
  return `  (footprint "m10:${type}"
    (layer "F.Cu")
    (uuid "${u()}")
    (at ${rnd(x)} ${rnd(y)})
    (attr through_hole)
    (property "Reference" "${ref}" (at 0 ${rnd(-n * 1.27 - 2.2)} 0) (layer "F.SilkS") (uuid "${u()}") ${_fx()})
    (property "Value" "${value}" (at 0 ${rnd(n * 1.27 + 2.2)} 0) (layer "F.Fab") (uuid "${u()}") (effects (font (size 1.0 1.0))))
    (fp_line (start ${rnd(-w / 2)} ${rnd(-n * 1.27 - 1.0)}) (end ${rnd(w / 2)} ${rnd(-n * 1.27 - 1.0)}) (layer "F.SilkS") (stroke (width 0.12) (type solid)) (uuid "${u()}"))
    (fp_line (start ${rnd(w / 2)} ${rnd(-n * 1.27 - 1.0)}) (end ${rnd(w / 2)} ${rnd(n * 1.27 + 1.0)}) (layer "F.SilkS") (stroke (width 0.12) (type solid)) (uuid "${u()}"))
    (fp_line (start ${rnd(w / 2)} ${rnd(n * 1.27 + 1.0)}) (end ${rnd(-w / 2)} ${rnd(n * 1.27 + 1.0)}) (layer "F.SilkS") (stroke (width 0.12) (type solid)) (uuid "${u()}"))
    (fp_line (start ${rnd(-w / 2)} ${rnd(n * 1.27 + 1.0)}) (end ${rnd(-w / 2)} ${rnd(-n * 1.27 - 1.0)}) (layer "F.SilkS") (stroke (width 0.12) (type solid)) (uuid "${u()}"))
${pads}
    (embedded_fonts no)
  )`;
}

function genComplexPcb(structure) {
  const comps = structure.components || [];
  const conns = structure.connections || [];
  // net 编号（net 0 保留）
  const netIds = {};
  conns.forEach(c => { if (c.net && netIds[c.net] === undefined) netIds[c.net] = Object.keys(netIds).length + 1; });
  const netLines = ['  (net 0 "")'].concat(Object.keys(netIds).map(nm => `  (net ${netIds[nm]} "${nm}")`)).join('\n');
  // 每元件每引脚 → 网络
  const seen = {};
  conns.forEach(c => (c.nodes || []).forEach(nd => {
    if (seen[nd]) return; seen[nd] = 1;
  }));
  const byRef = {}; comps.forEach(c => byRef[c.designator] = c);
  // 布局：4 列网格
  const GAPX = 25.4, GAPY = 22.86;
  const fps = [];
  const maxX = [];
  comps.forEach((c, i) => {
    const t = symType(c.type);
    const col = i % 4, row = Math.floor(i / 4);
    const x = 20 + col * GAPX, y = 20 + row * GAPY;
    maxX.push(x);
    // 引脚→网络
    const pinNets = {};
    conns.forEach(cn => (cn.nodes || []).forEach(nd => {
      const { ref, pin } = parseNode(nd);
      if (ref === c.designator) pinNets[pin] = [netIds[cn.net], cn.net];
    }));
    fps.push(fpFor(t, c.designator, c.value || c.type, x, y, pinNets));
  });
  const W = Math.max(90, (Math.max(...maxX, 40)) + 15), H = Math.max(60, (Math.ceil(comps.length / 4)) * GAPY + 25);
  const E = (x1, y1, x2, y2) => `  (gr_line (start ${rnd(x1)} ${rnd(y1)}) (end ${rnd(x2)} ${rnd(y2)}) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "${u()}"))`;
  return `(kicad_pcb
  (version 20241229)
  (generator "m10-circuit-ai")
  (generator_version "1.0")
  (general (thickness 1.6))
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (2 "B.Cu" signal)
    (9 "F.Adhes" user "F.Adhesive")
    (11 "B.Adhes" user "B.Adhesive")
    (13 "F.Paste" user)
    (15 "B.Paste" user)
    (5 "F.SilkS" user "F.Silkscreen")
    (7 "B.SilkS" user "B.Silkscreen")
    (1 "F.Mask" user)
    (3 "B.Mask" user)
    (17 "Dwgs.User" user "User.Drawings")
    (19 "Cmts.User" user "User.Comments")
    (21 "Eco1.User" user "User.Eco1")
    (23 "Eco2.User" user "User.Eco2")
    (25 "Edge.Cuts" user)
    (27 "Margin" user)
    (31 "F.CrtYd" user "F.Courtyard")
    (29 "B.CrtYd" user "B.Courtyard")
    (35 "F.Fab" user)
    (33 "B.Fab" user)
  )
${netLines}
${fps.join('\n')}
${E(5, 5, W - 5, 5)}
${E(W - 5, 5, W - 5, H - 5)}
${E(W - 5, H - 5, 5, H - 5)}
${E(5, H - 5, 5, 5)}
  (embedded_fonts no)
)`;
}

module.exports = { genComplexSch, genComplexPcb, SYM, symType };
