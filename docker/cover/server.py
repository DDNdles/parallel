#!/usr/bin/env python3
"""Cover service: separate vocals/instrumental, convert vocals to the Feiyu RVC
voice, then mix the converted vocal back with the instrumental.

The heavy lifting is delegated to two pinned pieces:

* ``audio-separator`` (UVR/MDX model) for vocal/instrumental separation
* the FeiyuVoice-RVC release package + its validated Applio runtime for RVC

The service itself is intentionally small: it owns one GPU lock, writes only
inside ``COVER_WORK_DIR``, and returns an mp3 body. It does not ship any model
weights; see README.md for the download and license notice.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

ROOT = Path(os.environ.get("COVER_ROOT", Path.home() / "cover")).resolve()
RVC_PACKAGE = Path(os.environ.get("COVER_RVC_PACKAGE", ROOT / "models" / "FeiyuVoice-RVC")).resolve()
RVC_PYTHON = Path(os.environ.get("COVER_RVC_PYTHON", ROOT / "rvc" / "venv" / "bin" / "python")).resolve()
RVC_RUNTIME = Path(os.environ.get("COVER_RVC_RUNTIME", ROOT / "rvc" / "runtime.local.json")).resolve()
WORK = Path(os.environ.get("COVER_WORK_DIR", ROOT / "work")).resolve()
MODEL_DIR = Path(os.environ.get("COVER_SEPARATOR_MODEL_DIR", ROOT / "separator-models")).resolve()
SEPARATOR_MODEL = os.environ.get("COVER_SEPARATOR_MODEL", "UVR-MDX-NET-Inst_HQ_3.onnx")
API_KEY = os.environ.get("COVER_API_KEY", "").strip()
PORT = int(os.environ.get("COVER_PORT", "8047"))
MAX_UPLOAD_MB = int(os.environ.get("COVER_MAX_UPLOAD_MB", "50"))
MAX_SECONDS = int(os.environ.get("COVER_MAX_SECONDS", "360"))
KEEP_HOURS = int(os.environ.get("COVER_KEEP_HOURS", "24"))

WORK.mkdir(parents=True, exist_ok=True)
MODEL_DIR.mkdir(parents=True, exist_ok=True)

_locks = {"gpu": threading.Lock()}
_separator = None
_separator_lock = threading.Lock()
_started = time.time()

# Long jobs (separation + RVC + mix) must not be a single HTTP request: the SCOW
# nginx proxy cuts requests at ~60s. Submit returns a job id, the plugin polls
# /jobs/{id} and downloads /jobs/{id}/audio when done.
JOBS = WORK / "jobs"
JOBS.mkdir(parents=True, exist_ok=True)
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_job_q: "queue.Queue[str]" = queue.Queue()
_worker_started = False


def ffmpeg_bin() -> str:
    env = os.environ.get("COVER_FFMPEG", "").strip()
    if env:
        return env
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        found = shutil.which("ffmpeg")
        if found:
            return found
        raise RuntimeError("找不到 ffmpeg：请设置 COVER_FFMPEG 或安装 imageio-ffmpeg")


def run(cmd: list[str], *, timeout: int = 900, capture: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.PIPE if capture else subprocess.DEVNULL,
        timeout=timeout,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or b"").decode("utf-8", "replace")[-800:]
        raise RuntimeError(f"命令失败（{cmd[0]}，退出码 {proc.returncode}）：{tail}")
    return proc


def probe_seconds(path: Path) -> float:
    proc = subprocess.run(
        [ffmpeg_bin(), "-hide_banner", "-i", str(path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
    )
    text = (proc.stderr or b"").decode("utf-8", "replace")
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if not m:
        raise RuntimeError("读不出音频时长（文件可能不是音频）")
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def to_wav(src: Path, dst: Path, *, rate: int = 44100, channels: int = 2) -> None:
    run(
        [
            ffmpeg_bin(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(src), "-vn", "-ac", str(channels), "-ar", str(rate),
            "-c:a", "pcm_s16le", str(dst),
        ],
        timeout=180,
    )


def to_mp3(src: Path, dst: Path, *, bitrate: str = "320k") -> None:
    run(
        [
            ffmpeg_bin(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(src), "-vn", "-c:a", "libmp3lame", "-b:a", bitrate, str(dst),
        ],
        timeout=300,
    )


def get_separator():
    global _separator
    with _separator_lock:
        if _separator is None:
            from audio_separator.separator import Separator

            sep = Separator(
                output_dir=str(WORK / "sep"),
                output_format="WAV",
                model_file_dir=str(MODEL_DIR),
            )
            # The A100 + onnxruntime-gpu combination hangs inside the first MDX
            # inference here (GPU 0%, process idle). CPU separation is slower but
            # deterministic; set COVER_SEPARATOR_CPU=0 to try the CUDA provider.
            if os.environ.get("COVER_SEPARATOR_CPU", "1").lower() not in ("0", "false", "no"):
                sep.onnx_execution_provider = ["CPUExecutionProvider"]
            sep.load_model(model_filename=SEPARATOR_MODEL)
            _separator = sep
        return _separator


def split_audio(src: Path, out_dir: Path) -> tuple[Path, Path]:
    """Return (vocals, instrumental) WAV files for the job.

    ``audio-separator`` writes into the ``output_dir`` captured when the
    ``Separator`` was constructed (``WORK/sep``); mutating ``sep.output_dir``
    afterwards is not reliable. Keep the constructor dir, clean it per job, and
    resolve the returned names against the places the library may use.
    """
    sep = get_separator()
    sep_dir = Path(getattr(sep, "output_dir", WORK / "sep"))
    shutil.rmtree(sep_dir, ignore_errors=True)
    sep_dir.mkdir(parents=True, exist_ok=True)
    vocal_dir = out_dir / "vocals"
    inst_dir = out_dir / "instrumental"
    vocal_dir.mkdir(parents=True, exist_ok=True)
    inst_dir.mkdir(parents=True, exist_ok=True)
    products = sep.separate(str(src))
    vocal = inst = None
    for name in products:
        raw = Path(str(name))
        candidates = [raw] if raw.is_absolute() else [
            sep_dir / raw,
            sep_dir / raw.name,
            out_dir / raw,
            Path.cwd() / raw,
        ]
        path = next((p for p in candidates if p.is_file()), None)
        if path is None:
            continue
        low = path.name.lower()
        if "instrumental" in low or "(inst" in low:
            inst = path
        elif "vocal" in low:
            vocal = path
    if vocal is None or inst is None:
        raise RuntimeError(f"分离结果不完整：products={products} sep_dir={sep_dir}")
    vocal_target = vocal_dir / vocal.name
    inst_target = inst_dir / inst.name
    if vocal.resolve() != vocal_target.resolve():
        shutil.move(str(vocal), str(vocal_target))
    if inst.resolve() != inst_target.resolve():
        shutil.move(str(inst), str(inst_target))
    return vocal_target, inst_target


def ensure_runtime_json() -> None:
    """run_rvc.py loads runtime.local.json from the model package.

    The validated runtime profile generated by feiyu's setup_runtime.py lives
    next to the RVC environment. Copy it into the package on first use; never
    modify the release's own integrity files.
    """
    target = RVC_PACKAGE / "runtime.local.json"
    if target.exists():
        return
    if not RVC_RUNTIME.exists():
        raise RuntimeError(f"找不到 RVC 运行时配置：{RVC_RUNTIME}")
    shutil.copyfile(RVC_RUNTIME, target)


def rvc_convert(vocal_wav: Path, out_dir: Path) -> Path:
    ensure_runtime_json()
    runner = RVC_PACKAGE / "run_rvc.py"
    if not runner.exists():
        raise RuntimeError(f"找不到 RVC 入口：{runner}")
    env = dict(os.environ)
    env.pop("PYTHONHOME", None)
    # setup_runtime may record a separate libpython directory (uv builds).
    # Set this BEFORE probing sysconfig: without it the RVC Python cannot start
    # and the probe returns empty, leaving the job's PYTHONPATH in place.
    try:
        profile = json.loads((RVC_PACKAGE / "runtime.local.json").read_text(encoding="utf-8"))
        libdir = str(profile.get("python_library_dir") or "").strip()
        if libdir:
            env["LD_LIBRARY_PATH"] = libdir + ":" + env.get("LD_LIBRARY_PATH", "")
    except Exception:  # noqa: BLE001
        pass
    # The job env (ACE-Step) may carry a PYTHONPATH that shadows the RVC venv;
    # pin the venv's own site-packages (numpy/torch/etc. live there).
    venv_lib = RVC_PYTHON.parent.parent / "lib"
    sites = sorted(venv_lib.glob("python*/site-packages"))
    site = str(sites[0]) if sites else ""
    if not site:
        try:
            probe = subprocess.run(
                [str(RVC_PYTHON), "-c", "import sysconfig;print(sysconfig.get_paths()['purelib'])"],
                capture_output=True, text=True, timeout=30, env=env,
            )
            site = probe.stdout.strip() if probe.returncode == 0 else ""
        except Exception:  # noqa: BLE001
            site = ""
    if site:
        env["PYTHONPATH"] = site
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
    result = subprocess.run(
        [str(RVC_PYTHON), "-B", str(runner), "--input", str(vocal_wav), "--output-dir", str(out_dir)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=900,
        env=env,
    )
    if result.returncode != 0:
        tail = (result.stderr or b"").decode("utf-8", "replace")[-1200:]
        raise RuntimeError(f"RVC 转换失败（退出码 {result.returncode}）：{tail}")
    native = out_dir / "rvc_native.wav"
    if not native.is_file():
        raise RuntimeError("RVC 没有产出 rvc_native.wav")
    return native


def mix(vocal_wav: Path, inst_wav: Path | None, out_wav: Path, *, vg: float, ig: float) -> float:
    vocal, vrate = sf.read(vocal_wav, dtype="float32", always_2d=False)
    if vocal.ndim > 1:
        vocal = vocal.mean(axis=1)
    if inst_wav is None:
        master_rate = vrate
        inst = np.zeros((len(vocal),), dtype=np.float32)
    else:
        inst, master_rate = sf.read(inst_wav, dtype="float32", always_2d=False)
        if inst.ndim == 1:
            inst = inst[:, None]
    # Resample the converted vocal to the instrumental's rate.
    if vrate != master_rate and len(vocal):
        try:
            import soxr

            vocal = soxr.resample(vocal, vrate, master_rate)
        except Exception:  # noqa: BLE001
            import librosa

            vocal = librosa.resample(vocal, orig_sr=vrate, target_sr=master_rate)
    if inst.ndim == 1:
        inst = inst[:, None]
    # Pad/trim the vocal to the master length so the mix keeps the original song length.
    if len(vocal) < len(inst):
        vocal = np.pad(vocal, (0, len(inst) - len(vocal)))
    elif len(vocal) > len(inst):
        vocal = vocal[: len(inst)]
    vocal_st = np.repeat(vocal[:, None], inst.shape[1], axis=1)
    mixed = vocal_st * float(vg) + inst * float(ig)
    peak = float(np.max(np.abs(mixed))) if mixed.size else 0.0
    if peak > 0.95:
        mixed = mixed * (0.95 / peak)
    sf.write(out_wav, mixed, master_rate, subtype="PCM_16")
    return len(mixed) / master_rate if master_rate else 0.0


def cleanup_work() -> None:
    cutoff = time.time() - KEEP_HOURS * 3600
    for root in (WORK, JOBS):
        try:
            children = list(root.iterdir())
        except OSError:
            continue
        for child in children:
            if child.name in ("jobs", "sep"):
                continue
            try:
                if child.is_dir() and child.stat().st_mtime < cutoff:
                    shutil.rmtree(child, ignore_errors=True)
            except OSError:
                continue


app = FastAPI(title="parallel cover service", version="1.0.0")


def auth(authorization: str | None) -> None:
    if not API_KEY:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    if authorization[7:].strip() != API_KEY:
        raise HTTPException(401, "invalid bearer token")


@app.get("/health")
def health():
    with _jobs_lock:
        queued = sum(1 for j in _jobs.values() if j["status"] == "queued")
        running = sum(1 for j in _jobs.values() if j["status"] == "running")
    return {
        "ok": True,
        "service": "cover",
        "uptime": round(time.time() - _started, 1),
        "rvc_package": RVC_PACKAGE.is_dir(),
        "rvc_python": RVC_PYTHON.is_file(),
        "runtime": RVC_RUNTIME.is_file(),
        "separator_model": SEPARATOR_MODEL,
        "separator_loaded": _separator is not None,
        "device": "cuda",
        "jobs": {"queued": queued, "running": running},
    }


def process_cover(work: Path, raw: Path, with_instrumental: bool, vg: float, ig: float) -> bytes:
    """同步重活：转码 → 分离 → RVC → 混音 → mp3。

    放在线程里跑，避免 CPU 分离把 FastAPI 的 event loop 堵住（/health 会跟着超时）。
    """
    print(f"[cover] start {work}", flush=True)
    song_wav = work / "song.wav"
    to_wav(raw, song_wav)
    print("[cover] input converted, separating", flush=True)
    vocals, inst = split_audio(song_wav, work)
    print(f"[cover] separated vocals={vocals.name} inst={inst.name}", flush=True)
    vocals_44k = work / "vocals_44k.wav"
    to_wav(vocals, vocals_44k, rate=44100, channels=1)
    # run_rvc.py 自己创建输出目录，且拒绝已存在的目录（不允许覆盖旧结果）
    rvc_out = work / "rvc"
    native = rvc_convert(vocals_44k, rvc_out)
    print(f"[cover] rvc done {native}", flush=True)
    final_wav = work / "final.wav"
    if with_instrumental:
        mix(native, inst, final_wav, vg=vg, ig=ig)
    else:
        mix(native, None, final_wav, vg=vg, ig=0.0)
    print("[cover] mixed, encoding mp3", flush=True)
    mp3 = work / "final.mp3"
    to_mp3(final_wav, mp3)
    data = mp3.read_bytes()
    if not data:
        raise RuntimeError("final mp3 is empty")
    return data


def _worker_loop() -> None:
    while True:
        job_id = _job_q.get()
        with _jobs_lock:
            job = _jobs.get(job_id)
        if not job:
            _job_q.task_done()
            continue
        job["status"] = "running"
        job["started_at"] = time.time()
        try:
            with _locks["gpu"]:
                data = process_cover(
                    Path(job["work"]),
                    Path(job["work"]) / "input.audio",
                    bool(job["with_instrumental"]),
                    float(job["vocal_gain"]),
                    float(job["instrumental_gain"]),
                )
            (Path(job["work"]) / "final.mp3").write_bytes(data)
            job["status"] = "done"
            job["bytes"] = len(data)
        except Exception as exc:  # noqa: BLE001
            job["status"] = "failed"
            job["error"] = str(exc)[:800]
        finally:
            job["ended_at"] = time.time()
            _job_q.task_done()


def _ensure_worker() -> None:
    global _worker_started
    with _jobs_lock:
        if _worker_started:
            return
        _worker_started = True
        threading.Thread(target=_worker_loop, daemon=True, name="cover-worker").start()


def _job_view(job: dict) -> dict:
    return {
        "ok": True,
        "id": job["id"],
        "status": job["status"],
        "seconds": job.get("seconds"),
        "bytes": job.get("bytes", 0),
        "error": job.get("error", ""),
        "elapsed": round((job.get("ended_at") or time.time()) - job.get("created_at", time.time()), 1),
    }


@app.post("/cover", status_code=202)
async def submit_cover(
    audio: UploadFile = File(...),
    with_instrumental: bool = Form(True),
    vocal_gain: float = Form(1.0),
    instrumental_gain: float = Form(1.0),
    authorization: str | None = Header(default=None),
):
    auth(authorization)
    _ensure_worker()
    job_id = uuid.uuid4().hex
    work = JOBS / job_id
    work.mkdir(parents=True, exist_ok=True)
    raw = work / "input.audio"
    try:
        size = 0
        with raw.open("wb") as stream:
            while chunk := await audio.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_MB * 1024 * 1024:
                    raise HTTPException(413, f"audio exceeds {MAX_UPLOAD_MB} MB")
                stream.write(chunk)
        if size == 0:
            raise HTTPException(422, "empty audio")
        seconds = await asyncio.to_thread(probe_seconds, raw)
        if seconds > MAX_SECONDS:
            raise HTTPException(422, f"audio is {seconds:.0f}s; limit is {MAX_SECONDS}s")
        with _jobs_lock:
            _jobs[job_id] = {
                "id": job_id,
                "status": "queued",
                "created_at": time.time(),
                "work": str(work),
                "seconds": seconds,
                "with_instrumental": bool(with_instrumental),
                "vocal_gain": max(0.0, min(2.0, vocal_gain)),
                "instrumental_gain": max(0.0, min(2.0, instrumental_gain)),
            }
        _job_q.put(job_id)
        cleanup_work()
        return {"ok": True, "id": job_id, "status": "queued", "seconds": seconds}
    except HTTPException:
        shutil.rmtree(work, ignore_errors=True)
        raise
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(work, ignore_errors=True)
        return JSONResponse(status_code=500, content={"ok": False, "error": str(exc)[:800]})


@app.get("/jobs/{job_id}")
def job_status(job_id: str, authorization: str | None = Header(default=None)):
    auth(authorization)
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return _job_view(job)


@app.get("/jobs/{job_id}/audio")
def job_audio(job_id: str, authorization: str | None = Header(default=None)):
    auth(authorization)
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job["status"] != "done":
        raise HTTPException(409, f"job is {job['status']}")
    path = Path(job["work"]) / "final.mp3"
    if not path.is_file():
        raise HTTPException(404, "audio missing")
    return Response(
        content=path.read_bytes(),
        media_type="audio/mpeg",
        headers={
            "x-cover-seconds": f"{float(job.get('seconds') or 0):.1f}",
            "content-disposition": f'inline; filename="cover_{job_id[:8]}.mp3"',
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
