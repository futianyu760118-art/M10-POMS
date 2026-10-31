# AEOS AI 录入服务（PaddleOCR + FunASR + Qwen2.5-VL）

为「采集录入」提供 OCR / 表格识别 / 语音转写 / 视觉理解能力。

## 启动

```bash
cd services/ai-entry
pip install -r requirements.txt        # 依赖较重，可先只装 fastapi/uvicorn 跑 MOCK
uvicorn app:app --host 0.0.0.0 --port 8002
```

- 服务地址：`http://localhost:8002`（局域网 `http://<本机IP>:8002`）
- 健康检查：`GET /health` 返回各引擎是「真实模型」还是「mock」。
- **未安装模型依赖时自动降级为 MOCK**，前端会标注「模拟识别」。

## 接口

| 方法 | 路径 | 输入 | 输出 |
|---|---|---|---|
| POST | `/ocr` | 图片 | 文字行 + 置信度（PaddleOCR） |
| POST | `/table` | 图片 | 表格 HTML / 版面元素（PP-Structure） |
| POST | `/asr` | 音频(wav/mp3) | 中文转写文本（FunASR Paraformer） |
| POST | `/vl` | 图片 + prompt | 多模态理解/字段抽取（Qwen2.5-VL） |
| GET | `/health` | — | 引擎状态 |

## 模型说明

- **PaddleOCR + PP-Structure**：中文 OCR 与表格/版面识别，`paddlepaddle`+`paddleocr`。
- **FunASR/Paraformer**：中文语音识别，`funasr`，模型 `paraformer-zh`（首次运行自动下载）。
- **Qwen2.5-VL**：多模态视觉理解，`transformers`，模型 `Qwen/Qwen2.5-VL-3B-Instruct`（约 6GB，首次下载）。

## 与前端对接

前端「采集录入 → AI 智能录入」按 `location.hostname:8002` 调用本服务；服务未启动或引擎为 mock 时明确提示「模拟识别」，不提供虚假成功。

