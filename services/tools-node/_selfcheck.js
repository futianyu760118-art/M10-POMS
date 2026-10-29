const { PDFDocument } = require('pdf-lib');
const http = require('http');

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => { if (ok) { pass++; console.log('  [PASS] ' + name + (detail ? ' | ' + detail : '')); } else { fail++; console.log('  [FAIL] ' + name + (detail ? ' | ' + detail : '')); } };

  // 1. BFF 页面为新版且禁缓存
  const page = await req({ host: '127.0.0.1', port: 4173, path: '/plm2', method: 'GET' });
  const html = page.body.toString('utf8');
  check('BFF /plm2 可访问', page.status === 200);
  check('页面无旧版中文请求头 x-watermark-text', !html.includes('x-watermark-text'));
  check('页面含新版表单字段 watermark', html.includes("fd.append('watermark'"));
  check('响应含 Cache-Control: no-store', (page.headers['cache-control'] || '').includes('no-store'));

  // 2. tools-node 健康与 CORS
  const health = await req({ host: '127.0.0.1', port: 8003, path: '/health', method: 'GET' });
  const hj = JSON.parse(health.body.toString('utf8'));
  check('tools-node /health 200', health.status === 200);
  check('pdf-lib 引擎真实', hj.engines.pdf === 'pdf-lib', hj.engines.pdf);
  check('CORS 头存在', (health.headers['access-control-allow-origin'] || '') === '*');

  // 3. OPTIONS 预检
  const pre = await req({ host: '127.0.0.1', port: 8003, path: '/watermark/pdf', method: 'OPTIONS', headers: { Origin: 'http://192.168.0.71:4173', 'Access-Control-Request-Method': 'POST' } });
  check('OPTIONS 预检通过', pre.status === 204 && (pre.headers['access-control-allow-origin'] || '') === '*');

  // 4. 端到端：模拟浏览器 FormData（file + 中文 watermark 字段，UTF-8）
  const d = await PDFDocument.create();
  d.addPage([300, 200]);
  const pdfBuf = await d.save();
  const B = '----BrowserFormBoundaryABC123';
  const wm = Buffer.from('恒剑光电 内部资料', 'utf8'); // 浏览器 FormData 字段为 UTF-8
  const body = Buffer.concat([
    Buffer.from('--' + B + '\r\nContent-Disposition: form-data; name="file"; filename="spec.pdf"\r\nContent-Type: application/pdf\r\n\r\n'),
    pdfBuf,
    Buffer.from('\r\n--' + B + '\r\nContent-Disposition: form-data; name="watermark"\r\n\r\n'),
    wm,
    Buffer.from('\r\n--' + B + '--\r\n')
  ]);
  const wmRes = await req({
    host: '127.0.0.1', port: 8003, path: '/watermark/pdf', method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + B, 'Content-Length': body.length, Origin: 'http://192.168.0.71:4173' }
  }, body);
  const isPdf = wmRes.body.slice(0, 5).toString() === '%PDF-';
  check('加水印请求 200', wmRes.status === 200);
  check('返回为有效 PDF', isPdf, '大小 ' + wmRes.body.length + ' 字节');
  check('水印响应含 CORS 头', (wmRes.headers['access-control-allow-origin'] || '') === '*');
  check('响应类型为 application/pdf', (wmRes.headers['content-type'] || '').includes('application/pdf'));

  console.log('\n自查结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
