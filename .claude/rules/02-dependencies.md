---
description: 第三方依赖管控。当被要求引入新包、替换现有库、升级依赖版本，或代码中出现未在白名单内的 import 时使用。
globs:
  - "**/package.json"
  - "**/pyproject.toml"
  - "**/requirements*.txt"
  - "**/go.mod"
  - "**/pom.xml"
  - "**/build.gradle*"
---

# 依赖管控

0-1 阶段，每引入一个包都是一次不可逆的架构决策。AI 特别容易为了省事引入一个大而全的库。

## 白名单（团队维护，逐条评审通过）

```
# 根项目：零依赖（BFF 纯 Node http，不得新增）
# services/tools-node（npm，已装）：
- pdf-lib            # PDF 生成/合并/水印
- @pdf-lib/fontkit   # PDF 嵌入中文字体（水印中文必需）
- sharp              # 图片水印/处理
# services/ai-entry（Python，未装时服务自动降级 mock，见 requirements.txt）：
- fastapi / uvicorn / python-multipart   # 服务框架
- paddleocr / paddlex                    # OCR + PP-Structure（用户选定）
- funasr / modelscope                    # 中文语音（用户选定）
- torch / transformers / qwen-vl-utils / accelerate  # Qwen2.5-VL（用户选定）
- ezdxf                                   # DXF 图纸解析（已装 1.3.0）
```

## 引入新包前必须回答

1. **这个包解决什么问题？** 说不清楚就不要引。
2. **用标准库/现有依赖能否在 50 行内解决？** 能就自己写。
3. **它有多少传递依赖？** 装之前先看依赖树规模。
4. **最近一次发布是什么时候？** 超过 18 个月未更新的，需要额外说明。
5. **许可证是什么？** GPL/AGPL 类需法务确认。

## 明确禁止

- 引入白名单外的包**而不说明**
- 一个功能只用了某个大库的 1%，就把它整包拖进来
- 同时引入两个职责重叠的库（如同时有 lodash 和 ramda）
- 混用包管理器产生多份 lockfile
- 使用 `@latest` 或不锁版本的写法

## 执行流程

1. 先说明要引什么、为什么、体积多大
2. **等待人工批准**（`settings.json` 已把安装类命令设为 `ask`）
3. 批准后安装，并把包名+理由追加到本文件白名单
4. 提交时把 package.json 与 lockfile 一起提交

> 这条规则的价值在于：三个月后你看到 `package.json` 里每个包，都能说出当初为什么加它。
