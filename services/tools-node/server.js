'use strict';
// services/tools-node — 工序工具服务（PDF 水印 + 图片水印）。
// 依赖 pdf-lib / sharp 惰性加载；未安装时自动降级为 MOCK（返回体 engine 前缀 mock-）。
// 端口 8003（8001=PLM2算法，8002=AI录入）。
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const PORT = process.env.PORT || 8003;

// 加载中文字体（PDF 水印需要嵌入中文字体，否则 WinAnsi 无法编码中文）
let _zhFont = undefined;
function loadZhFont() {
  if (_zhFont !== undefined) return _zhFont;
  const candidates = [
    'C:/Windows/Fonts/simhei.ttf',   // 黑体
    'C:/Windows/Fonts/simsun.ttc',   // 宋体
    'C:/Windows/Fonts/msyh.ttc',     // 微软雅黑
    'C:/Windows/Fonts/simfang.ttf'   // 仿宋
  ];
  for (const c of candidates) {
    try { _zhFont = fs.readFileSync(c); return _zhFont; } catch (e) { /* ignore */ }
  }
  _zhFont = null;
  return null;
}

let pdfLib = null, sharp = null;

function tryRequire(name) {
  try { return require(name); } catch (e) { return null; }
}

function engineStatus() {
  pdfLib = pdfLib === null ? tryRequire('pdf-lib') : pdfLib;
  sharp = sharp === null ? tryRequire('sharp') : sharp;
  return { pdf: pdfLib ? 'pdf-lib' : 'mock', image: sharp ? 'sharp' : 'mock' };
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-watermark-text'
  }, headers));
  if (Buffer.isBuffer(body)) return res.end(body);
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { req.destroy(); reject(Object.assign(new Error('too large'), { status: 413 })); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!m) return null;
  const boundary = '--' + (m[1] || m[2]).trim();
  const s = buf.toString('latin1');
  const parts = s.split(boundary).slice(1, -1);
  const result = { fields: {} };
  for (const part of parts) {
    const idx = part.indexOf('\r\n\r\n');
    if (idx < 0) continue;
    const head = part.slice(0, idx);
    const body = Buffer.from(part.slice(idx + 4).replace(/\r\n$/, ''), 'latin1');
    const nameM = /name="([^"]+)"/.exec(head);
    const fileM = /filename="([^"]*)"/.exec(head);
    if (!nameM) continue;
    if (nameM[1] === 'file') result.file = { filename: fileM ? fileM[1] : 'file', data: body };
    else result.fields[nameM[1]] = body.toString('utf8');
  }
  return result;
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') return send(res, 204, '');
  try {
    if (url === '/health') {
      return send(res, 200, { status: 'ok', engines: engineStatus() });
    }

    if (url === '/watermark/pdf' && req.method === 'POST') {
      const buf = await readBody(req);
      const part = parseMultipart(buf, req.headers['content-type']);
      const text = (part && part.fields.watermark) || decodeURIComponent(String(req.headers['x-watermark-text'] || '')) || '恒剑光电 内部资料';
      const engine = engineStatus();
      if (!engine.pdf) {
        return send(res, 200, { engine: 'mock-pdf-lib', filename: part && part.file && part.file.filename, watermark: text, note: '未安装 pdf-lib，返回模拟结果' });
      }
      const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
      const fontkit = require('@pdf-lib/fontkit');
      const doc = await PDFDocument.load(part && part.file ? part.file.data : buf);
      doc.registerFontkit(fontkit);
      const zhFont = loadZhFont();
      const font = zhFont ? await doc.embedFont(zhFont) : await doc.embedFont(StandardFonts.Helvetica);
      for (const page of doc.getPages()) {
        const { width, height } = page.getSize();
        page.drawText(String(text), { x: width / 2 - 90, y: height / 2, size: 28, font, color: rgb(0.85, 0.1, 0.1), opacity: 0.35, rotate: degrees(15) });
      }
      const out = Buffer.from(await doc.save());
      return send(res, 200, out, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="watermarked.pdf"' });
    }

    if (url === '/watermark/image' && req.method === 'POST') {
      const buf = await readBody(req);
      const part = parseMultipart(buf, req.headers['content-type']);
      const text = (part && part.fields.watermark) || decodeURIComponent(String(req.headers['x-watermark-text'] || '')) || '恒剑光电';
      const engine = engineStatus();
      if (!engine.image) {
        return send(res, 200, { engine: 'mock-sharp', filename: part && part.file && part.file.filename, watermark: text, note: '未安装 sharp，返回模拟结果' });
      }
      const sharp = require('sharp');
      const safe = String(text).replace(/[<>&]/g, '');
      const svg = Buffer.from(`<svg width="600" height="80"><text x="0" y="55" font-size="40" fill="rgba(255,0,0,0.45)" font-family="sans-serif">${safe}</text></svg>`);
      const out = await sharp(part && part.file ? part.file.data : buf).composite([{ input: svg, gravity: 'center' }]).png().toBuffer();
      return send(res, 200, out, { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="watermarked.png"' });
    }

    return send(res, 404, { error: 'not found', hint: '/health /watermark/pdf /watermark/image' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || 'internal error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('M10 工序工具服务已启动: http://localhost:' + PORT);
  console.log('  /health /watermark/pdf /watermark/image');
  console.log('  引擎: ' + JSON.stringify(engineStatus()) + '（未安装依赖时为 mock）');
});
