---
description: 模块边界与依赖方向。当被要求新增模块、跨模块调用、或在既有目录放新文件时使用。
globs:
  - "apps/**"
  - "adapters/**"
  - "packages/**"
  - "demo/**"
  - "services/**"
---

# 模块边界

0-1 阶段定边界的价值不在"整洁"，而在**三个月后还能改得动**。边界一旦糊掉，任何改动都会牵一发动全身。

## 允许的依赖方向（只能从左到右，不能反向）

```
demo/*.html  →  apps/bff(/api/v1/*)  →  adapters/*  →  configs/*.json
apps/bff     →  packages/{assembly,ui,capture}
adapters/plm2 | m07  →  adapters/m01        # 唯一允许的 adapter 间引用（身份/权限）
services/*   # 独立进程，仅经 HTTP 被前端按端口调用（8002 AI / 8003 水印）
```

- `demo` **不许** import `adapters`、直连数据库或绕过 BFF 实现业务状态机
- `adapters` 之间**不许**互相 import（除 → m01），**不许**写对方域的专业事实
- `configs/plm2.json` 的业务数据**只能**由 `scripts/import-from-plm.js` 生成，不许手编
- adapters 对真实库**只读**（SELECT），写入专业库一律禁止

## 新增文件前先回答

1. **它属于哪一层？** 说不出来说明分层定义有问题，先讨论。
2. **它会不会让两层互相依赖？** 会就重新设计。
3. **有没有已存在的同类文件？** 有就改那个，不要新建 `xxxV2.ts`、`newXxx.ts`。

## 明确禁止

- 创建 `utils/`、`helpers/`、`common/`、`shared/` 这类无边界的垃圾桶目录
- 用 `xxxNew`、`xxxV2`、`xxxTemp` 命名文件——要么重构旧的，要么说明为什么必须并存
- 在一个模块里直接读另一个模块的数据库表
- 为绕过边界而复制一份数据结构定义

## 小团队特别约定

- 团队 2-5 人：BFF/adapters 改动需至少一人 review；demo 页改动必须过 `node --check`
- 新系统接入 = 复制 `scripts/import-from-plm.js` 模式 + 新建 `adapters/<系统>` + BFF 路由，不新造顶层目录
- 新增对外接口先在 README 命令表登记，再写实现

> 边界不是靠自觉维持的。把方向写在这里，AI 每次新增文件都会对照检查。
