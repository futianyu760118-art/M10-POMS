# POMS V2.3 验收标准
G0：基线、边界、Owner、接口批准；G1：无新跨域直连；G2：身份/Schema/幂等/权限/租户集成测试；G3：真实业务 Fact->Event->Action->Result->Verify->Evidence；G4：EBMS 结果可查；G5：Agent Skill/Guard/回滚/人工审；G6：T0/Value/多租户/跨企业复制。
## 关键测试
AT01 新岗位配置无需写专用页面代码；AT02 兼岗合并且越权拒绝；AT03 一企业多产品包并行；AT04 恒剑灯具->贞观定时器仅更换配置/产品包；AT05 done 不等于 verified；AT06 原始采集可追溯至审核归档与证据；AT07 相同 Idempotency-Key 不重复写记录；AT08 Agent 不得绕过 Guard；AT09 兼容失败阻断和独立回滚；AT10 手机现场高频任务操作/网络压测；AT11 Hub Agent 打开未连接时明确显示模拟状态；AT12 公开线索来源可核验并符合隐私要求；AT13 CRM 订单出货回款售后专业事实归属正确；AT14 多租户与撤权负测试。
所有 G2/G3/G5/G6 声称通过必须附 CI/UAT/日志/证据和 Owner 确认，不得把示例数据当实际业务闭环。
