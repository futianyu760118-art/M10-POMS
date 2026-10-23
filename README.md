# M10 POMS · 岗位与个人运营微系统

> AEOS V7.2.2 对齐文档仓 · 当前资料为**开发执行候选**，需 M00/M01/M02/M10/M13 Owner 和 Gate 签批后冻结。当前尚非可运行生产系统。

M10 提供岗位与个人上下文、未来待办、当前异常、过去结果、个人智能体与移动端极简执行工作面。它不拥有人员身份/岗位权限权威，不拥有 M07 人力后勤、M04 研发、M05 销售等专业对象，也不直接写入专业数据库。

## 开发入口

- [开发文档索引](docs/V1.0_20261023/README.md)
- [M10 产品要求 / PRD](docs/V1.0_20261023/01_M10_PRD_职责与范围.md)
- [架构与系统接口](docs/V1.0_20261023/02_M10_架构与接口设计.md)
- [岗位模板/个人工作面](docs/V1.0_20261023/03_M10_岗位装配与UI规范.md)
- [首条 M07 联调方案](docs/V1.0_20261023/04_M07_联调与事件闭环.md)
- [开发计划和验收](docs/V1.0_20261023/05_开发任务与Gate验收.md)

## 上位依赖
- M01 Kernel：canonical person/org/position + Policy/Guard
- M02 EDP：Event/Result/Evidence/Trace
- M07 HLC：HR/行政专业请求/审批/验收
- M13 Hub：Agent Workforce、Skills 与工具治理
- HLC 源资料： https://github.com/futianyu760118-art/HLC/tree/master/docs/aeos/m07-m10/V1.0_20261016

## 状态
- 仓库初始化并提交 M10 文档和演示源文件；**未声称接口已接通或系统已运行**。
- POMS V2.2 原件、P0-03 Data Ownership、P0-04 Object ID、P0-05 Contract Pack 仍待正式核准。
