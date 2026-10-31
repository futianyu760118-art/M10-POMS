<<<<<<< HEAD
# M10

AEOS V7.2.2 对齐的 M10 POMS L0 工作台：按岗位装配的采集/录入/审批/跟踪微系统。经 BFF + adapters 以数据级引用接入真实系统（PLM-2 生产库 166 项目等），并提供报修/请假（M07+M10）、ECN、物料生命周期、22 节点、工序流转、AI 录入与水印等能力。不是第二套专业主数据系统——所有专业事实归 M04~M09，M10 只做工作面、采集与引用。
=======
# M10 POMS · 岗位与个人运营微系统（L0 Demo）

> AEOS V7.2.2 对齐 · 结合《AEOS_M07_M10_可开发资料包 V1.0》（恒剑）与仓库 `docs/V2.3_20261023` 构建的可运行 L0 Demo。
> 全部为**本地模拟数据（mock）**，未接入任何生产接口；状态一律候选/PROPOSED，不得声称已通过 G0/G2/G3。

## 快速开始

```bash
# 1) 纯静态 Demo（无需 Node，浏览器直接打开）
start demo/index.html

# 2) Node BFF + 契约测试（Node.js 20+，无第三方依赖）
npm start      # 启动 BFF 于 http://localhost:4173
npm test       # 运行 L0 契约测试
```

启动 BFF 后：

| 入口 | 说明 |
|---|---|
| `http://localhost:4173/plm2` | **PLM-2 研发中心工作台**（真实 PLM 数据：六大角色/ECN三级审批/物料生命周期/22节点+工作表填报联动/工序流转/待办/采集录入/AI/工序工具） |
| `http://localhost:4173/hlc` | **M07+M10 人事行政双端**（报修/请假首条闭环：员工发起→M07受理/派单/审批→留证→验收 done≠verified→归档→M10报告） |
| `http://localhost:4173/` | **AEOS 统一门户**（选择系统：PLM / HLC / CRM / SCP / FAC / EDP / Hub / EBMS） |
| `http://localhost:4173/org` | 岗位自动装配（公司→部门→岗位级联） |
| `http://localhost:4173/demo/inspection.html` | 品质检验 Demo（V2.3：扫码采集 / done≠verified / 灯具·定时器能力包） |
| `http://localhost:4173/simple` | 前后端打通最小示例（manifest + 采集） |
| `http://localhost:4173/mobile` | PWA 示例（manifest 装配） |

## PLM-2 研发中心（首个接入系统，数据来自 gitee PLM2 仓库）

> **已切换为真实生产库数据**：`node scripts/import-from-plm.js` 从本机 Docker `plm-postgres/plm_v4` 导入
> （166 个真实项目 / 3718 节点 / 40 物料 / 1 ECN / 25 真实用户），覆盖 `configs/plm2.json` 数据区；
> 角色/权限/生命周期/工作表定义等结构保留。**复制到其他部门**：参照此脚本对接各系统库
> （CRM `crm-postgres:55434`、EBMS `:3010` 均在本机运行）。

以 PLM 中台 V4.0 实际数据构建：**五大部门**（研发/品质/生产/销售/供应链）、**六大固定角色 + 研发主管/供应链总监**、**PartNo 全局唯一主键**、**ECN 三级审批**（提交→研发主管一审→供应链总监二审→生效，生效自动升级版本）、**物料生命周期状态机**、**工序自动化流转**（上道完成自动推送下道待办）、**plm_work_item 待办**。

```
GET  /api/v1/plm2/roles                          部门/角色/权限矩阵/模块
GET  /api/v1/plm2/me/manifest?role=              岗位装配（按角色下发模块+职责）
GET  /api/v1/plm2/me/overview?user=              我的概览（待办/物料/ECN 统计）
GET  /api/v1/plm2/work-items?user=               我的待办
GET  /api/v1/plm2/materials                      物料主数据
GET  /api/v1/plm2/ecns                           ECN 变更单
GET  /api/v1/plm2/process-routes                 工序路线
POST /api/v1/plm2/materials/{partNo}/transition  物料生命周期流转（角色鉴权）
POST /api/v1/plm2/ecns/{ecnNo}/transition        ECN 三级审批（角色鉴权）
POST /api/v1/plm2/work-items/{itemNo}/done       待办完成
GET  /api/v1/plm2/worksheet-types                工作表定义 + 节点映射（8 类 / 18 节点）
GET  /api/v1/plm2/worksheets?projectNo=          工作表记录（节点证据）
POST /api/v1/plm2/worksheets                     填报工作表 → 按完成判定自动联动节点 DONE/IN_PROGRESS
POST /api/v1/plm2/process-routes/{no}/steps/{n}/complete  工序完成（仅负责人，自动激活下一道/闭环）
```

## AI 智能录入（PaddleOCR + FunASR + Qwen2.5-VL）

`services/ai-entry/` 提供录入 AI 能力，端口 **8002**（8001 被 PLM2 `plm-algorithm` 占用）：

```bash
cd services/ai-entry
pip install -r requirements.txt        # 未装模型依赖时自动降级为 MOCK
uvicorn app:app --host 0.0.0.0 --port 8002
```

| 接口 | 说明 |
|---|---|
| `POST /ocr` | 图片文字识别（PaddleOCR） |
| `POST /table` | 表格/版面结构（PP-Structure） |
| `POST /asr` | 中文语音转写（FunASR Paraformer） |
| `POST /vl` | 多模态理解/字段抽取（Qwen2.5-VL） |
| `GET /health` | 引擎状态（真实/mock） |

前端「采集录入 → AI 智能录入」按 `<本机IP>:8002` 调用；引擎为 mock 时明确标注「模拟识别」。

## 工序专用工具台（开源工具植入）

`configs/tools.json` 维护工具注册表，`demo/plm2.html`「工序工具」页展示并按节点调用：

| 类型 | 工具 | 状态 |
|---|---|---|
| 内嵌 JS | SheetJS（BOM Excel）、frappe-gantt（甘特）、Mermaid（流程图）、bpmn-js（流程查看器） | 已内嵌演示 |
| 服务端 | ezdxf（DXF 图纸解析）→ AI 服务 `POST /dxf`（8002） | 已接入 |
| 服务端 | pdf-lib + Sharp（水印）→ `services/tools-node`（8003）`/watermark/pdf` `/watermark/image` | 已接入 |
| 服务端 | Flowable（BPMN 引擎）→ `services/flowable/`（契约 + 示例 BPMN） | 候选 |
| 本地桌面 | FreeCAD / LibreCAD / KiCad | 启动器 |

```
GET  /api/v1/plm2/tools                    工具注册表
POST /api/v1/plm2/tools/{id}/launch        启动本地桌面工具（KiCad/FreeCAD/LibreCAD，未安装返回 503）
POST http://<ip>:8002/dxf                  DXF 图纸解析（ezdxf）
POST http://<ip>:8003/watermark/pdf         PDF 水印（pdf-lib）
POST http://<ip>:8003/watermark/image       图片水印（sharp）
```

## 岗位自动装配（公司/部门/岗位）
选择公司 → 部门 → 岗位后，系统按 `configs/org.json` 自动装配并展示该岗位的**职责**、**任务项**与**能力包**；两公司（恒剑光电 / 贞观电子）公共代码零产品侵入。

```
GET /api/v1/org/companies                          公司列表
GET /api/v1/org/departments?company=               部门级联
GET /api/v1/org/positions?company=&department=     岗位级联
GET /api/v1/org/assemble?company=&department=&position=  装配（职责/任务/能力包/manifest）
```

## 恒剑 M07+M10 首条 MVP 闭环（来自恒剑信息包）

员工 M10 发起报修/请假 → M01 Guard → M07 受理/分派/审批 → 处理上传证据 → **申请人/授权验收人验收**（done ≠ verified）→ M02 归档 → M10 查看报告。

**状态机（候选）**
- 后勤维修：`DRAFT → SUBMITTED → TRIAGED → ASSIGNED → IN_PROGRESS → AWAITING_ACCEPTANCE → CLOSED`
- 请假：`DRAFT → SUBMITTED → POLICY_CHECKED → APPROVAL_PENDING → APPROVED/REJECTED → APPLIED → ARCHIVED`

## HLC 真实后端接入（对齐 PLM-2 模式）

`/api/v1/hlc/*` 不再只走 mock：新增 `adapters/hlc` 经恒聘通 Flask REST（恒剑 HLC 仓库 `backend-python/routes/hlc.py`）读写真实 M07 工单，接入范式与 `adapters/plm2` 一致。

- **配置**：`HLC_API`（默认 http://localhost:18280，恒聘通 Nginx 入口）、`HLC_USER/HLC_PASS`（服务账号兜底）、`HLC_TENANT`、`HLC_ACTORS`（M10 person_id → 真实账号 JSON，默认 p-002=hr_admin、p-003=manager）
- **映射**：M10 的 next_state（状态目标式）→ HLC 的 action（动作式）；camelCase ↔ snake_case 契约互转；SLA 宽松解析（'10-17'/'2 天'/ISO）
- **降级**：4xx 业务错误如实上抛（409/403/422 语义与真实 HLC 一致）；网络不可达自动降级 `m07-mock-fallback` 并带 `hlc_error`
- **观测**：响应带 `source: 'hlc-rest' | 'm07-mock-fallback'`；`GET /api/v1/hlc/status` 查看连接与演员映射；people 列表带 `hlc_real` 标注
- **范围**：请假流程真实 HLC 暂未实现（返回 422，候选 Backlog S6）；maker-checker/幂等/证据约束由真实 HLC 终审

## 契约 API（对齐恒剑信息包 03 章）

```
GET  /api/v1/poms/me/workspace?person_id=        UI Manifest（widgets + actions）
GET  /api/v1/poms/me/work-items?person_id=       聚合待办引用
GET  /api/v1/poms/me/results?person_id=          ResultRef / 证据引用
POST /api/v1/hlc/service-requests               创建报修/请假（Idempotency-Key）
GET  /api/v1/hlc/service-requests[/{id}]        查询业务请求
POST /api/v1/hlc/service-requests/{id}/transitions  状态转换（服务端再鉴权）
POST /api/v1/agents/personal/sessions           个人 Agent 会话（Hub 未连接返回 503）
```

## 目录结构（对应 HANDOVER.md 建议）

```
apps/{mobile-web,bff,simple}   PWA / BFF / 打通示例
packages/{assembly,ui,capture} 装配 / UI白名单 / 采集幂等
adapters/{m01,m02,m05,m07,m08,hub,org,plm2}  mock adapter（plm2=研发中心真实数据）
configs/org.json              公司→部门→岗位→职责/任务/能力包 数据
configs/plm2.json             PLM-2 部门/角色/权限矩阵/模块/字典/生命周期/样例数据
configs/tenants/              企业差异配置
capability-packs/             行业产品差异（灯具 / 定时器 / 销售 Agent）
tests/contract/               L0 契约测试（26 项）
demo/plm2.html                PLM-2 研发中心工作台（详细工作用版）
demo/index.html               岗位自动装配 Demo（公司/部门/岗位级联）
demo/inspection.html          品质检验 Demo（V2.3）
```

## 红线提醒（勿在生产沿用 mock 语义）

- `done != verified`；执行者不可自验；跨租户默认拒绝；非法状态跳转 409。
- 高风险动作（录用/离职/调薪/权限变更）一律人工确认，Agent 审批建议不得直接执行。
- Hub 服务端令牌不得放浏览器；所有正式接口待各 Owner 签批后替换 mock adapter。
>>>>>>> 8fa48ed (feat(m10-poms): L0 微系统完整实现——PLM-2 真实数据接入 + M04 统一认证 + 实时同步 + 资料制作审批归档 + 兼岗 + 异常专区 + Agent + 立项五阶段)
