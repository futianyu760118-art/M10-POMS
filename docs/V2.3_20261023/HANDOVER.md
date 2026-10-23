# 开发启动、交接和阻塞项
建议 Node.js 20+，移动端 PWA，Node BFF，先使用 mock adapter 做 L0 验证，再替换为正式 OpenAPI。当前 POMS V0.1 框架/Hub 销售 Agent HTML 是历史演示参考，不应假定真实接口已接通。
## 需要责任方提供的资料
M00：AEOS 正式总纲、签批日期与受控版本；M01：Identity/Policy/DEH OpenAPI、岗位权限字典；M02：Evidence/Event/审核字典；M08：灯具首件检验 SOP/表单/接口；M05：CRM 客户至售后字段接口；M06/M09：出货及应收事实接口；Hub Owner/M11：AI 港湾 Agent 列表及 Session/Run/Event/Guard API；贞观业务 Owner：定时器工艺/检验标准、授权；IT：现场终端、证书、网络及安全策略。
## 建议目录
apps/mobile-web/; apps/bff/; packages/ui/; packages/assembly/; packages/capture/; adapters/m01/m02/m05/m08/hub/; configs/tenants/; capability-packs/; tests/contract/e2e/; docs/。
## 开发准入
可并行进行 UI/mock、能力装配技术验证；真实业务写入与生产联调必须获得签批和接口 Owner 确认。最终必须记录部署位置、CI 结果、UAT 证据、版本、回滚路径。
