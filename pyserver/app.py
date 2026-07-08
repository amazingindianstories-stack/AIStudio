"""
Local identity-locked image generation service (SDXL + InstantID) on Apple MPS.

POST /generate  { prompt, image (data URL or base64), aspect_ratio, negative_prompt?,
                  identitynet_scale?, adapter_scale?, steps?, guidance? }
            ->  { image: "data:image/png;base64,..." }

Models load lazily on the first request (warm up with GET /warmup).
SDXL/InstantID weights are public on HF — no token required.
"""
import os
import sys
import io
import base64
import math
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import torch
import numpy as np
import cv2
from PIL import Image
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ── device / dtype ──────────────────────────────────────────────────────────
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
# fp16 on MPS is prone to black/NaN images; float32 is reliable and fine on 64GB.
DTYPE = torch.float32
# RealVisXL V4.0: public, de-watermarked, photoreal SDXL finetune — far better
# skin/face realism than base SDXL and no stock-photo watermark artifacts.
SDXL_MODEL = os.environ.get("SDXL_MODEL", "SG161222/RealVisXL_V4.0")

# allow CPU fallback for any op MPS doesn't implement
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

app = FastAPI(title="Lumina Local InstantID")

_state = {"pipe": None, "face": None, "error": None}
_lock = threading.Lock()


def _load():
    """Load InsightFace + SDXL + InstantID once."""
    if _state["pipe"] is not None or _state["error"]:
        return
    with _lock:
        if _state["pipe"] is not None or _state["error"]:
            return
        try:
            from insightface.app import FaceAnalysis
            from diffusers.models import ControlNetModel
            from huggingface_hub import hf_hub_download
            from pipeline_stable_diffusion_xl_instantid import (
                StableDiffusionXLInstantIDPipeline,
            )

            face = FaceAnalysis(
                name="antelopev2",
                root=HERE,
                providers=["CPUExecutionProvider"],
            )
            face.prepare(ctx_id=0, det_size=(640, 640))

            controlnet = ControlNetModel.from_pretrained(
                "InstantX/InstantID",
                subfolder="ControlNetModel",
                torch_dtype=DTYPE,
            )
            ip_ckpt = hf_hub_download("InstantX/InstantID", "ip-adapter.bin")

            pipe = StableDiffusionXLInstantIDPipeline.from_pretrained(
                SDXL_MODEL,
                controlnet=controlnet,
                torch_dtype=DTYPE,
            )
            pipe.to(DEVICE)
            pipe.load_ip_adapter_instantid(ip_ckpt)

            _state["face"] = face
            _state["pipe"] = pipe
            print(f"[InstantID] loaded on {DEVICE} ({DTYPE})", flush=True)
        except Exception as e:  # surface load errors to the client
            import traceback

            traceback.print_exc()
            _state["error"] = str(e)


def _decode_image(data: str) -> np.ndarray:
    """data URL or raw base64 -> BGR ndarray for cv2/insightface."""
    if "," in data and data.strip().startswith("data:"):
        data = data.split(",", 1)[1]
    raw = base64.b64decode(data)
    pil = Image.open(io.BytesIO(raw)).convert("RGB")
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


def _aspect_wh(aspect: str, area: int = 1024 * 1024) -> tuple[int, int]:
    try:
        w, h = (float(x) for x in aspect.split(":"))
        r = w / h
    except Exception:
        r = 1.0
    width = round(math.sqrt(area * r) / 64) * 64
    height = round(math.sqrt(area / r) / 64) * 64
    return max(width, 512), max(height, 512)


class GenReq(BaseModel):
    prompt: str
    image: str
    aspect_ratio: str = "1:1"
    negative_prompt: str = (
        "low quality, blurry, deformed face, extra fingers, bad anatomy, "
        "watermark, getty images, stock photo, signature, text, logo, "
        "username, frame, border, jpeg artifacts, cartoon, 3d render, plastic skin"
    )
    identitynet_scale: float = 0.8  # controlnet_conditioning_scale
    adapter_scale: float = 0.8  # ip_adapter face scale
    steps: int = 30
    guidance: float = 5.0


@app.get("/health")
def health():
    return {
        "device": DEVICE,
        "loaded": _state["pipe"] is not None,
        "error": _state["error"],
    }


@app.get("/warmup")
def warmup():
    _load()
    return health()


@app.post("/generate")
def generate(req: GenReq):
    _load()
    if _state["error"]:
        return JSONResponse({"error": _state["error"]}, status_code=500)

    from pipeline_stable_diffusion_xl_instantid import draw_kps

    face = _state["face"]
    pipe = _state["pipe"]

    width, height = _aspect_wh(req.aspect_ratio)
    bgr = _decode_image(req.image)
    bgr = cv2.resize(bgr, (width, height))

    faces = face.get(bgr)
    if not faces:
        return JSONResponse(
            {"error": "No face detected in the reference image."}, status_code=422
        )
    info = sorted(
        faces,
        key=lambda x: (x["bbox"][2] - x["bbox"][0]) * (x["bbox"][3] - x["bbox"][1]),
    )[-1]

    face_emb = info["embedding"]
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    kps_img = draw_kps(Image.fromarray(rgb), info["kps"])

    result = pipe(
        prompt=req.prompt,
        negative_prompt=req.negative_prompt,
        image_embeds=face_emb,
        image=kps_img,
        controlnet_conditioning_scale=float(req.identitynet_scale),
        ip_adapter_scale=float(req.adapter_scale),
        num_inference_steps=int(req.steps),
        guidance_scale=float(req.guidance),
        width=width,
        height=height,
    )
    out: Image.Image = result.images[0]

    buf = io.BytesIO()
    out.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return {"image": f"data:image/png;base64,{b64}"}
