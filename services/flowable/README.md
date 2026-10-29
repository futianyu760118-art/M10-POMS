# Flowable 工作流引擎接入说明（候选）

## 定位
PLM-2「工序流转 / 审批」的正式 BPMN 引擎候选。当前 demo 用 `adapters/plm2` 内存状态机 + 前端 bpmn-js 可视化；生产化时后端替换为 Flowable。

## 建议技术栈
- 引擎：Flowable（`flowable/flowable-engine`，Java 17，与 PLM2 后端 Spring Boot 同栈）
- 可视化/建模：bpmn-js（前端）+ Flowable Modeler / Camunda Modeler（建模）
- 持久化：PostgreSQL（Flowable 自带 schema）

## 流程定义（候选示例）
见 `services/flowable/process.bpmn20.xml`：工序流转示例（结构设计 → 模具开发 → 试模验证 → 量产放行，含排他网关）。

## 接口映射（对齐现有 /api/v1/plm2 语义）
| 现有 demo 接口 | Flowable 等价 |
|---|---|
| `GET /process-routes` | `GET /flowable/process-definitions` |
| `POST /process-routes/{id}/complete-step` | `POST /flowable/task/{taskId}/complete` |
| 待办 `plm_work_item` | Flowable `ACT_RU_TASK` / 用户任务 |
| `PROCESS_STEP_PUSHED` 事件 | Flowable 任务事件监听器 + Outbox |

## 红线（沿用 AEOS）
- 高风险动作（技转/量产放行/权限变更）经 M01 Guard + 人审，Flowable 不得自动放行。
- 工序完成事件经 Outbox 至少一次投递，消费端幂等（沿用 plm_domain_event）。
- 引擎令牌/审批人不得由前端指定，服务端按 M01 身份再鉴权。

## 状态
- 引擎未部署，仅 bpmn-js 可视化 + 内存状态机演示；正式接入需 Owner 签批与 M12 门禁。
