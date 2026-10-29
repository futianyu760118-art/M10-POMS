# -*- coding: utf-8 -*-
"""AEOS M10 录入 AI 服务（PaddleOCR/PP-Structure + FunASR/Paraformer + Qwen2.5-VL）

三个模型均惰性加载；未安装对应依赖时自动降级为 MOCK 结果（返回体含 "engine" 字段，
mock 时 engine 以 "mock-" 前缀，便于前端明确标注）。

启动（安装依赖后）：
    pip install -r requirements.txt
    uvicorn app:app --host 0.0.0.0 --port 8001

接口：
    POST /ocr      图片 -> 文字识别（PaddleOCR）
    POST /table    图片 -> 表格/版面结构（PP-Structure）
    POST /asr      音频 -> 中文转写（FunASR Paraformer）
    POST /vl       图片 + 提示 -> 多模态理解/字段抽取（Qwen2.5-VL）
    GET  /health   健康检查
"""
import io
import os
from typing import List, Optional

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="AEOS AI 录入服务", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------- 惰性模型加载 ----------------
_ocr = None          # (PaddleOCR, PPStructure) 或 ("mock","mock")
_asr = None          # funasr model 或 "mock"
_vl = None           # (model, processor) 或 "mock"


def _load_ocr():
    global _ocr
    if _ocr is not None:
        return _ocr
    try:
        from paddleocr import PaddleOCR, PPStructure
        _ocr = (
            PaddleOCR(use_angle_cls=True, lang="ch", show_log=False),
            PPStructure(show_log=False),
        )
    except Exception as e:  # noqa
        print("[ocr] PaddleOCR 未安装，使用 MOCK：", repr(e))
        _ocr = ("mock", "mock")
    return _ocr


def _load_asr():
    global _asr
    if _asr is not None:
        return _asr
    try:
        from funasr import AutoModel
        # paraformer-zh 中文通用识别，首次运行会自动下载模型
        _asr = AutoModel(model="paraformer-zh", vad_model="fsmn-vad", punc_model="ct-punc")
    except Exception as e:  # noqa
        print("[asr] FunASR 未安装，使用 MOCK：", repr(e))
        _asr = "mock"
    return _asr


def _load_vl():
    global _vl
    if _vl is not None:
        return _vl
    try:
        import torch
        from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor
        from qwen_vl_utils import process_vision_info
        model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            "Qwen/Qwen2.5-VL-3B-Instruct", torch_dtype="auto", device_map="auto"
        )
        processor = AutoProcessor.from_pretrained("Qwen/Qwen2.5-VL-3B-Instruct")
        _vl = (model, processor, process_vision_info)
    except Exception as e:  # noqa
        print("[vl] Qwen2.5-VL 未安装，使用 MOCK：", repr(e))
        _vl = "mock"
    return _vl


# ---------------- 接口 ----------------
@app.get("/health")
def health():
    ocr = _load_ocr()
    asr = _load_asr()
    vl = _load_vl()
    dxf = _load_dxf()
    return {
        "status": "ok",
        "engines": {
            "ocr": "mock" if ocr[0] == "mock" else "PaddleOCR",
            "table": "mock" if ocr[1] == "mock" else "PP-Structure",
            "asr": "mock" if asr == "mock" else "FunASR/Paraformer",
            "vl": "mock" if vl == "mock" else "Qwen2.5-VL",
            "dxf": "mock" if dxf == "mock" else "ezdxf",
        },
    }


@app.post("/ocr")
async def ocr(file: UploadFile = File(...)):
    data = await file.read()
    ocr_engine, _ = _load_ocr()
    if ocr_engine == "mock":
        return {"engine": "mock-paddleocr", "filename": file.filename,
                "lines": [{"text": "（模拟 OCR）恒剑光电 工矿灯 200W", "conf": 0.99},
                          {"text": "额定功率：200W  色温：4000K", "conf": 0.98}]}
    from PIL import Image
    img = Image.open(io.BytesIO(data)).convert("RGB")
    import numpy as np
    result = ocr_engine.ocr(np.array(img), cls=True)
    lines = []
    for block in (result or []):
        for line in block:
            box, (text, conf) = line[0], line[1]
            lines.append({"text": text, "conf": round(float(conf), 4), "box": box})
    return {"engine": "paddleocr", "filename": file.filename, "lines": lines}


@app.post("/table")
async def table(file: UploadFile = File(...)):
    data = await file.read()
    _, structure = _load_ocr()
    if structure == "mock":
        return {"engine": "mock-ppstructure", "filename": file.filename,
                "elements": [{"type": "table", "html": "<table><tr><td>项目</td><td>数值</td></tr><tr><td>功率</td><td>200W</td></tr></table>"},
                             {"type": "text", "text": "（模拟版面）检验记录表"}]}
    from PIL import Image
    img = Image.open(io.BytesIO(data)).convert("RGB")
    import numpy as np
    result = structure(np.array(img))
    elements = []
    for r in result:
        kind = r.get("type")
        if kind == "table":
            elements.append({"type": "table", "html": r.get("res", {}).get("html", "")})
        else:
            elements.append({"type": kind, "text": str(r.get("res", ""))})
    return {"engine": "ppstructure", "filename": file.filename, "elements": elements}


@app.post("/asr")
async def asr(file: UploadFile = File(...)):
    data = await file.read()
    engine = _load_asr()
    if engine == "mock":
        return {"engine": "mock-funasr", "filename": file.filename,
                "text": "（模拟语音转写）该批次外观合格，关键尺寸 12.5 毫米，功能正常。"}
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(data)
        tmp = f.name
    try:
        res = engine.generate(input=tmp)
        text = res[0]["text"] if res else ""
        return {"engine": "funasr", "filename": file.filename, "text": text}
    finally:
        os.remove(tmp)


@app.post("/vl")
async def vl(file: UploadFile = File(...), prompt: str = Form("请识别图片中的文字和关键参数")):
    data = await file.read()
    v = _load_vl()
    if v == "mock":
        return {"engine": "mock-qwen25vl", "filename": file.filename, "prompt": prompt,
                "answer": "（模拟视觉理解）识别到产品：工矿灯；额定功率 200W；色温 4000K；防护等级 IP65。"}
    model, processor, process_vision_info = v
    import base64, torch
    b64 = base64.b64encode(data).decode()
    messages = [{
        "role": "user",
        "content": [
            {"type": "image", "image": f"data:image;base64,{b64}"},
            {"type": "text", "text": prompt},
        ],
    }]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    image_inputs, video_inputs = process_vision_info(messages)
    inputs = processor(text=[text], images=image_inputs, videos=video_inputs, padding=True, return_tensors="pt")
    inputs = inputs.to(model.device)
    generated = model.generate(**inputs, max_new_tokens=512)
    out = processor.batch_decode(generated, skip_special_tokens=True)[0]
    # 去掉输入前缀，仅保留回答
    answer = out.split("assistant")[-1].strip() if "assistant" in out else out
    return {"engine": "qwen25vl", "filename": file.filename, "prompt": prompt, "answer": answer}


_dxf = None


def _load_dxf():
    global _dxf
    if _dxf is not None:
        return _dxf
    try:
        import ezdxf  # noqa
        _dxf = "ezdxf"
    except Exception as e:  # noqa
        print("[dxf] ezdxf 未安装，使用 MOCK：", repr(e))
        _dxf = "mock"
    return _dxf


@app.post("/dxf")
async def dxf(file: UploadFile = File(...)):
    """DXF 图纸解析：返回图层与实体统计，供图纸归类/出图。"""
    data = await file.read()
    engine = _load_dxf()
    if engine == "mock":
        return {"engine": "mock-ezdxf", "filename": file.filename,
                "layers": ["0", "标注", "轮廓", "中心线"],
                "entities": {"LINE": 42, "CIRCLE": 6, "ARC": 3, "TEXT": 12, "DIMENSION": 8}}
    import ezdxf, tempfile, os
    # 用临时文件 + readfile 以正确自动识别 DXF 编码（中文标注为 GBK/ANSI）
    with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as f:
        f.write(data)
        tmp = f.name
    try:
        doc = ezdxf.readfile(tmp)
    finally:
        os.remove(tmp)
    msp = doc.modelspace()
    ents = {}
    for e in msp:
        t = e.dxftype()
        ents[t] = ents.get(t, 0) + 1
    layers = [l.dxf.name for l in doc.layers]
    return {"engine": "ezdxf", "filename": file.filename, "layers": layers, "entities": ents}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)
