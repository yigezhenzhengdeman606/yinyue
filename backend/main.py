import asyncio
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.ai import AIError, create_art

load_dotenv()

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
TTL = 7200
MAX_SESSIONS = 100

app = FastAPI(title="Luma Player", docs_url="/api/docs")


@dataclass
class Session:
    key: str
    text_model: str
    image_model: str
    expires: float
    busy: bool = False


sessions: dict[str, Session] = {}


def prune_sessions():
    now = time.monotonic()
    for token in list(sessions):
        if sessions[token].expires <= now:
            del sessions[token]


@app.middleware("http")
async def protect_requests(request: Request, call_next):
    # 此版本面向本地运行，阻止其他网站跨站配置密钥或触发 AI 费用。
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        expected = f"{request.url.scheme}://{request.url.netloc}"
        if origin and origin != expected:
            return JSONResponse(
                {"detail": "拒绝跨站请求。"}, status_code=403
            )
        if request.headers.get("x-luma-client") != "1":
            return JSONResponse(
                {"detail": "缺少客户端校验头。"}, status_code=403
            )

    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


class SettingsInput(BaseModel):
    api_key: str = Field(default="", max_length=1000)
    text_model: str = Field(default="", max_length=100)
    image_model: str = Field(default="", max_length=100)


class ArtInput(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    context: str = Field(min_length=1, max_length=6000)


class CompositionInput(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    lyrics: str = Field(min_length=1, max_length=10000)


def get_session(request: Request) -> Session:
    prune_sessions()
    token = request.cookies.get("luma_session", "")
    session = sessions.get(token)
    if not session:
        raise HTTPException(401, "请先在设置中配置 AI。")
    return session


@app.post("/api/settings")
async def configure(data: SettingsInput, request: Request, response: Response):
    key = data.api_key.strip() or os.getenv("OPENAI_API_KEY", "").strip()
    text_model = data.text_model.strip() or os.getenv("AI_TEXT_MODEL", "").strip()
    image_model = (
            data.image_model.strip() or os.getenv("AI_IMAGE_MODEL", "").strip()
    )

    if not key or not text_model or not image_model:
        raise HTTPException(400, "请填写密钥、文本模型和图片模型。")

    prune_sessions()
    previous = request.cookies.get("luma_session", "")
    sessions.pop(previous, None)

    if len(sessions) >= MAX_SESSIONS:
        raise HTTPException(503, "临时会话已满，请稍后重试。")

    token = secrets.token_urlsafe(32)
    sessions[token] = Session(
        key, text_model, image_model, time.monotonic() + TTL
    )
    response.set_cookie(
        "luma_session",
        token,
        httponly=True,
        samesite="strict",
        secure=request.url.scheme == "https",
        max_age=TTL,
        path="/",
    )
    return {"message": "配置已保存到后端临时内存，有效期两小时。"}


@app.delete("/api/settings")
async def clear_settings(request: Request, response: Response):
    sessions.pop(request.cookies.get("luma_session", ""), None)
    response.delete_cookie("luma_session", path="/")
    return {"message": "临时密钥已清除。"}


@app.post("/api/art")
async def art(data: ArtInput, request: Request):
    if not data.title.strip() or not data.context.strip():
        raise HTTPException(400, "歌曲名称和歌词或描述不能为空。")

    session = get_session(request)
    if session.busy:
        raise HTTPException(429, "已有 AI 请求正在进行。")

    session.busy = True
    try:
        return await create_art(
            session.key,
            session.text_model,
            session.image_model,
            data.title.strip(),
            data.context.strip(),
        )
    except AIError as error:
        raise HTTPException(502, str(error))
    finally:
        session.busy = False


@app.get("/api/auth/{provider}")
async def auth(provider: Literal["qq", "netease", "spotify"]):
    raise HTTPException(
        501,
        f"{provider} 官方登录与歌单授权尚未配置，请使用游客模式。"
    )


@app.post("/api/compose")
async def compose(data: CompositionInput):
    if not data.title.strip() or not data.lyrics.strip():
        raise HTTPException(400, "标题和歌词不能为空。")
    # 后续在这里连接作曲服务及数据库。
    # 当前不会保存或上传用户歌词。
    raise HTTPException(
        501, "AI 作曲接口已预留，当前尚未接入，不会上传或保存歌词。"
    )


@app.get("/api/health")
async def health():
    return {"status": "ok"}


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


@app.get("/")
async def index():
    return FileResponse(FRONTEND / "index.html")