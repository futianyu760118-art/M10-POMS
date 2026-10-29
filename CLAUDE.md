# M10-POMS（AEOS 岗位与个人运营微系统）

> 本文件进 git，全团队共享。修改它等同于改代码，需要走 PR 评审。
> 个人偏好写在 `CLAUDE.local.md`（已 gitignore），不要写进这里。

## 这是什么

AEOS V7.2.2 对齐的 **M10 POMS L0 工作台**：按岗位装配的采集/录入/审批/跟踪微系统。经 BFF + adapters 以**数据级引用**接入真实系统（PLM-2 生产库 166 项目等），并提供报修/请假（M07+M10）、ECN、物料生命周期、22 节点、工序流转、AI 录入与水印等能力。**不是第二套专业主数据系统**——所有专业事实归 M04~M09，M10 只做工作面、采集与引用。

## 技术栈（已锁定，不得擅自更换或新增）

- 语言/运行时：`Node.js 20+（BFF 零第三方依赖，纯 http 模块）` + `Python 3.11（AI/工具服务）`
- 前端：`原生 HTML/JS 单文件演示页（demo/*.html），无框架、无构建`
- 数据：`configs/*.json（真实数据由 scripts/import-from-plm.js 从 Docker plm-postgres/plm_v4 导入）`
- 包管理器：`npm（仅 services/tools-node 有 node_modules：pdf-lib/sharp/@pdf-lib/fontkit）`
- 测试：`node 原生 assert 契约脚本 tests/contract/run.js（39 项）+ HTTP 冒烟自查脚本（services/tools-node/_selfcheck-*.js）`

## 目录结构（真实存在）

```
apps/bff/          # Node 零依赖 BFF：静态服务 + /api/v1/* 授权与转发（端口 4173）
adapters/          # 各系统 mock/引用适配器：m01身份 m02证据 m05 m07人力后勤 m08品质 hub org装配 plm2研发
packages/          # assembly装配 ui白名单 capture采集幂等
configs/           # org.json 岗位级联 / plm2.json 真实数据+状态机 / tools.json 工具注册
capability-packs/  # 灯具/定时器/销售Agent 能力包
services/          # ai-entry(FastAPI:8002 OCR/语音/VL/DXF) tools-node(水印:8003) flowable(契约)
demo/              # portal门户 plm2研发工作台 hlc双端 inspection品质 org装配台
scripts/           # import-from-plm.js 真实数据导入（可复制到其他系统）
tests/contract/    # 39 项契约测试
```

## 常用命令

| 用途 | 命令 |
|---|---|
| 启动 BFF | `npm start`（4173） |
| 跑测试 | `npm test`（39 项契约） |
| 导入真实数据 | `node scripts/import-from-plm.js`（需 Docker plm-postgres 运行） |
| 启动 AI 服务 | `cd services/ai-entry && python -m uvicorn app:app --host 0.0.0.0 --port 8002` |
| 启动水印服务 | `cd services/tools-node && npm install && node server.js`（8003） |
| JS 语法自查 | `node --check <file>`（改 demo 页内嵌脚本时提取后检查） |

## AEOS 7.2.2 红线（任何改动不得违背）

1. **done ≠ verified**：执行者不可自验；采集/处理提交后一律 `pending-review`，验收须授权验证人。
2. **M10 不写专业库**：只经 adapter/API/Event 引用；跨域直连、复制专业主数据一律禁止。
3. **UI 隐藏 ≠ 权限控制**：采集类型/动作按岗位过滤之外，服务端必须再鉴权（403/409）。
4. **高风险动作人工确认**：录用/离职/调薪/权限变更/量产放行等，Agent 不得自动执行。
5. **跨租户/越权默认拒绝**；状态机非法跳转返回 409。
6. **候选状态诚实**：未经 Owner/Gate 签批，不得声称 G0-G8 通过；mock 引擎必须标注"模拟"，不提供虚假成功（如 Hub 未连接返回 503）。

## 0-1 阶段五条铁律

1. **先确认再动手。** 需求、边界、验收标准有任何一项不清楚，先问，不要猜着写。
2. **不许过度抽象。** 没有第二处调用点，就不许抽公共层；没有第二个实现，就不许定义接口。
3. **依赖白名单。** 引入任何新包前必须说明理由并获人工批准，见 `.claude/rules/02-dependencies.md`。
4. **完成要给证据。** 说"做完了"必须附：跑了什么命令、结果是什么、还剩什么风险。见 `.claude/rules/03-delivery-evidence.md`。
5. **一个 task 一次 commit。** 便于随时回滚到上一个可用状态。（注：本项目尚未 `git init`，见维护备注）

## 详细规则

按需加载，不要在这里展开：

- 反过度设计 → `.claude/rules/01-no-over-engineering.md`
- 依赖管控 → `.claude/rules/02-dependencies.md`
- 交付证据 → `.claude/rules/03-delivery-evidence.md`
- 模块边界 → `.claude/rules/04-module-boundaries.md`
- 防跑偏（AEOS 基线对齐，团队首要风险）→ `.claude/rules/05-anti-drift.md`

## 不要做的事

- 不要改动本次任务范围外的文件；发现别处有问题，只报告不动手
- 不要提交 `.env`、`node_modules/`、构建产物、数据库备份
- 不要引入白名单外的第三方依赖
- 不要在没有跑测试（`npm test`）的情况下声称完成
- 不要直连真实库写入；`docker exec plm-postgres` 仅允许只读 SELECT（导入脚本内）
- 不要绕过 adapters 在 demo 页直接实现业务状态机

## 提交规范

`type(scope): 描述`，type 取 `feat` / `fix` / `refactor` / `docs` / `test` / `chore`。（git 尚未初始化，init 后生效）

## 维护这份文件

出现下面任一情况就该更新它：AI 违反了某条已有规则（说明写得不够明确）；或 AI 反复犯同一个错（说明缺一条规则）。每个迭代回顾一次，**删掉已经不起作用的规则**比新增更重要。
