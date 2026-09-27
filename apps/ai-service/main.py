# apps/ai-service/main.py
"""
Ijarauz AI Service — FastAPI приложение для работы с Ollama LLM.
Предоставляет REST API для AI-чата с кешированием через Redis.
"""

import json
import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Optional

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings


# ─── Конфигурация ─────────────────────────────────────────────────────────────

class Settings(BaseSettings):
    ollama_base_url: str = "http://localhost:11434"
    redis_url: str = "redis://localhost:6379"
    ollama_model: str = "llama3"
    log_level: str = "INFO"
    port: int = 8000

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("ai-service")

SYSTEM_PROMPT = """Ты — умный AI-помощник платформы аренды недвижимости Ijarauz.uz.
Помогаешь пользователям найти жильё, разобраться в условиях аренды и договорах.
Отвечай кратко, дружелюбно, на языке вопроса (русский, узбекский, английский)."""


# ─── Pydantic модели ─────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str  # "user" | "assistant" | "system"
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    model: str = Field(default="llama3")
    stream: bool = Field(default=False)
    session_id: Optional[str] = None
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)


class ChatResponse(BaseModel):
    content: str
    model: str
    session_id: Optional[str] = None


class HealthResponse(BaseModel):
    status: str
    ollama: str
    redis: str


# ─── Lifespan ─────────────────────────────────────────────────────────────────

redis_client: aioredis.Redis = None
http_client: httpx.AsyncClient = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global redis_client, http_client
    logger.info("Starting AI service...")

    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    http_client = httpx.AsyncClient(timeout=120.0)

    try:
        await redis_client.ping()
        logger.info("✅ Redis connected")
    except Exception as e:
        logger.warning(f"⚠️  Redis not available: {e}")

    yield

    logger.info("Shutting down AI service...")
    await redis_client.aclose()
    await http_client.aclose()


# ─── FastAPI app ─────────────────────────────────────────────────────────────

app = FastAPI(
    title="Ijarauz AI Service",
    description="AI-сервис на базе Ollama для платформы аренды недвижимости",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Ограничивается на уровне API gateway (Node.js)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Health Check ─────────────────────────────────────────────────────────────

@app.get("/health/live")
async def health_live():
    return {"status": "live"}


@app.get("/health/ready", response_model=HealthResponse)
async def health_ready():
    ollama_status = "unavailable"
    redis_status = "unavailable"

    try:
        resp = await http_client.get(f"{settings.ollama_base_url}/api/tags", timeout=5.0)
        if resp.status_code == 200:
            ollama_status = "ready"
    except Exception:
        pass

    try:
        await redis_client.ping()
        redis_status = "ready"
    except Exception:
        pass

    overall = "ready" if ollama_status == "ready" else "degraded"
    status_code = 200 if overall == "ready" else 503

    return JSONResponse(
        status_code=status_code,
        content={"status": overall, "ollama": ollama_status, "redis": redis_status},
    )


# ─── Chat endpoints ───────────────────────────────────────────────────────────

@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """Отправить сообщение в Ollama и получить ответ."""
    messages = _build_messages(request.messages)

    try:
        response = await http_client.post(
            f"{settings.ollama_base_url}/api/chat",
            json={
                "model": request.model,
                "messages": messages,
                "stream": False,
                "options": {"temperature": request.temperature, "num_ctx": 4096},
            },
        )
        response.raise_for_status()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Ollama request timed out")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Ollama error: {e.response.status_code}")
    except Exception as e:
        logger.error(f"Ollama call failed: {e}")
        raise HTTPException(status_code=502, detail="AI service unavailable")

    data = response.json()
    content = data.get("message", {}).get("content", "")

    return ChatResponse(content=content, model=request.model, session_id=request.session_id)


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """Стриминговый ответ от Ollama (SSE)."""
    messages = _build_messages(request.messages)

    async def generate() -> AsyncGenerator[str, None]:
        try:
            async with http_client.stream(
                "POST",
                f"{settings.ollama_base_url}/api/chat",
                json={
                    "model": request.model,
                    "messages": messages,
                    "stream": True,
                    "options": {"temperature": request.temperature},
                },
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                        content = chunk.get("message", {}).get("content", "")
                        if content:
                            yield f"data: {json.dumps({'content': content})}\n\n"
                        if chunk.get("done"):
                            yield f"data: {json.dumps({'done': True})}\n\n"
                            break
                    except json.JSONDecodeError:
                        continue
        except Exception as e:
            logger.error(f"Stream error: {e}")
            yield f"data: {json.dumps({'error': 'Stream failed'})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/models")
async def list_models():
    """Список доступных моделей Ollama."""
    try:
        response = await http_client.get(f"{settings.ollama_base_url}/api/tags", timeout=10.0)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Cannot reach Ollama: {e}")


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _build_messages(user_messages: list[ChatMessage]) -> list[dict]:
    """Добавляем system prompt в начало."""
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        *[{"role": m.role, "content": m.content} for m in user_messages],
    ]


# ─── Entry point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
