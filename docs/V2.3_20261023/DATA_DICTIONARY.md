# 数据与事件字典 V2.3
- Identity 引用：tenant_id、actor_id、position_ids[]、policy_revision（Owner M01）。
- 装配：manifest_id、capability_ids[]、ui_schema_version、context_revision、expires_at（Owner M10）。
- 业务引用：object_ref(object_type/object_id)、product_ref(family/model/process_revision)、action_id（专业中心+M01）。
- 采集：capture_id、capture_type(scan/image/voice/text/sensor)、device_id、captured_at、raw_evidence_ref、sync_state、schema_version、correlation_id、trace_id、idempotency_key（M10 发起，专业中心入账）。
- Result：result_id、action_id、expected_result、actual_result、status(submitted/verified/rejected/superseded)、verified_by/at、evidence_refs（遵循 DEH）。
- Evidence：evidence_id、source_system、source_record_id、checksum、version、confidence、provenance、uri（Owner M02）。
- Agent：agent_id、hub_agent_id、skills、autonomy_level、tool_scope、guard_policy、run_id、status（Hub 为 Runtime 真相源，POMS 只引用）。
事件遵从 AEOS Object/API/Event/Action/Result/Evidence 契约；创建和提交必须幂等。业务 owner 不因 POMS 界面存在而改变。
