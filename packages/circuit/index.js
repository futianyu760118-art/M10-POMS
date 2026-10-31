'use strict';
// packages/circuit — 通俗语言 → KiCad 原理图(.kicad_sch) + PCB(.kicad_pcb) 生成器。
// 模板 + 参数化（无 LLM 依赖）；符号与封装全部内嵌（本编译版 KiCad 无标准库）。
// 仅生成图纸，不提供自动布线；PCB 为板框 + 元件封装 + 网表（未走线）。
const crypto = require('crypto');
const u = () => crypto.randomUUID();
const rnd = (x) => Math.round(x * 10000) / 10000; // 消除浮点误差，统一到 0.0001mm

/* ================= 原理图内嵌符号定义（lib_symbols 项） ================= */
// 统一约定：二端元件「上连接点」= (0,+3.81)，「下连接点」= (0,-3.81)（即 pin 的 at 位置）；电源符号连接点 = (0,0)。
const _fx = () => '(effects (font (size 1.27 1.27)))';
const SCH_SYMBOLS = {
  // 电阻（竖直）
  R: `(symbol "circuit:R"
    (pin_numbers (hide yes))
    (pin_names (offset 0))
    (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "R" (at 2.032 0 90) ${_fx()})
    (property "Value" "R" (at 0 0 90) ${_fx()})
    (property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Description" "Resistor" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "R_0_1"
      (rectangle (start -1.016 -2.54) (end 1.016 2.54)
        (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "R_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "" ${_fx()}) (number "1" ${_fx()}))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "" ${_fx()}) (number "2" ${_fx()})))
    (embedded_fonts no))`,
  // 发光二极管（竖直，阳极 A 在上、阴极 K 在下）
  LED: `(symbol "circuit:LED"
    (pin_numbers (hide yes))
    (pin_names (offset 0.254))
    (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "D" (at 2.54 0 0) ${_fx()})
    (property "Value" "LED" (at 2.54 -1.905 0) ${_fx()})
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Description" "Light emitting diode" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "LED_0_1"
      (polyline (pts (xy 0 1.27) (xy -1.27 -1.27) (xy 1.27 -1.27) (xy 0 1.27))
        (stroke (width 0.254) (type default)) (fill (type none)))
      (polyline (pts (xy -1.27 -1.27) (xy 1.27 -1.27))
        (stroke (width 0.254) (type default)) (fill (type none)))
      (polyline (pts (xy 1.27 0.508) (xy 2.286 1.27) (xy 2.286 0.254))
        (stroke (width 0.254) (type default)) (fill (type none)))
      (polyline (pts (xy 1.27 -0.508) (xy 2.286 0.254) (xy 2.286 -0.762))
        (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "LED_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "A" ${_fx()}) (number "2" ${_fx()}))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "K" ${_fx()}) (number "1" ${_fx()})))
    (embedded_fonts no))`,
  // 电容（无极性，竖直）
  C: `(symbol "circuit:C"
    (pin_numbers (hide yes))
    (pin_names (offset 0.254))
    (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "C" (at 0.635 2.54 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "C" (at 0.635 -2.54 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "" (at 0.9652 -3.81 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Description" "Unpolarized capacitor" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "C_0_1"
      (polyline (pts (xy -2.032 0.762) (xy 2.032 0.762)) (stroke (width 0.508) (type default)) (fill (type none)))
      (polyline (pts (xy -2.032 -0.762) (xy 2.032 -0.762)) (stroke (width 0.508) (type default)) (fill (type none))))
    (symbol "C_1_1"
      (pin passive line (at 0 3.81 270) (length 2.794) (name "" ${_fx()}) (number "1" ${_fx()}))
      (pin passive line (at 0 -3.81 90) (length 2.794) (name "" ${_fx()}) (number "2" ${_fx()})))
    (embedded_fonts no))`,
  // 单刀单掷开关（竖直）
  SW: `(symbol "circuit:SW"
    (pin_numbers (hide yes))
    (pin_names (offset 0.254))
    (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "SW" (at 2.54 1.27 0) ${_fx()})
    (property "Value" "SW" (at 2.54 -1.27 0) ${_fx()})
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Description" "Switch single pole single throw" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "SW_0_1"
      (polyline (pts (xy 0 2.54) (xy 1.524 0)) (stroke (width 0.254) (type default)) (fill (type none)))
      (circle (center 0 -2.54) (radius 0.254) (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "SW_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "" ${_fx()}) (number "1" ${_fx()}))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "" ${_fx()}) (number "2" ${_fx()})))
    (embedded_fonts no))`,
  // 电源 +VCC
  VCC: `(symbol "circuit:VCC"
    (power global)
    (pin_numbers (hide yes))
    (pin_names (offset 0) (hide yes))
    (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "#PWR" (at 0 -3.81 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Value" "VCC" (at 0 3.556 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Description" "Power symbol creates a global label with name VCC" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "VCC_0_1"
      (polyline (pts (xy -0.762 1.27) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none)))
      (polyline (pts (xy 0 2.54) (xy 0.762 1.27)) (stroke (width 0) (type default)) (fill (type none)))
      (polyline (pts (xy 0 0) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "VCC_1_1"
      (pin power_in line (at 0 0 90) (length 0) (name "" ${_fx()}) (number "1" ${_fx()})))
    (embedded_fonts no))`,
  // 地 GND
  GND: `(symbol "circuit:GND"
    (power global)
    (pin_numbers (hide yes))
    (pin_names (offset 0) (hide yes))
    (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "#PWR" (at 0 -6.35 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Value" "GND" (at 0 -3.81 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Description" "Power symbol creates a global label with name GND, ground" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "GND_0_1"
      (polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27))
        (stroke (width 0) (type default)) (fill (type none))))
    (symbol "GND_1_1"
      (pin power_in line (at 0 0 270) (length 0) (name "" ${_fx()}) (number "1" ${_fx()})))
    (embedded_fonts no))`
};

// 各元件「上/下」连接点对应的引脚号。
// KiCad 符号坐标 y 向上（pin at 0 3.81 在符号上方），图纸坐标 y 向下（pin 的 y 在图纸中翻转）。
// 故：符号上 pin 对应图纸 y-POFF，符号下 pin 对应图纸 y+POFF。
// R/C/SW：pin1(at 0 3.81)=上，pin2(at 0 -3.81)=下；LED：A(pin2)=上，K(pin1)=下。
const PIN = { R: { up: '1', down: '2' }, LED: { up: '2', down: '1' }, C: { up: '1', down: '2' }, SW: { up: '1', down: '2' } };

/* ================= 通俗语言解析（中文关键词 + 参数提取） ================= */
function pickVoltage(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:v|伏|V)/i);
  return m ? m[1] + 'V' : '5V';
}
function extractResistor(text) {
  let m = text.match(/(\d+(?:\.\d+)?)\s*(k|K)\b/);
  if (m) return m[1] + 'k';
  m = text.match(/(\d+(?:\.\d+)?)\s*(?:Ω|欧|欧姆|ohm)/);
  if (m) return m[1];
  m = text.match(/(\d+(?:\.\d+)?)\s*(?:的)?\s*(?:限流|上拉|下拉|电阻)/);
  if (m) return m[1];
  return '330';
}
function extractCap(text) {
  let m = text.match(/(\d+(?:\.\d+)?)\s*(u|μ|n|p|m)\s*F/i);
  if (m) return m[1] + (m[2] === 'μ' ? 'u' : m[2].toLowerCase()) + 'F';
  m = text.match(/(\d+(?:\.\d+)?)\s*(u|μ|n|p|m)\b/i);
  if (m) return m[1] + (m[2] === 'μ' ? 'u' : m[2].toLowerCase());
  return '100n';
}

function parse(text) {
  const s = String(text || '').toLowerCase();
  const t = String(text || '');
  const supply = pickVoltage(t);
  const components = [];
  let nets = [];

  const has = (re) => re.test(s);
  const resValue = extractResistor(t);
  const capValue = extractCap(t);

  const wantLed = has(/led|发光|指示灯|灯/) || /灯/.test(t);
  const wantSw = has(/开关|按键|按钮|switch/) || /按键|开关/.test(t);
  const wantCap = has(/电容|滤波|去耦|旁路/) || /电容/.test(t);
  const wantR = has(/电阻|限流|上拉|下拉/) || /电阻/.test(t) || /Ω|欧/.test(t);

  if (!wantLed && !wantSw && !wantCap && !wantR) {
    components.push({ type: 'R', ref: 'R1', value: '330' });
    components.push({ type: 'LED', ref: 'D1', value: 'LED' });
    nets.push('VCC', 'N$1', 'GND');
    return { title: 'LED 指示灯电路', supply, components, nets, source: 'template:led' };
  }

  const refCount = {};
  const add = (type, value) => {
    refCount[type] = (refCount[type] || 0) + 1;
    const prefix = type === 'LED' ? 'D' : type;
    components.push({ type, ref: prefix + refCount[type], value });
  };

  if (wantSw) add('SW', 'SW');
  if (wantR) add('R', resValue);
  if (wantLed) add('LED', 'LED');
  if (wantCap) add('C', capValue);

  if (!components.length) {
    components.push({ type: 'R', ref: 'R1', value: '330' });
    components.push({ type: 'LED', ref: 'D1', value: 'LED' });
  }

  nets = ['VCC'];
  for (let i = 1; i < components.length; i++) nets.push('N$' + i);
  nets.push('GND');

  const label = [];
  if (wantSw) label.push('按键输入');
  if (wantLed) label.push('LED 指示灯');
  if (wantCap) label.push('电源滤波');
  if (!label.length) label.push('自定义电路');

  return { title: label.join(' + ') + '电路', supply, components, nets, source: 'template' };
}

/* ================= 原理图生成 ================= */
function schSymbol(libId, x, y, ref, value, pinNums, rootUuid) {
  x = rnd(x); y = rnd(y);
  const pins = pinNums.map((pn) => `    (pin "${pn}" (uuid "${u()}"))`).join('\n');
  const desc = { R: 'Resistor', LED: 'Light emitting diode', C: 'Unpolarized capacitor', SW: 'Switch' }[libId] || '';
  return `  (symbol
    (lib_id "circuit:${libId}")
    (at ${x} ${y} 0)
    (unit 1)
    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid "${u()}")
    (property "Reference" "${ref}" (at ${x} ${y} 0) ${_fx()})
    (property "Value" "${value}" (at ${x} ${y} 0) ${_fx()})
    (property "Footprint" "" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Datasheet" "" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Description" "${desc}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (hide yes)))
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

function schWire(x, y1, y2) {
  x = rnd(x); y1 = rnd(y1); y2 = rnd(y2);
  return `  (wire (pts (xy ${x} ${y1}) (xy ${x} ${y2})) (stroke (width 0) (type solid)) (uuid "${u()}"))`;
}

function genSch(c) {
  const X = 50.8;
  const TOP = 20.32;   // VCC 在顶部（y 小）
  const GAP = 10.16;   // 元件纵向间隔
  const POFF = 3.81;   // pin 电气连接点相对符号原点的偏移（at 位置）
  const rootUuid = u();
  const libSymbols = ['VCC', ...c.components.map(x => x.type), 'GND']
    .filter((t, i, a) => a.indexOf(t) === i)
    .map(t => SCH_SYMBOLS[t]).join('\n  ');

  const body = [];
  body.push(schSymbol('VCC', X, TOP, '#PWR01', c.supply === '5V' ? 'VCC' : '+' + c.supply, ['1'], rootUuid));
  // y 轴向下：元件依次向下排列；上连接点 = y - POFF，下连接点 = y + POFF
  const yOf = (i) => TOP + GAP + i * GAP;
  let wires = [];
  wires.push(schWire(X, TOP, yOf(0) - POFF));
  c.components.forEach((it, i) => {
    const y = yOf(i);
    body.push(schSymbol(it.type, X, y, it.ref, it.value, PIN[it.type] ? [PIN[it.type].up, PIN[it.type].down] : ['1', '2'], rootUuid));
    if (i + 1 < c.components.length) {
      wires.push(schWire(X, y + POFF, yOf(i + 1) - POFF));
    }
  });
  const gndY = TOP + GAP + c.components.length * GAP;
  wires.push(schWire(X, yOf(c.components.length - 1) + POFF, gndY));
  body.push(schSymbol('GND', X, gndY, '#PWR02', 'GND', ['1'], rootUuid));

  return `(kicad_sch
  (version 20250114)
  (generator "m10-circuit")
  (generator_version "1.0")
  (uuid "${rootUuid}")
  (paper "A4")
  (title_block
    (title "${c.title}")
    (date "${new Date().toISOString().slice(0, 10)}"))
  (lib_symbols
  ${libSymbols}
  )
${body.join('\n')}
${wires.join('\n')}
  (sheet_instances
    (path "/" (page "1"))
  )
  (embedded_fonts no)
)`;
}

/* ================= PCB 生成（板框 + 内嵌封装 + 网表，不布线） ================= */
function pcbFootprint(ref, value, x, y, netA, netB, isLed) {
  const pads = [
    `    (pad "1" smd rect (at -1.0 0) (size 1.0 1.3) (layers "F.Cu" "F.Paste" "F.Mask") (net ${netA[0]} "${netA[1]}") (uuid "${u()}"))`,
    `    (pad "2" smd rect (at 1.0 0) (size 1.0 1.3) (layers "F.Cu" "F.Paste" "F.Mask") (net ${netB[0]} "${netB[1]}") (uuid "${u()}"))`
  ];
  const silk = isLed
    ? `    (fp_line (start -0.6 -0.6) (end -0.6 0.6) (layer "F.SilkS") (stroke (width 0.12) (type solid)) (uuid "${u()}"))`
    : '';
  return `  (footprint "circuit:${isLed ? 'LED_0805' : 'R_0805'}"
    (layer "F.Cu")
    (uuid "${u()}")
    (at ${rnd(x)} ${rnd(y)})
    (attr smd)
    (property "Reference" "${ref}" (at 0 -1.6 0) (layer "F.SilkS") (uuid "${u()}") ${_fx()})
    (property "Value" "${value}" (at 0 1.6 0) (layer "F.Fab") (uuid "${u()}") ${_fx()})
    (fp_line (start -1.6 -0.9) (end 1.6 -0.9) (layer "F.SilkS") (stroke (width 0.12) (type solid)) (uuid "${u()}"))
    (fp_line (start 1.6 -0.9) (end 1.6 0.9) (layer "F.SilkS") (stroke (width 0.12) (type solid)) (uuid "${u()}"))
    (fp_line (start 1.6 0.9) (end -1.6 0.9) (layer "F.SilkS") (stroke (width 0.12) (type solid)) (uuid "${u()}"))
    (fp_line (start -1.6 0.9) (end -1.6 -0.9) (layer "F.SilkS") (stroke (width 0.12) (type solid)) (uuid "${u()}"))
${silk}
${pads.join('\n')}
    (embedded_fonts no)
  )`;
}

function pcbEdgeLine(x1, y1, x2, y2) {
  return `  (gr_line (start ${rnd(x1)} ${rnd(y1)}) (end ${rnd(x2)} ${rnd(y2)}) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "${u()}"))`;
}

function genPcb(c) {
  const W = Math.max(30, c.components.length * 10 + 10);
  const H = 24;
  const netMap = {};
  c.nets.forEach((nm, i) => { netMap[nm] = i + 1; });

  const footprints = c.components.map((it, i) => {
    const x = 8 + i * 10;
    const y = 12;
    const netUp = c.nets[i];
    const netDown = c.nets[i + 1];
    let pad1Net, pad2Net;
    if (it.type === 'LED') {
      pad1Net = [netMap[netDown], netDown];
      pad2Net = [netMap[netUp], netUp];
    } else {
      pad1Net = [netMap[netUp], netUp];
      pad2Net = [netMap[netDown], netDown];
    }
    return pcbFootprint(it.ref, it.value, x, y, pad1Net, pad2Net, it.type === 'LED');
  });

  const nets = ['  (net 0 "")']
    .concat(c.nets.map((nm, i) => `  (net ${i + 1} "${nm}")`)).join('\n');

  return `(kicad_pcb
  (version 20241229)
  (generator "m10-circuit")
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
${nets}
${footprints.join('\n')}
${pcbEdgeLine(2, 2, W - 2, 2)}
${pcbEdgeLine(W - 2, 2, W - 2, H - 2)}
${pcbEdgeLine(W - 2, H - 2, 2, H - 2)}
${pcbEdgeLine(2, H - 2, 2, 2)}
  (embedded_fonts no)
)`;
}

/* ================= 入口 ================= */
// 从结构化参数构建电路（供前端「改参数重新生成」）：{ supply, components:[{type,value}] }
function fromParams(params) {
  const supply = (params && params.supply) || '5V';
  const refCount = {};
  const components = ((params && params.components) || []).filter(c => c && c.type).map(c => {
    const type = c.type;
    refCount[type] = (refCount[type] || 0) + 1;
    const prefix = type === 'LED' ? 'D' : type;
    return { type, ref: prefix + refCount[type], value: c.value || type };
  });
  if (!components.length) {
    components.push({ type: 'R', ref: 'R1', value: '330' });
    components.push({ type: 'LED', ref: 'D1', value: 'LED' });
  }
  const nets = ['VCC'];
  for (let i = 1; i < components.length; i++) nets.push('N$' + i);
  nets.push('GND');
  const label = components.map(c => (c.type === 'LED' ? 'LED' : c.type)).join(' + ');
  return { title: label + ' 电路', supply, components, nets, source: 'params' };
}

function generate(textOrParams) {
  const c = typeof textOrParams === 'string' ? parse(textOrParams) : fromParams(textOrParams);
  return { circuit: c, sch: genSch(c), pcb: genPcb(c) };
}

module.exports = { generate, parse, genSch, genPcb, fromParams };
