# AEOS M10 POMS V2.3 开发交付资料（DRAFT）
日期：2026-10-23；上位：AEOS V7.2 / POMS V2.2；保留既有 docs/V1.0_20261023 文档和 M07 联调体系。
## 定位
M10 是岗位动态组装与移动执行入口，不能成为第二套 ERP、身份中心、Agent Runtime、业务主数据库或 Evidence 主档。首期以品质检验实际业务闭环为准，销售从公开获客到售后为下一阶段领域适配。
## 文档
- PRD.md：岗位/移动/销售8阶段/Hub能力
- ARCHITECTURE.md：各系统职责、公专分离、数据/安全边界
- API_OPENAPI.yaml：M10 BFF 的接口候选骨架，真实路径需 Owner 确认
- DATA_DICTIONARY.md：数据/状态语义
- BACKLOG.md：14项开发任务与依赖
- ACCEPTANCE.md：G0-G6 及关键测试
- HANDOVER.md：启动、前置原件和实施安排
- capability-packs：灯具与定时器样板及销售 Agent 模板
## 原始资料包
原档《AEOS_POMS_V2.3_开发交付资料包.zip》另行归档。仓库此目录提供经整理的 Git 可评审开发资料；此前 V0.1 原型尚未推送为本版本生产代码。
## 来源与治理
POMS V2.2 原件 https://github.com/futianyu760118-art/AEOS-/blob/main/docs/P0/AEOS_POMS_V2.2_总体设计与MVP实施方案.md ，原始提交 690a0f97297e1ac2c03e3e58c399996d9c609807（2026-10-10）。
Hub 仓库 futianyu760118-art/AEOS-hub；CRM 仓库 futianyu760118-art/CRM；HLC/M07 原资料保留。
未经业务 Owner 和 Architecture Board 签批，状态一律 PROPOSED，不得声称 G0/G2/G3 已通过。
