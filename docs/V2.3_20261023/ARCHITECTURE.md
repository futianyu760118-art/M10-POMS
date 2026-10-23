# M10 POMS V2.3 架构与责任归属
M01：身份证明/岗位/权限/Guard/Goal/DEH；M02：Object/Event/Evidence/Audit/EDP；M03：结果和异常管理；M04～M09：专业业务规则、事实、Result；M10：装配/UI/采集/离线状态；M11：API/Hub/设备集成；M12：合同测试和发布门禁；Hub：Agent Runtime 与 AI 港湾。
## 模块
apps/mobile-web（PWA）；apps/bff（代理与服务端授权）；packages/ui（安全白名单 UI-schema）；packages/assembly（岗位功能装配）；packages/capture（输入/离线）；adapters/m01/m02/m05/m08/hub；configs/tenants（企业差异）；capability-packs/（行业产品差异）；tests/contract/e2e。
## 装配
输入 tenant_id/actor_id/positions/grants/object_ref/product_family/model_id/process_revision/device_capabilities/context_revision；读取 M01 Policy -> 能力包兼容匹配 -> 生成 UI Manifest -> 每次敏感 Action 服务端重新授权。UI 隐藏不能充当权限控制。
## 数据路径
采集 -> 专业源业务系统人机审核 -> M02 EDP 清洗/分类/质量校验 -> 管理系统授权复核 -> 归档/Result/Evidence；未经验证的数据标识 pending。只通过 API/Event/MCP 交互，禁止 M10 写专业表。
## 公专边界
公共为 UI、身份引用、任务、采集、证据关联；专业能力在 M04～M09；企业配置只放 tenant/权限/组织/流程/接口映射；产品包仅放参数、工艺、检验、专业 Skill、UI schema 和外设适配。
## Hub
Hub 控制台已有 AI 港湾 Agent 注册、业务小队、Runtime Session/Run/Event、Guard/Evidence；POMS Agent 面板通过 M11 授权 Adapter 打开/运行，不得把 Hub 服务端令牌放浏览器里。未连接显示模拟模式。
## 红线
done != verified；跨租户默认拒绝；产品切换 M01/M02/M10 公共代码无特殊变更；LLM 不直接下发 PLC 控制指令；所有正式接口待 Owner 确认。
