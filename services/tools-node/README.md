# AEOS 工序工具服务（pdf-lib + sharp 水印）

## 启动

```bash
cd services/tools-node
npm install          # 安装 pdf-lib + sharp（不装则服务自动降级 mock）
npm start            # 端口 8003
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 引擎状态（pdf-lib/sharp 或 mock） |
| POST | `/watermark/pdf` | 上传 PDF + Header `x-watermark-text`，返回加水印 PDF |
| POST | `/watermark/image` | 上传图片 + Header `x-watermark-text`，返回加水印 PNG |

## 说明

- 未安装 `pdf-lib`/`sharp` 时自动降级为 MOCK（engine 前缀 `mock-`）。
- 用于外协发图/测试报告/出货文件的防泄密水印，配合 PLM2 `plm_file`（has_watermark/visibility）。
