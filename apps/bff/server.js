'use strict';
// apps/bff — POMS 代理与服务端授权（L0 mock，未接入生产接口）。
// 纯 Node http 实现，无第三方依赖，可直接 `npm start` 运行。
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn, execFileSync } = require('child_process');
const circuit = require('../../packages/circuit');

const ROOT = path.join(__dirname, '..', '..');
const assembly = require('../../packages/assembly');
const capture = require('../../packages/capture');
const m01 = require('../../adapters/m01');
const m07 = require('../../adapters/m07');
const hlc = require('../../adapters/hlc');
const org = require('../../adapters/org');
const plm2 = require('../../adapters/plm2');
const plmSync = require('../../adapters/plm2/sync');
const TOOLS = require('../../configs/tools.json');
const SKILLS = require('../../configs/skills.json');
const hub = require('../../adapters/hub');

/* ---- M10 统一认证（与 M04 PLM 同一账号/令牌/角色） ---- */
const ROLE_PRIORITY = ['ADMIN', 'admin', 'gm', 'rd_manager', 'engineer', 'project_manager', 'sales_director', 'sales_manager', 'purchase', 'finance', 'cw1', 'sales', 'sales_user', 'viewer', 'QUALITY', 'hr_manager'];
const ROLE_MAP = { ADMIN: 'ADMIN', admin: 'ADMIN', gm: 'GM', rd_manager: 'RD_LEAD', engineer: 'ENGINEER', project_manager: 'PROJECT_MANAGER', sales_director: 'SALES_MANAGER', sales_manager: 'SALES_MANAGER', purchase: 'PURCHASE', finance: 'FINANCE', cw1: 'FINANCE', sales: 'SALES', sales_user: 'SALES', viewer: 'VIEWER', hr_manager: 'VIEWER', QUALITY: 'QUALITY', ENGINEER: 'ENGINEER', SALES: 'SALES' };
const authCache = new Map(); // token -> { exp, vo }

function deriveRole(roleCodeStr) {
  const rs = String(roleCodeStr || '').split(',').map(s => s.trim()).filter(Boolean);
  const primary = ROLE_PRIORITY.find(p => rs.includes(p));
  return ROLE_MAP[primary] || 'VIEWER';
}
function mapPerson(vo) {
  const ppl = plm2.getPeople();
  const byUser = ppl.find(p => p.username === vo.username);
  const byName = ppl.find(p => p.name === vo.realName);
  const person = byUser || byName || ppl[0] || null;
  return person ? person.id : null;
}
function authSession(vo) {
  const roleCodes = vo.roles && vo.roles.length ? vo.roles : [];
  const demoRoles = [...new Set(roleCodes.map(r => ROLE_MAP[r] || 'VIEWER'))];
  const primary = deriveRole(roleCodes.join(','));
  // 兼岗：合并所有角色的模块权限
  let mergedPerms = [];
  try { demoRoles.forEach(r => { mergedPerms = mergedPerms.concat(plm2.getManifest(r).permission_matrix || []); }); mergedPerms = [...new Set(mergedPerms)]; } catch(e) { mergedPerms = []; }
  return {
    userId: vo.userId, username: vo.username, realName: vo.realName,
    roleCode: roleCodes.join(','),
    roles: demoRoles,
    role: primary,
    permissions: mergedPerms,
    personId: mapPerson(vo)
  };
}
// 写操作鉴权：带令牌 → 经 PLM /auth/info 真验证（60s 缓存）并以其角色覆盖客户端角色；无令牌 → L0 演示模式（沿用 body.role）
async function guardWriteRole(req, body) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return; // L0 演示模式
  const tok = m[1];
  const hit = authCache.get(tok);
  if (hit && hit.exp > Date.now()) { body.role = hit.roles ? hit.roles.join(',') : hit.role; return; }
  let vo = null;
  try { vo = await plmSync.infoWith(tok); } catch (e) {
    throw Object.assign(new Error('令牌无效或已过期（M04 统一认证）'), { status: 401 });
  }
  const s = authSession(vo);
  authCache.set(tok, { exp: Date.now() + 30000, role: s.role, roles: s.roles, vo });
  body.role = s.roles ? s.roles.join(',') : s.role;
}

const PORT = process.env.PORT || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers));
  if (Buffer.isBuffer(body)) return res.end(body);
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(Object.assign(e, { status: 400 })); } });
    req.on('error', reject);
  });
}

function allowedActions(person, req) {
  const a = [];
  if (req.state === 'DRAFT' || req.state === 'SUBMITTED') a.push('acknowledge');
  if (person.capabilities.includes('hlc:request:assign') && ['SUBMITTED', 'TRIAGED', 'NEEDS_INFO'].includes(req.state)) a.push('assign');
  if (person.capabilities.includes('hlc:request:execute') && req.state === 'ASSIGNED') a.push('execute');
  if (req.state === 'AWAITING_ACCEPTANCE' && person.capabilities.includes('hlc:request:verify')) a.push('verify');
  if (person.capabilities.includes('hlc:request:approve') && req.state === 'APPROVAL_PENDING') a.push('approve');
  return a;
}

function serveStatic(reqPath, res) {
  let file = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  if (file === '/' || file === '') file = '/index.html';
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    const ext = path.extname(full).toLowerCase();
    send(res, 200, buf, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const q = parsed.query;

  try {
    // 静态页面入口
    if (pathname === '/' || pathname === '/portal') return serveStatic('/demo/portal.html', res);
    if (pathname === '/org' || pathname === '/org/') return serveStatic('/demo/index.html', res);
    if (pathname === '/demo') return serveStatic('/demo/index.html', res);
    if (pathname === '/mobile' || pathname === '/mobile/') return serveStatic('/apps/mobile-web/index.html', res);
    if (pathname === '/simple' || pathname === '/simple/') return serveStatic('/apps/simple/index.html', res);
    if (pathname === '/plm2' || pathname === '/plm2/') return serveStatic('/demo/plm2.html', res);
    if (pathname === '/hlc' || pathname === '/hlc/') return serveStatic('/demo/hlc.html', res);
    if (pathname.startsWith('/demo/') || pathname.startsWith('/apps/') || pathname.startsWith('/vendor/')) return serveStatic(pathname, res);
    if (pathname.startsWith('/favicon')) return send(res, 204, '');

    // ---- API (proposal only) ----
    if (pathname === '/poms/v1/me/manifest' && req.method === 'GET') {
      const manifest = assembly.assemble({
        actor_id: q.actor_id,
        product_family: q.product_family,
        model_id: q.model_id,
        process_revision: q.process_revision,
        device_capabilities: { camera: q.camera !== '0', mic: q.mic !== '0' },
        context_revision: q.context_revision
      });
      return send(res, 200, manifest);
    }

    if (pathname === '/poms/v1/me/actions' && req.method === 'GET') {
      const actions = m01.getDEHActions(q.actor_id);
      return send(res, 200, { actor_id: q.actor_id, actions });
    }

    if (pathname === '/poms/v1/captures' && req.method === 'POST') {
      const body = await readBody(req);
      const result = capture.submitCapture({ ...body, idempotency_key: req.headers['idempotency-key'] || body.idempotency_key });
      return send(res, 202, result);
    }

    if (pathname === '/poms/v1/agents' && req.method === 'GET') {
      return send(res, 200, { agents: hub.listAgents(), hub_connected: hub.HUB_CONNECTED });
    }

    const sessionMatch = pathname.match(/^\/poms\/v1\/agents\/([^/]+)\/sessions$/);
    if (sessionMatch && req.method === 'POST') {
      const session = hub.openSession(sessionMatch[1]);
      return send(res, 201, session);
    }

    // ---- PLM-2 研发中心（真实数据接入，来自 PLM2 仓库） ----
    if (pathname === '/api/v1/plm2/roles' && req.method === 'GET') {
      return send(res, 200, { roles: plm2.getRoles(), departments: plm2.getDepartments(), modules: plm2.getModules() });
    }
    if (pathname === '/api/v1/plm2/people' && req.method === 'GET') {
      return send(res, 200, { people: plm2.getPeople(q.role) });
    }
    if (pathname === '/api/v1/plm2/dicts' && req.method === 'GET') {
      return send(res, 200, { dicts: plm2.getDicts(), lifecycle: plm2.getLifecycle() });
    }
    if (pathname === '/api/v1/plm2/me/manifest' && req.method === 'GET') {
      return send(res, 200, plm2.getManifest(q.role));
    }
    if (pathname === '/api/v1/plm2/me/overview' && req.method === 'GET') {
      return send(res, 200, plm2.overview(q.user));
    }
    if (pathname === '/api/v1/plm2/me/todos' && req.method === 'GET') {
      const u = plm2.getPeople().find(p => p.id === Number(q.user));
      return send(res, 200, Object.assign({ realName: u ? u.name : q.user }, plm2.todosFor(u ? u.name : '')));
    }
    if (pathname === '/api/v1/plm2/me/dept-todos' && req.method === 'GET') {
      return send(res, 200, plm2.deptTodos(q.user));
    }
    if (pathname === '/api/v1/plm2/work-items' && req.method === 'GET') {
      const wsTodos = plm2.listApprovalTodos(q.user).filter(t => t.status === 'OPEN');
      return send(res, 200, { items: [...wsTodos, ...plm2.listWorkItems(q.user)] });
    }
    if (pathname === '/api/v1/plm2/materials' && req.method === 'GET') {
      return send(res, 200, { materials: plm2.listMaterials(q.role) });
    }
    if (pathname === '/api/v1/plm2/ecns' && req.method === 'GET') {
      return send(res, 200, { ecns: plm2.listEcns(q.role) });
    }
    if (pathname === '/api/v1/plm2/process-routes' && req.method === 'GET') {
      return send(res, 200, { routes: plm2.listProcessRoutes() });
    }
    const stepDone = pathname.match(/^\/api\/v1\/plm2\/process-routes\/([^/]+)\/steps\/(\d+)\/complete$/);
    if (stepDone && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, plm2.completeStep(stepDone[1], stepDone[2], body));
    }
    if (pathname === '/api/v1/plm2/projects' && req.method === 'GET') {
      return send(res, 200, { projects: plm2.listProjects(), gates: plm2.getGates() });
    }
    if (pathname === '/api/v1/plm2/tools' && req.method === 'GET') {
      return send(res, 200, { tools: TOOLS.tools });
    }
    if (pathname === '/api/v1/skills' && req.method === 'GET') {
      const skill = q.id ? SKILLS.skills.find(s => s.id === q.id) : null;
      if (q.id && !skill) return send(res, 404, { error: 'skill not found' });
      return send(res, 200, q.id ? skill : {
        pack: SKILLS.skillPack, version: SKILLS.version, description: SKILLS.description,
        count: SKILLS.skills.length, skills: SKILLS.skills, plmRealAgents: SKILLS.plmRealAgents, usage: SKILLS.usage
      });
    }
    const toolLaunch = pathname.match(/^\/api\/v1\/plm2\/tools\/([^/]+)\/launch$/);
    if (toolLaunch && req.method === 'POST') {
      const id = toolLaunch[1];
      const tool = TOOLS.tools.find(t => t.id === id);
      if (!tool || tool.type !== 'desktop') return send(res, 404, { ok: false, error: '工具不存在或非桌面工具' });
      const bin = tool.bin;
      if (!bin || !fs.existsSync(bin)) return send(res, 503, { ok: false, installed: false, error: tool.name + ' 未安装（未配置可执行文件）' });
      try {
        const child = spawn(bin, [], { cwd: path.dirname(bin), detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        return send(res, 200, { ok: true, id, name: tool.name, pid: child.pid, launched: true });
      } catch (e) {
        return send(res, 500, { ok: false, launched: false, error: '启动失败：' + e.message });
      }
    }
    const kicadGen = pathname.match(/^\/api\/v1\/plm2\/tools\/kicad\/generate$/);
    if (kicadGen && req.method === 'POST') {
      const body = await readBody(req);
      let r;
      if (body.params && Array.isArray(body.params.components)) {
        r = circuit.generate({ supply: body.params.supply, components: body.params.components });
      } else {
        const text = String(body.text || body.prompt || '').trim();
        if (!text) return send(res, 422, { ok: false, error: '请输入电路需求描述（通俗语言）或元件参数' });
        r = circuit.generate(text);
      }
      const outDir = process.env.KICAD_OUT_DIR || 'D:/KiCad/generated';
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const base = 'gen_' + Date.now().toString(36);
      const schPath = path.join(outDir, base + '.kicad_sch').replace(/\\/g, '/');
      const pcbPath = path.join(outDir, base + '.kicad_pcb').replace(/\\/g, '/');
      fs.writeFileSync(schPath, r.sch, 'utf8');
      fs.writeFileSync(pcbPath, r.pcb, 'utf8');
      fs.writeFileSync(path.join(outDir, base + '.kicad_pro'), JSON.stringify({ board: {}, meta: { filename: base + '.kicad_pro', version: 0 } }, null, 2), 'utf8');
      return send(res, 200, {
        ok: true,
        title: r.circuit.title,
        supply: r.circuit.supply,
        components: r.circuit.components,
        nets: r.circuit.nets,
        schPath, pcbPath
      });
    }
    const kicadGenAi = pathname.match(/^\/api\/v1\/plm2\/tools\/kicad\/generate-ai$/);
    if (kicadGenAi && req.method === 'POST') {
      const body = await readBody(req);
      let structure;
      const deepseek = require('../../packages/circuit/deepseek');
      const schComplex = require('../../packages/circuit/sch-complex');
      if (body.structure && Array.isArray(body.structure.components)) {
        if (body.edit && String(body.edit).trim()) {
          structure = await deepseek.editStructure(body.structure, body.edit);
        } else {
          structure = body.structure;
        }
      } else {
        const text = String(body.text || body.prompt || '').trim();
        if (!text) return send(res, 422, { ok: false, error: '请输入电路需求/BOM 描述' });
        structure = await deepseek.analyze(text);
      }
      const sch = schComplex.genComplexSch(structure);
      const pcb = schComplex.genComplexPcb(structure);
      const outDir = process.env.KICAD_OUT_DIR || 'D:/KiCad/generated';
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const base = 'ai_' + Date.now().toString(36);
      const schPath = path.join(outDir, base + '.kicad_sch').replace(/\\/g, '/');
      const pcbPath = path.join(outDir, base + '.kicad_pcb').replace(/\\/g, '/');
      fs.writeFileSync(schPath, sch, 'utf8');
      fs.writeFileSync(pcbPath, pcb, 'utf8');
      fs.writeFileSync(path.join(outDir, base + '.kicad_pro'), JSON.stringify({ board: {}, meta: { filename: base + '.kicad_pro', version: 0 } }, null, 2), 'utf8');
      return send(res, 200, {
        ok: true,
        title: structure.title,
        topology: structure.topology,
        components: structure.components,
        connections: structure.connections,
        schPath, pcbPath
      });
    }
    const kicadOpen = pathname.match(/^\/api\/v1\/plm2\/tools\/kicad\/open$/);
    if (kicadOpen && req.method === 'POST') {
      const body = await readBody(req);
      const file = path.normalize(String(body.file || ''));
      const outDir = path.normalize(process.env.KICAD_OUT_DIR || 'D:/KiCad/generated');
      if (!file.startsWith(outDir)) return send(res, 403, { ok: false, error: '只能打开生成目录内的文件' });
      const bin = (TOOLS.tools.find(t => t.id === 'kicad') || {}).bin;
      if (!bin || !fs.existsSync(bin)) return send(res, 503, { ok: false, error: 'KiCad 未安装' });
      // kicad.exe 是项目管理器：按扩展名路由到对应编辑器（pcb→pcbnew，sch→eeschema）
      const ext = path.extname(file).toLowerCase();
      const exe = ext === '.kicad_pcb' ? 'pcbnew.exe' : ext === '.kicad_sch' ? 'eeschema.exe' : path.basename(bin);
      const binExe = path.join(path.dirname(bin), exe);
      if (!fs.existsSync(binExe)) return send(res, 500, { ok: false, error: '未找到 ' + exe });
      const child = spawn(binExe, [file], { cwd: path.dirname(bin), detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return send(res, 200, { ok: true, file, exe, pid: child.pid });
    }
    const kicadPreview = pathname.match(/^\/api\/v1\/plm2\/tools\/kicad\/preview$/);
    if (kicadPreview && req.method === 'GET') {
      const file = path.normalize(String(q.file || ''));
      const outDir = path.normalize(process.env.KICAD_OUT_DIR || 'D:/KiCad/generated');
      if (!file.startsWith(outDir)) return send(res, 403, { ok: false, error: '只能预览生成目录内的文件' });
      if (!fs.existsSync(file)) return send(res, 404, { ok: false, error: '文件不存在' });
      const bin = (TOOLS.tools.find(t => t.id === 'kicad') || {}).bin;
      if (!bin || !fs.existsSync(bin)) return send(res, 503, { ok: false, error: 'KiCad 未安装' });
      const kicadCli = path.join(path.dirname(bin), 'kicad-cli.exe');
      const ext = path.extname(file).toLowerCase();
      const sub = ext === '.kicad_sch' ? 'sch' : 'pcb';
      const baseDir = fs.mkdtempSync(path.join(path.dirname(file), '_pv_'));
      const posix = (p) => p.replace(/\\/g, '/');
      try {
        let svg;
        if (sub === 'pcb') {
          // pcb export svg：-o 是输出文件本身（直接读取该文件）
          const outFile = path.join(baseDir, 'out.svg');
          execFileSync(kicadCli, ['pcb', 'export', 'svg', '-l', 'F.Cu,Edge.Cuts,F.SilkS,F.Fab', '-o', posix(outFile), posix(file)], { stdio: 'ignore', timeout: 60000, windowsHide: true });
          svg = fs.readFileSync(outFile, 'utf8');
        } else {
          // sch export svg：-o 是输出目录（kicad 自建并写入 <名>.svg）
          const outDir2 = path.join(baseDir, 'out');
          execFileSync(kicadCli, ['sch', 'export', 'svg', '-o', posix(outDir2), posix(file)], { stdio: 'ignore', timeout: 60000, windowsHide: true });
          const svgFile = fs.readdirSync(outDir2).find(f => f.endsWith('.svg'));
          if (!svgFile) throw new Error('SVG 导出失败');
          svg = fs.readFileSync(path.join(outDir2, svgFile), 'utf8');
        }
        if (!svg.includes('<svg')) throw new Error('SVG 内容无效');
        fs.rmSync(baseDir, { recursive: true, force: true });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(svg);
      } catch (e) {
        fs.rmSync(baseDir, { recursive: true, force: true });
        return send(res, 500, { ok: false, error: '预览生成失败：' + e.message });
      }
    }
    if (pathname === '/api/v1/plm2/worksheet-types' && req.method === 'GET') {
      return send(res, 200, { defs: plm2.getWorksheetDefs(), nodeMap: plm2.getNodeWorksheetMap() });
    }
    if (pathname === '/api/v1/plm2/worksheets' && req.method === 'GET') {
      return send(res, 200, { worksheets: plm2.listWorksheets(q.projectNo, q.nodeCode) });
    }
    if (pathname === '/api/v1/plm2/worksheets' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 201, plm2.submitWorksheet(body));
    }
    if (pathname === '/api/v1/plm2/ws-templates' && req.method === 'GET') {
      return send(res, 200, { templates: plm2.getWsTemplates(), nodeMap: plm2.getNodeWorksheetMap() });
    }
    if (pathname === '/api/v1/plm2/ws-history' && req.method === 'GET') {
      return send(res, 200, await plm2.getWorksheetHistory({ projectNo: q.projectNo, nodeCode: q.nodeCode }));
    }
    if (pathname === '/api/v1/plm2/ws-v2' && req.method === 'GET') {
      if (q.approvals === '1') return send(res, 200, { items: plm2.listWorksheetApprovals() });
      return send(res, 200, { items: plm2.listWorksheetsV2(q) });
    }
    if (pathname === '/api/v1/plm2/ws-v2' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, plm2.makeWorksheet(body));
    }
    const wsAppr = pathname.match(/^\/api\/v1\/plm2\/ws-v2\/([^/]+)\/(approve|reject)$/);
    if (wsAppr && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      const fn = wsAppr[2] === 'approve' ? plm2.approveWorksheet : plm2.rejectWorksheet;
      const r = fn(wsAppr[1], body);
      const syncResults = await plm2.flushSync();
      return send(res, 200, Object.assign(r, { plmSync: syncResults[0] || null }));
    }
    if (pathname === '/api/v1/plm2/ecns' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 201, plm2.createEcn(body));
    }
    const projMatch = pathname.match(/^\/api\/v1\/plm2\/projects\/([^/]+)$/);
    if (projMatch && req.method === 'GET') {
      return send(res, 200, await plm2.getProjectAsync(decodeURIComponent(projMatch[1]), { fresh: q.fresh === '1' }));
    }
    if (pathname === '/api/v1/plm2/auth/revoke' && req.method === 'POST') {
      authCache.clear();
      return send(res, 200, { revoked: true, clearedAt: new Date().toISOString(), note: '已清空令牌缓存，下次写操作将重新经 PLM /auth/info 验证（令牌无效则 401）' });
    }
    if (pathname === '/api/v1/plm2/initiations' && req.method === 'GET') {
      return send(res, 200, { items: plm2.listInitiations(q) });
    }
    if (pathname === '/api/v1/plm2/initiations' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 201, plm2.createInitiation(body));
    }
    const initTrans = pathname.match(/^\/api\/v1\/plm2\/initiations\/([^/]+)\/transition$/);
    if (initTrans && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      return send(res, 200, plm2.transitionInitiation(initTrans[1], body.action, body));
    }
    if (pathname === '/api/v1/plm2/sync-status' && req.method === 'GET') {
      return send(res, 200, plm2.syncStatus());
    }
    if (pathname === '/api/v1/plm2/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { token, vo } = await plmSync.loginWith(body.username, body.password);
        return send(res, 200, Object.assign({ token }, authSession(vo)));
      } catch (e) {
        return send(res, e.status === 401 ? 401 : (e.status || 502), { error: e.message });
      }
    }
    if (pathname === '/api/v1/plm2/auth/me' && req.method === 'GET') {
      const h = req.headers['authorization'] || '';
      const m = h.match(/^Bearer\s+(.+)$/i);
      if (!m) return send(res, 401, { error: '未登录' });
      try {
        const vo = await plmSync.infoWith(m[1]);
        return send(res, 200, authSession(vo));
      } catch (e) {
        return send(res, 401, { error: e.message });
      }
    }
    if (pathname === '/api/v1/plm2/sync' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      return send(res, 200, await plm2.syncPull(body.person || null));
    }
    const prjStatusM = pathname.match(/^\/api\/v1\/plm2\/projects\/([^/]+)\/status$/);
    if (prjStatusM && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, plm2.updateProjectStatus(prjStatusM[1], body.status, body.role));
    }
    const nodeUpd = pathname.match(/^\/api\/v1\/plm2\/projects\/([^/]+)\/nodes\/([^/]+)$/);
    if (nodeUpd && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      const r = plm2.updateNode(decodeURIComponent(nodeUpd[1]), decodeURIComponent(nodeUpd[2]), body);
      const syncResults = await plm2.flushSync();
      return send(res, 200, Object.assign(r, { plmSync: syncResults[0] || null }));
    }
    const prjEdit = pathname.match(/^\/api\/v1\/plm2\/projects\/([^/]+)\/edit$/);
    if (prjEdit && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      const r = plm2.updateProject(decodeURIComponent(prjEdit[1]), body, body.role);
      const syncResults = await plm2.flushSync();
      return send(res, 200, Object.assign(r, { plmSync: syncResults[0] || null }));
    }
    const matEdit = pathname.match(/^\/api\/v1\/plm2\/materials\/([^/]+)\/edit$/);
    if (matEdit && req.method === 'POST') {
      const body = await readBody(req);
      await guardWriteRole(req, body);
      return send(res, 200, plm2.updateMaterial(decodeURIComponent(matEdit[1]), body, body.role));
    }
    if (pathname === '/api/v1/plm2/capture-types' && req.method === 'GET') {
      return send(res, 200, { captureTypes: plm2.getCaptureTypes(q.role) });
    }
    if (pathname === '/api/v1/plm2/captures' && req.method === 'GET') {
      return send(res, 200, { captures: plm2.listCaptures(q.operator) });
    }
    if (pathname === '/api/v1/plm2/captures' && req.method === 'POST') {
      const body = await readBody(req);
      const result = plm2.submitCapture({ ...body, idempotency_key: req.headers['idempotency-key'] || body.idempotency_key });
      return send(res, result.replay ? 200 : 201, result);
    }
    const matTrans = pathname.match(/^\/api\/v1\/plm2\/materials\/([^/]+)\/transition$/);
    if (matTrans && req.method === 'POST') {
      const body = await readBody(req);
      const r = plm2.transitionMaterial(matTrans[1], body.action, body.role);
      return send(res, 200, r);
    }
    const ecnTrans = pathname.match(/^\/api\/v1\/plm2\/ecns\/([^/]+)\/transition$/);
    if (ecnTrans && req.method === 'POST') {
      const body = await readBody(req);
      const r = plm2.ecnTransition(ecnTrans[1], body.action, body.role);
      return send(res, 200, r);
    }
    const wiDone = pathname.match(/^\/api\/v1\/plm2\/work-items\/([^/]+)\/done$/);
    if (wiDone && req.method === 'POST') {
      const body = await readBody(req);
      const r = plm2.completeWorkItem(wiDone[1], body.role);
      return send(res, 200, r);
    }

    // ---- 组织/岗位装配（公司→部门→岗位→职责/任务/能力包） ----
    if (pathname === '/api/v1/org/companies' && req.method === 'GET') {
      return send(res, 200, { companies: org.listCompanies() });
    }
    if (pathname === '/api/v1/org/departments' && req.method === 'GET') {
      return send(res, 200, { departments: org.listDepartments(q.company) });
    }
    if (pathname === '/api/v1/org/positions' && req.method === 'GET') {
      return send(res, 200, { positions: org.listPositions(q.company, q.department) });
    }
    if (pathname === '/api/v1/org/assemble' && req.method === 'GET') {
      const result = org.assemble({ company: q.company, department: q.department, position: q.position });
      return send(res, 200, result);
    }

    // ---- 恒剑 M07+M10 契约（来自《AEOS_M07_M10_可开发资料包 V1.0》03 章，候选） ----
    if (pathname === '/api/v1/poms/me/workspace' && req.method === 'GET') {
      const p = m01.getPerson(q.person_id);
      const widgets = ['future_todos', 'past_results', 'personal_agent'].map(id => ({ id, visible: true }));
      const actions = [];
      if (p.capabilities.includes('hlc:request:create')) actions.push('hlc.service_request.create');
      if (p.capabilities.includes('hlc:request:assign')) actions.push('hlc.request.assign');
      if (p.capabilities.includes('hlc:request:approve')) actions.push('hlc.request.approve');
      if (p.capabilities.includes('hlc:request:verify')) actions.push('hlc.request.verify');
      return send(res, 200, {
        tenant_id: p.tenant_id,
        person_id: p.person_id,
        name: p.name,
        positions: p.positions,
        policy_version: 'candidate-v1',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        industry_pack_ref: 'lighting_demo',
        widgets,
        actions
      });
    }

    if (pathname === '/api/v1/poms/me/work-items' && req.method === 'GET') {
      const p = m01.getPerson(q.person_id);
      const isAdmin = p.capabilities.includes('hlc:request:read');
      let all, source = 'm07-mock';
      try { all = await hlc.listRequests({ ...q, requester: q.person_id }, q.person_id); source = 'hlc-rest'; }
      catch (e) { all = m07.listRequests(q); source = 'm07-mock-fallback'; }
      const items = all
        .filter(r => isAdmin || r.requester === p.person_id || r.assignee === p.person_id)
        .filter(r => ['CLOSED', 'ARCHIVED', 'REJECTED', 'CANCELLED'].indexOf(r.state) < 0)
        .map(r => ({
          work_item_id: 'wi_' + r.id,
          tenant_id: p.tenant_id,
          assignee_person_id: p.person_id,
          source_system: 'M07',
          source_object_type: r.type === 'leave' ? 'LeaveRequest' : 'LogisticsRequest',
          source_object_id: r.id,
          title: r.subject,
          display_status: r.state.toLowerCase(),
          due_at: r.sla && /^\d{4}/.test(r.sla) ? r.sla : (r.sla ? '2026-' + r.sla + 'T09:00:00+08:00' : null),
          allowed_action_refs: allowedActions(p, r)
        }));
      return send(res, 200, { items, source });
    }

    if (pathname === '/api/v1/poms/me/results' && req.method === 'GET') {
      const p = m01.getPerson(q.person_id);
      let all, source = 'm07-mock';
      try { all = await hlc.listRequests({ ...q, requester: q.person_id }, q.person_id); source = 'hlc-rest'; }
      catch (e) { all = m07.listRequests(q); source = 'm07-mock-fallback'; }
      const results = all
        .filter(r => r.state === 'CLOSED' || r.state === 'ARCHIVED')
        .map(r => ({ result_id: r.result_ref || 'res_' + r.id, source_system: 'M07', source_object_id: r.id, verification: r.verified_by ? 'verified' : 'pending', evidence_refs: r.evidence_refs, verified_by: r.verified_by, verified_at: r.verified_at }));
      return send(res, 200, { results, source });
    }

    if (pathname === '/api/v1/hlc/status' && req.method === 'GET') {
      return send(res, 200, await hlc.status());
    }

    if (pathname === '/api/v1/hlc/people' && req.method === 'GET') {
      const people = m07.getPeople();
      const st = await hlc.status();
      // 标注哪些演示演员已映射真实 HLC 账号（未映射的写操作走服务账号）
      people.forEach(p => { p.hlc_real = !!hlc.ACTORS[p.person_id]; });
      return send(res, 200, { people, source: st.connected ? 'hlc-rest' : 'm07-mock', hlc: st });
    }

    if (pathname === '/api/v1/hlc/service-requests' && req.method === 'POST') {
      const body = await readBody(req);
      const idempotency_key = req.headers['idempotency-key'] || body.idempotency_key;
      try {
        const created = await hlc.createRequest({ ...body, idempotency_key }); // 真实 HLC：DRAFT
        if (!created.replay) await hlc.submitRequest(created.id, body.requester);
        const full = await hlc.getRequest(created.id, body.requester);
        return send(res, created.replay ? 200 : 201, { ...full, history: undefined, replay: created.replay, source: 'hlc-rest' });
      } catch (e) {
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 401) throw e; // 业务错误如实上抛
        // HLC 不可达 → 降级 mock（与 PLM 读透降级同策略）
        const created = m07.createRequest({ ...body, idempotency_key });
        if (!created.replay) m07.submitRequest(created.id, body.requester);
        return send(res, created.replay ? 200 : 201, { ...m07.getRequest(created.id), history: undefined, replay: created.replay, source: 'm07-mock-fallback', hlc_error: e.message });
      }
    }
    if (pathname === '/api/v1/hlc/service-requests' && req.method === 'GET') {
      try {
        return send(res, 200, { requests: await hlc.listRequests(q, q.person_id), source: 'hlc-rest' });
      } catch (e) {
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 401) throw e;
        return send(res, 200, { requests: m07.listRequests(q), source: 'm07-mock-fallback', hlc_error: e.message });
      }
    }

    let srMatch = pathname.match(/^\/api\/v1\/hlc\/service-requests\/([^/]+)$/);
    if (srMatch && req.method === 'GET') {
      try {
        return send(res, 200, await hlc.getRequest(srMatch[1], q.person_id));
      } catch (e) {
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 401) throw e;
        return send(res, 200, m07.getRequest(srMatch[1]));
      }
    }

    let trMatch = pathname.match(/^\/api\/v1\/hlc\/service-requests\/([^/]+)\/transitions$/);
    if (trMatch && req.method === 'POST') {
      const body = await readBody(req);
      const actor = m01.getPerson(body.actor);
      const next = body.next_state;
      // 服务端执行前再鉴权（UI 隐藏 ≠ 权限控制）
      if (['TRIAGED', 'ASSIGNED'].includes(next) && !actor.capabilities.includes('hlc:request:assign')) throw Object.assign(new Error('permission denied'), { status: 403 });
      if (['APPROVED', 'REJECTED', 'POLICY_CHECKED'].includes(next) && !actor.capabilities.includes('hlc:request:approve')) throw Object.assign(new Error('permission denied'), { status: 403 });
      try {
        const updated = await hlc.transition(trMatch[1], next, { actor: body.actor, note: body.note, assignee: body.assignee, evidence_ref: body.evidence_ref, verifier: body.verifier, sla: body.sla, scope: body.scope, expectedVersion: body.expected_version });
        return send(res, 200, { ...updated, source: 'hlc-rest' });
      } catch (e) {
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 401) throw e;
        const updated = m07.transition(trMatch[1], next, { actor: body.actor, note: body.note, assignee: body.assignee, evidence_ref: body.evidence_ref, verifier: body.verifier, sla: body.sla });
        return send(res, 200, { ...updated, source: 'm07-mock-fallback', hlc_error: e.message });
      }
    }

    if (pathname === '/api/v1/agents/personal/sessions' && req.method === 'POST') {
      const body = await readBody(req);
      const session = hub.openSession(body.agent_id);
      return send(res, 201, session);
    }

    return send(res, 404, { error: 'not found', hint: '见 docs/V2.3_20261023/API_OPENAPI.yaml' });
  } catch (e) {
    const status = e.status || 500;
    return send(res, status, { error: e.message || 'internal error' });
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  const os = require('os');
  const lanIps = Object.values(os.networkInterfaces()).flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal)
    .map(n => n.address);
  const hlcSt = await hlc.status().catch(() => ({ connected: false }));
  console.log('M10 POMS BFF 已启动: http://localhost:' + PORT);
  lanIps.forEach(ip => console.log('  局域网访问:  http://' + ip + ':' + PORT + '/'));
  console.log('  系统门户:   http://localhost:' + PORT + '/');
  console.log('  岗位装配:   http://localhost:' + PORT + '/org');
  console.log('  PLM-2 研发中心: http://localhost:' + PORT + '/plm2');
  console.log('  M07+M10 双端: http://localhost:' + PORT + '/hlc');
  console.log('  HLC 真实后端: ' + (hlcSt.connected ? '已连接 ' + hlcSt.api + '（/api/v1/hlc/* 走真实接口）' : '未连接（降级 mock，' + (hlcSt.error || 'HLC_API 未配置或不可达') + '）'));
  console.log('  恒剑 M07+M10: http://localhost:' + PORT + '/api/v1/poms/me/workspace?person_id=p-002');
  console.log('  API 示例:   http://localhost:' + PORT + '/poms/v1/me/manifest?actor_id=u-1001&product_family=led-light');
  console.log('  契约测试:   npm test');
  console.log('  Hub 连接:   ' + (hub.HUB_CONNECTED ? '已连接' : '未连接（模拟模式，HUB_CONNECTED=1 可开启）'));
});
