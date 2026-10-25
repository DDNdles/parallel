#!/usr/bin/env python3
"""唱歌 TTS 服务：把 ACE-Step 1.5 包成插件 `provider=custom` 的 /generate 契约。

契约（必须与 src/plugins/sing/index.ts 一致，2026-10 已核对源码）：
    POST {baseUrl}/generate
    Authorization: Bearer <SING_API_KEY>
    {"lyrics": "...", "tags": "...", "seconds": 60}
    -> 200，响应体直接是音频字节（本服务固定 mp3 / 24kHz / 单声道 / 24kbps）

    GET /health -> {ok, model_loaded, ref_loaded, device}

插件侧依据：
  - `generateCustom` 只发 lyrics/tags/seconds，Authorization: Bearer
    （src/plugins/sing/index.ts:492-525）；响应体按文件头识别 mp3/wav
    （index.ts:66-75、715-719），所以绝不能返回 JSON 包装。
  - 插件对所有 provider 都要求 apiKey 非空（index.ts:649-651）；本服务的
    SING_API_KEY 未设置时不做校验，插件那边随便填一个占位串即可。

ACE-Step 调用形状（2026-10 调研，来源已逐条标注）：
  - 处理器初始化：`acestep/inference.py:110-140`、`docs/zh/INFERENCE.md:20-60`
  - `GenerationParams` / `GenerationConfig` / `generate_music`：同上
  - 输出 48kHz 立体声由 VAE 固定（`acestep/handler.py:121`、
    `docs/zh/INFERENCE.md:175`），本服务再交给 ffmpeg 转成 QQ 语音友好的
    24kHz 单声道 mp3。
  - 参考音频在服务内部会被重采样到 48k 立体声；不足 30s 循环、超过 30s
    取前/中/后三段各 10s（`acestep/core/generation/handler/io_audio.py:117-176`）。
    全静音/读不出的文件会被上游丢弃（返回 None），等于没有克隆音色。

环境变量（全部可选，默认值写在下面常量里）：
  SING_API_KEY            非空则校验 Authorization: Bearer（密钥只从环境读）
  SING_HOST / SING_PORT   监听地址（默认 0.0.0.0:8046）
  SING_REF_DIR            参考音频目录（默认 /ref，compose 挂载）
  SING_REF_DEFAULT        请求不带 ref 时用的文件名（默认 dafatyu，自动补 .wav）
  SING_DEFAULT_TAGS       请求 tags 为空时的风格描述
  SING_VOCAL_LANGUAGE     人声语言，默认 zh（调研 `acestep/constants.py:12-20`）
  SING_INFERENCE_STEPS    Turbo 推荐 8（调研）
  SING_DEVICE             cuda / cpu / auto（默认 cuda；cuda/auto 都会先试 CUDA，
                          torch 不可用或没有显卡时自动回退 cpu）
  ACESTEP_ROOT            ACE-Step 源码根目录（默认 /app）
  ACESTEP_CHECKPOINTS_DIR 权重目录（默认 $ACESTEP_ROOT/checkpoints；官方变量名）
  ACESTEP_CONFIG_PATH     DiT 配置（默认 acestep-v15-turbo）
  ACESTEP_LM_MODEL_PATH   LM 权重（默认 acestep-5Hz-lm-0.6B）
  ACESTEP_LM_BACKEND      LM 后端（默认 vllm）
  ACESTEP_DOWNLOAD_SOURCE 权重下载源 modelscope / huggingface（默认 modelscope；
                          留空则由上游自动探测）
  ACESTEP_QUANTIZATION    DiT 量化（默认 int8_weight_only；none 关闭）
  ACESTEP_OFFLOAD_TO_CPU      空闲模块卸载到 CPU（默认 true，Tier 4）
  ACESTEP_OFFLOAD_DIT_TO_CPU  扩散间隙把 DiT 卸载到 CPU（默认 true，Tier 4）
  SING_WORK_DIR           生成中间文件目录（默认系统临时目录）
  SING_FFMPEG_TIMEOUT     ffmpeg 转码超时秒数（默认 180）

显存口径（调研结论，RTX 3080 10GB = 官方 Tier 4 8-12GB）：
  - 只支持 2B DiT（turbo 8 steps / sft 50 steps），不支持 XL(4B)。
  - offload/INT8：本服务读 ACESTEP_OFFLOAD_TO_CPU 等 env 后**显式传给**
    initialize_service（它自身不读这些 env）；Tier 4 默认全开，CPU 模式自动关。
  - 30s 曲目约 4-6s、60s 约 8-12s（GPU Turbo）；CPU 则要 3-15 分钟。
"""

from __future__ import annotations

import hmac
import json
import logging
import math
import os
import shutil
import subprocess
import tempfile
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

LOG = logging.getLogger("sing")


# ============================================================
# 配置（环境变量全部在这里读；不在任何地方写死密钥）
# ============================================================


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value or default


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(_env(name, str(default)))
    except ValueError:
        value = default
    return max(low, min(high, value))


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on", "y"}


def _env_path(name: str, default: str) -> Path:
    return Path(_env(name, default)).expanduser()


HOST = _env("SING_HOST", "0.0.0.0")
PORT = _env_int("SING_PORT", 8046, 1, 65535)
API_KEY = _env("SING_API_KEY", "")
REF_DIR = _env_path("SING_REF_DIR", "/ref")
REF_DEFAULT = _env("SING_REF_DEFAULT", "dafatyu")
DEFAULT_TAGS = _env("SING_DEFAULT_TAGS", "cute female vocal, pop, bright")
VOCAL_LANGUAGE = _env("SING_VOCAL_LANGUAGE", "zh")
INFERENCE_STEPS = _env_int("SING_INFERENCE_STEPS", 8, 1, 100)
DEVICE_WANT = _env("SING_DEVICE", "cuda").lower()
FFMPEG_TIMEOUT = _env_int("SING_FFMPEG_TIMEOUT", 180, 10, 1800)
WORK_DIR = _env_path("SING_WORK_DIR", tempfile.gettempdir())

ACESTEP_ROOT = _env_path("ACESTEP_ROOT", "/app")
# 官方变量名是 ACESTEP_CHECKPOINTS_DIR（复数，init_service_orchestrator.py:120-125）；
# 兼容旧写法 ACESTEP_CHECKPOINT_DIR。
CHECKPOINT_DIR = _env_path(
    "ACESTEP_CHECKPOINTS_DIR",
    _env("ACESTEP_CHECKPOINT_DIR", str(ACESTEP_ROOT / "checkpoints")),
)
DIT_CONFIG = _env("ACESTEP_CONFIG_PATH", "acestep-v15-turbo")
LM_MODEL = _env("ACESTEP_LM_MODEL_PATH", "acestep-5Hz-lm-0.6B")
LM_BACKEND = _env("ACESTEP_LM_BACKEND", "vllm")
DOWNLOAD_SOURCE = _env("ACESTEP_DOWNLOAD_SOURCE", "modelscope").lower()
PREFER_SOURCE = DOWNLOAD_SOURCE if DOWNLOAD_SOURCE in {"modelscope", "huggingface"} else None
# Tier 4 (8-12GB) 默认量化；none/off 关闭。
QUANTIZATION = _env("ACESTEP_QUANTIZATION", "int8_weight_only").lower()
if QUANTIZATION in {"", "none", "off", "false", "0"}:
    QUANTIZATION = None
OFFLOAD_TO_CPU = _env_bool("ACESTEP_OFFLOAD_TO_CPU", True)
OFFLOAD_DIT_TO_CPU = _env_bool("ACESTEP_OFFLOAD_DIT_TO_CPU", True)
LOG_LEVEL = _env("SING_LOG_LEVEL", "INFO").upper()

# 歌词/风格的宽松上限：插件自己已经钳到 3000/300（index.ts:38-40），
# 服务端只防滥用，不跟插件打架。
LYRICS_MAX = 10000
TAGS_MAX = 1000
BODY_MAX_BYTES = 256 * 1024


class ApiError(Exception):
    """带 HTTP 状态码的可直接返回错误；message 会原样进 {"error": ...}。"""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


# ============================================================
# 参考音频
# ============================================================


def _resolve_ref(name: str | None) -> Path:
    """把请求里的 ref 解析成 REF_DIR 下的真实文件。

    只接受文件名（可省略扩展名），拒绝任何路径分隔符 / ..，
    避免请求把服务端读成任意文件。默认 dafatyu -> /ref/dafatyu.wav。
    """

    raw = (name or "").strip() or REF_DEFAULT
    if raw in {".", ".."} or "/" in raw or "\\" in raw:
        raise ApiError(400, "ref 只接受 /ref 目录下的文件名（如 dafatyu.wav），不能带路径")

    root = REF_DIR.resolve()
    candidate = (root / raw).resolve()
    if candidate != root and root not in candidate.parents:
        raise ApiError(400, "ref 越界：只允许读取 /ref 目录下的文件")

    if candidate.is_file():
        return candidate
    if not candidate.suffix:
        for ext in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"):
            alt = candidate.with_name(candidate.name + ext)
            if alt.is_file():
                return alt
    raise ApiError(400, f"参考音频不存在：{candidate}（把 dafatyu.wav 拷进挂载的 ref 卷）")


def _ref_loaded() -> bool:
    try:
        _resolve_ref(None)
        return True
    except ApiError:
        return False


# ============================================================
# ACE-Step 引擎（后台线程加载；生成用单 GPU 锁串行化）
# ============================================================


class Engine:
    def __init__(self) -> None:
        self.ready = threading.Event()
        self.failed: str | None = None
        # cpu 明确用 CPU；cuda / auto / 其它值都先试 CUDA，不可用再回退。
        self.device = "cpu" if DEVICE_WANT == "cpu" else "cuda"
        self.dit: Any = None
        self.llm: Any = None
        # 单 GPU：同一时刻只允许一个生成；拿不到锁立刻回 503 busy。
        self.gen_lock = threading.Lock()
        self._started = False
        self._start_guard = threading.Lock()

    def start_loading(self) -> None:
        with self._start_guard:
            if self._started:
                return
            self._started = True
        thread = threading.Thread(target=self._load, name="acestep-loader", daemon=True)
        thread.start()

    def _cuda_available(self) -> bool:
        try:
            import torch  # 只在加载线程里 import，别拖慢 /health 的首个响应

            return bool(torch.cuda.is_available())
        except Exception:  # 没有 torch / 驱动异常都按 CPU 处理
            LOG.warning("检测 CUDA 失败，按 CPU 加载", exc_info=True)
            return False

    def _load(self) -> None:
        try:
            if self.device == "cuda" and not self._cuda_available():
                LOG.warning("没有可用的 CUDA，回退 CPU（生成会非常慢，仅适合功能验证）")
                self.device = "cpu"

            # 调用形状来源：docs/zh/INFERENCE.md:20-60、acestep/inference.py:110-140。
            # 返回值是 (status_message, success)，不是 bool
            # （acestep/core/generation/handler/init_service_orchestrator.py:48-66）。
            from acestep.handler import AceStepHandler
            from acestep.llm_inference import LLMHandler
            from acestep.model_downloader import ensure_lm_model

            # initialize_service 只认 ACESTEP_CHECKPOINTS_DIR（复数），
            # 不认 ACESTEP_CHECKPOINT_DIR；显式写回环境，保证权重落在卷里。
            CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
            os.environ["ACESTEP_CHECKPOINTS_DIR"] = str(CHECKPOINT_DIR)

            # CPU 模式下量化/卸载没有意义，且 int8 在 CPU 上容易失败；统一关掉。
            on_gpu = self.device == "cuda"
            quantization = QUANTIZATION if on_gpu else None
            offload_to_cpu = OFFLOAD_TO_CPU if on_gpu else False
            offload_dit_to_cpu = OFFLOAD_DIT_TO_CPU if on_gpu else False

            LOG.info("加载 DiT：%s（root=%s, device=%s）", DIT_CONFIG, ACESTEP_ROOT, self.device)
            self.dit = AceStepHandler()
            status, ok = self.dit.initialize_service(
                project_root=str(ACESTEP_ROOT),
                config_path=DIT_CONFIG,
                device=self.device,
                offload_to_cpu=offload_to_cpu,
                offload_dit_to_cpu=offload_dit_to_cpu,
                quantization=quantization,
                prefer_source=PREFER_SOURCE,
            )
            if not ok:
                raise RuntimeError(f"DiT 初始化失败：{status}")
            LOG.info("DiT 就绪：%s", str(status).splitlines()[0] if status else "ok")

            # LLMHandler.initialize 不会自动下载权重（llm_inference.py:588-590）；
            # 官方 API 服务在初始化前会先 ensure（api/startup_model_init.py），
            # 这里照做。
            LOG.info("准备 LM 权重：%s（source=%s）", LM_MODEL, PREFER_SOURCE or "auto")
            lm_ok, lm_msg = ensure_lm_model(
                LM_MODEL,
                checkpoints_dir=CHECKPOINT_DIR,
                prefer_source=PREFER_SOURCE,
            )
            if not lm_ok:
                raise RuntimeError(f"LM 权重准备失败：{lm_msg}")

            LOG.info("加载 LM：%s（backend=%s, checkpoints=%s）", LM_MODEL, LM_BACKEND, CHECKPOINT_DIR)
            self.llm = LLMHandler()
            lm_status, lm_ok = self.llm.initialize(
                checkpoint_dir=str(CHECKPOINT_DIR),
                lm_model_path=LM_MODEL,
                backend=LM_BACKEND,
                device=self.device,
                offload_to_cpu=offload_to_cpu,
            )
            if not lm_ok:
                raise RuntimeError(f"LM 初始化失败：{lm_status}")
            LOG.info("LM 就绪：%s", str(lm_status).splitlines()[0] if lm_status else "ok")

            self.ready.set()
            LOG.info("ACE-Step 全部加载完成（device=%s）", self.device)
        except Exception as exc:  # noqa: BLE001 - 加载失败要留给 /health 与 /generate
            self.failed = f"{type(exc).__name__}: {exc}"
            LOG.exception("ACE-Step 加载失败：%s", self.failed)


ENGINE = Engine()


# ============================================================
# 请求解析与生成
# ============================================================


def _parse_payload(raw: bytes) -> tuple[str, str, int, str | None]:
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiError(400, "请求体不是合法 JSON") from exc
    if not isinstance(data, dict):
        raise ApiError(400, "请求体必须是 JSON 对象")

    lyrics = str(data.get("lyrics") or "").strip()
    if not lyrics:
        raise ApiError(400, "lyrics 不能为空")
    if len(lyrics) > LYRICS_MAX:
        raise ApiError(400, f"lyrics 太长了（上限 {LYRICS_MAX} 字符）")

    tags = str(data.get("tags") or "").strip() or DEFAULT_TAGS
    if len(tags) > TAGS_MAX:
        tags = tags[:TAGS_MAX]

    # 插件契约：seconds 是数字，服务端钳到 10..120（ask / index.ts:643-647）
    seconds = 60.0
    seconds_raw = data.get("seconds")
    if seconds_raw is not None and str(seconds_raw).strip() != "":
        try:
            seconds = float(seconds_raw)
        except (TypeError, ValueError) as exc:
            raise ApiError(400, "seconds 必须是数字（秒）") from exc
    if not math.isfinite(seconds):
        raise ApiError(400, "seconds 必须是有限数字")
    seconds = int(round(min(120.0, max(10.0, seconds))))

    ref = data.get("ref")
    if ref is not None and not isinstance(ref, str):
        raise ApiError(400, "ref 必须是字符串文件名")

    return lyrics, tags, seconds, ref


def _ffmpeg_to_mp3(src: Path) -> bytes:
    """ACE-Step 出 48k 立体声 -> QQ 语音友好的 24kHz 单声道 24kbps mp3。

    输出直接走 stdout（pipe:1），不落第二个临时文件。
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise ApiError(500, "服务端缺少 ffmpeg，无法转码")

    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-i", str(src),
        "-vn",
        "-map_metadata", "-1",
        "-ac", "1",
        "-ar", "24000",
        "-c:a", "libmp3lame",
        "-b:a", "24k",
        "-f", "mp3",
        "pipe:1",
    ]
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=FFMPEG_TIMEOUT,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ApiError(500, f"ffmpeg 转码超时（{FFMPEG_TIMEOUT}s）") from exc

    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        detail = " | ".join(line.strip() for line in tail) or f"exit {proc.returncode}"
        raise ApiError(500, f"ffmpeg 转码失败：{detail[:400]}")
    if not proc.stdout:
        raise ApiError(500, "ffmpeg 转码输出为空")
    return proc.stdout


def _generate_sync(lyrics: str, tags: str, seconds: int, ref_name: str | None) -> bytes:
    ref_path = _resolve_ref(ref_name)

    if not ENGINE.ready.is_set():
        if ENGINE.failed:
            raise ApiError(503, f"模型加载失败：{ENGINE.failed}")
        raise ApiError(503, "模型还在加载（首次启动要下载/加载 ACE-Step 权重），稍后再试")

    if not ENGINE.gen_lock.acquire(blocking=False):
        # 插件约定：单 GPU 排队中直接回 503 {"error":"busy"}
        raise ApiError(503, "busy")

    work_dir: Path | None = None
    try:
        work_dir = Path(tempfile.mkdtemp(prefix="sing-", dir=str(WORK_DIR) if WORK_DIR.is_dir() else None))

        # 调用形状来源：docs/zh/INFERENCE.md:20-60、acestep/inference.py:110-140。
        # 这些字段名（caption / reference_audio / duration / thinking）是按调研
        # 写死的；若上游改签名，这里会立刻报错而不是悄悄唱错。
        from acestep.inference import GenerationConfig, GenerationParams, generate_music

        params = GenerationParams(
            task_type="text2music",
            caption=tags,                     # 风格/标签（调研示例）
            lyrics=lyrics,
            reference_audio=str(ref_path),    # 参考音频克隆音色（调研）
            duration=float(seconds),          # 10..120 秒（插件契约）
            inference_steps=INFERENCE_STEPS,  # Turbo 推荐 8（调研）
            vocal_language=VOCAL_LANGUAGE,    # 中文 "zh"（调研）
            thinking=True,                    # 5Hz LM 规划（调研）
        )
        config = GenerationConfig(
            batch_size=1,
            audio_format="wav",               # 中间产物用无损 wav，再转 mp3
        )

        result = generate_music(
            ENGINE.dit,
            ENGINE.llm,
            params,
            config,
            save_dir=str(work_dir),
        )

        if not getattr(result, "success", False):
            detail = str(getattr(result, "error", "") or "未知原因").strip()
            raise ApiError(500, f"ACE-Step 生成失败：{detail[:300]}")

        audios = list(getattr(result, "audios", None) or [])
        if not audios:
            raise ApiError(500, "ACE-Step 没有返回音频")

        first = audios[0]
        # 调研：result.audios 是 dict 列表，元素含 path/sample_rate/params.seed。
        path = first.get("path") if isinstance(first, dict) else getattr(first, "path", None)
        if not path:
            raise ApiError(500, "ACE-Step 没有返回音频文件路径")

        src = Path(str(path))
        if not src.is_file():
            raise ApiError(500, f"ACE-Step 报告的音频文件不存在：{src}")

        return _ffmpeg_to_mp3(src)
    finally:
        ENGINE.gen_lock.release()
        if work_dir is not None:
            shutil.rmtree(work_dir, ignore_errors=True)


# ============================================================
# HTTP
# ============================================================


def _authorized(request: Request) -> bool:
    """SING_API_KEY 为空 = 不校验（插件那边仍要求非空 apiKey，填占位即可）。"""
    if not API_KEY:
        return True
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return False
    return hmac.compare_digest(token.strip().encode("utf-8"), API_KEY.encode("utf-8"))


def _json(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


@asynccontextmanager
async def lifespan(_: FastAPI):
    ENGINE.start_loading()
    yield


app = FastAPI(
    title="qqbot sing (ACE-Step 1.5)",
    description="插件 provider=custom 的 /generate 包装：参考音频克隆音色 + 歌词整曲生成",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "model_loaded": ENGINE.ready.is_set(),
        "ref_loaded": _ref_loaded(),
        "device": ENGINE.device,
    }


@app.post("/generate")
async def generate(request: Request) -> Response:
    if not _authorized(request):
        return _json(401, "unauthorized")

    # 先看 content-length 预检：声明就超限的请求连 body 都不读，直接 413。
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared = int(content_length)
        except ValueError:
            declared = 0
        if declared > BODY_MAX_BYTES:
            return _json(413, "请求体太大")

    # content-length 缺失/撒谎时按流式读取累计，超限立刻停，不把整段 body 读进内存。
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > BODY_MAX_BYTES:
            return _json(413, "请求体太大")
        chunks.append(chunk)
    body = b"".join(chunks)

    try:
        lyrics, tags, seconds, ref = _parse_payload(body)
        audio = await run_in_threadpool(_generate_sync, lyrics, tags, seconds, ref)
    except ApiError as exc:
        return _json(exc.status, exc.message)
    except Exception:  # noqa: BLE001 - 任何意外都变成 {"error": ...}，不抛裸 500
        LOG.exception("生成时出现未预期的异常")
        return _json(500, "生成失败：服务端内部错误")

    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": 'inline; filename="sing.mp3"',
        },
    )


def main() -> None:
    logging.basicConfig(
        level=getattr(logging, LOG_LEVEL, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    import uvicorn

    # 单进程单 worker：生成锁 + 显存都按「一个 GPU 一个生成」设计。
    uvicorn.run(app, host=HOST, port=PORT, workers=1, log_level=LOG_LEVEL.lower())


if __name__ == "__main__":
    main()
