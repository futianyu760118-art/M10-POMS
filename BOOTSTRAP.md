# BOOTSTRAP：把这套团队配置装进当前项目

> **给 AI 的指令文件。人类用法：**
> 1. 把本包里的 `.claude/`、`CLAUDE.md`、`CLAUDE.local.md.template`、`.gitignore.append` 复制到项目根目录
> 2. 把本文件也放进项目根目录
> 3. 在 Claude Code 里说：**「读 BOOTSTRAP.md，然后执行。」**
>
> 你（AI）接下来的任务是：扫描这个真实项目，把配置里所有占位符 `<<...>>` 替换成实际内容，让它立刻可用。

---

## 你的执行规则

- **先扫描，再动笔。** 所有结论必须来自项目里的真实文件，禁止凭空推测或套用通用模板。
- **证据优先。** 技术栈看 manifest 文件，命令看 `scripts` 字段，目录看实际结构——不要猜。
- **推断不出来就问。** 只有一处允许你主动停下提问（见 STEP 4），其余一律按证据推断并在汇报中标注。
- **不要扩大范围。** 只改配置文件，不改任何业务代码。
- **不要编造。** 项目里没有的东西就写"未发现"，不要写"通常是 X"。

---

## STEP 1 · 扫描项目事实

按顺序读取，把结果记在心里（不要写代码文件）：

**1.1 技术栈** —— 找到哪个读哪个：
- `package.json`（看 `dependencies` / `devDependencies` / `engines` / `packageManager`）
- `pyproject.toml` / `requirements.txt`（Python）
- `go.mod`（Go）
- `Cargo.toml`（Rust）
- `pom.xml` / `build.gradle`（Java）

**1.2 命令** —— 优先读 manifest 的 `scripts` 字段；没有的话看：
- `Makefile` / `justfile` / `Taskfile.yml`
- CI 配置：`.github/workflows/*.yml`、`.gitlab-ci.yml`
- 没有就根据技术栈写标准命令，并在汇报里标注「命令为推断值，待验证」

**1.3 目录结构** —— `ls` 一层主目录，看真实组织方式。只写实际存在的目录，每个加一句话职责。

**1.4 项目是做什么的** —— 顺序尝试：
- `README.md` 开头几段
- `docs/`、`DESIGN.md`、`docs/PRD.md`
- `git log --oneline -30` 看最近在做什么
- 最近几个 commit 的改动文件

**1.5 已有约定** —— 检查是否已存在：
- `CLAUDE.md` / `.cursorrules` / `AGENTS.md` / `docs/` 下的规范文档
- **如果已存在 `CLAUDE.md`，先把它的内容读出来，在 STEP 3 合并进新版，不要丢弃任何一条已有规则。**
- `.gitignore` 看现有忽略模式

**1.6 团队痕迹** —— `git log --format='%an' | sort | uniq -c | sort -rn` 看有几个人在提交。

---

## STEP 2 · 处理 gitignore

把 `.gitignore.append` 的内容追加到项目 `.gitignore`，然后**删掉 `.gitignore.append`**。

如果 `.gitignore` 不存在，直接把 `.gitignore.append` 重命名为 `.gitignore`。

---

## STEP 3 · 填写 CLAUDE.md

把 `CLAUDE.md` 里每一处 `<<...>>` 替换为 STEP 1 得到的真实信息：

| 位置 | 填什么 | 来源 |
|---|---|---|
| 第 1 行 | 项目名 | manifest 的 `name` 或目录名 |
| 第 8 行 | 产品一句话描述 | STEP 1.4（STEP 4 会确认） |
| 第 12-16 行 | 技术栈五行 | STEP 1.1，**写实际版本号** |
| 第 21-28 行 | 目录结构 | STEP 1.3，**只写真实存在的** |
| 第 32-36 行 | 命令表 | STEP 1.2 |
| 第 66 行 | 提交规范 | 若 `.git` 有历史，看 `git log` 的实际风格；否则保留默认 conventional commits |

**如果 STEP 1.5 发现了已有的 CLAUDE.md**：先读它，把里面的每条规则合并进新文件的对应章节。**已有规则优先保留**——那是团队踩过坑沉淀下来的，比模板值钱。合并后把旧的删掉。

---

## STEP 4 · 唯一允许你停下提问的地方

完成 STEP 3 后，把「产品一句话描述」和「技术栈」这两项展示给用户，问：

> 我根据项目文件推断出这些，请确认或纠正（纠正后我再继续）：
> - 项目定位：<<你写的那句话>>
> - 技术栈：<<你写的五行>>
>
> 另外补充两点会更好用（可选，不知道就说"跳过"，我用默认值）：
> - 团队有几个人？
> - 现在最让你头疼的 AI 编码问题是什么？（我会把它写成一条规则）

**等用户回复后再继续。** 这是全流程唯一一次提问，不要在其他地方停下。

---

## STEP 5 · 清理 .claude/settings.json

**必须做，否则规则静默失效：**

1. 找到 `"Bash(<<数据库迁移命令>>)"` 这一行：
   - 如果项目确实用了迁移工具（Prisma / Alembic / Flyway / golang-migrate 等），替换成真实命令，如 `"Bash(pnpm prisma migrate *)"`
   - **如果没有迁移工具，直接删除这一行**（连同行尾多余的逗号，保证 JSON 合法）

2. 按 STEP 1.1 的实际包管理器调整命令前缀：
   - 用 npm → 删掉所有 `pnpm *` 行，保留 `npm *` 行
   - 用 pnpm → 删掉 `npm install *` 行
   - 用 yarn → 相应替换
   - **不要同时留有冲突的多套包管理器规则**

3. 如果 STEP 4 里用户说了最头疼的问题，且它属于"可通过命令规则缓解"的，补一条对应的 `ask` 或 `deny`。

4. **改完必须校验 JSON 合法**：`python3 -c "import json;json.load(open('.claude/settings.json'))"`
   不通过就修到通过为止。

---

## STEP 6 · 填写其余文件

- `.claude/rules/02-dependencies.md` 第 19 行：**从 manifest 的 dependencies 里挑出真正的第三方运行时依赖**（排除 devDependencies、排除类型包 `@types/*`），列成白名单，每项加一句用途。
- `.claude/rules/04-module-boundaries.md` 第 37 行：根据 STEP 1.3 的真实目录改写依赖方向示例。
- `.claude/hooks.示例.json`：**暂不启用**。保持原样，在 STEP 7 汇报里说明它是可选项及启用条件。
- `.claude/commands/*.md` 和 `spec-kit/02-constitution模板.md` 里的 `<<...>>` 是**输出模板**，AI 运行时自己填，**你不要改**。

---

## STEP 7 · 自检与汇报

**自检（逐条确认）：**
```bash
grep -rn "<<" CLAUDE.md .claude/    # 应无输出（commands/ 目录下的除外）
python3 -c "import json;json.load(open('.claude/settings.json'))" && echo "JSON OK"
ls -a | grep claude                   # 确认 .claude 存在且非空
```

**然后按下面格式汇报，不要说"配置完成"这种空话：**

```
## 已写入
- CLAUDE.md：<项目名>，<技术栈一句话>
- .claude/settings.json：deny <N> 条 / ask <N> 条 / allow <N> 条
- .claude/rules/：4 条，其中 02 的白名单来自实际 dependencies 共 <N> 项

## 我推断的（请复核）
- 命令表来自 <<package.json scripts / 推断>>：<列出命令>
- 目录结构：<列出>

## 我无法推断的 / 用了默认值
- <<...>>

## 下一步建议
- 先跑一个真实任务验证 AI 是否守规矩，再考虑接 spec-kit（见 spec-kit/01-初始化与流程.md）
- 接 spec-kit 前别急着写 constitution，等跑通几个 feature 再回头总结原则
```

---

## 最后一句提醒（写给你自己看的）

这套配置的 90% 价值来自**未来的迭代**，不是这一次安装。你装满 placeholders 的那一刻它只值 10 分；团队每踩一次坑往里补一条规则，它才真正值钱。

所以：**不要为了"配置看起来完整"去编造规则**。项目里没发生过的问题，就不要写成规则。
