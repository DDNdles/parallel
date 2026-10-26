# cover service（RVC 翻唱）

把一首带伴奏的歌变成「大肥鱼人声 + 原曲伴奏」：

```
原曲 mp3/wav
  → UVR/MDX 分离（audio-separator）
  → FeiyuVoice-RVC v1 换音色（固定 Applio 运行时）
  → 按原曲时间轴混回伴奏
  → mp3
```

> 模型权重不随仓库分发。FeiyuVoice-RVC 的分发说明见
> <https://huggingface.co/Esmerubphire/FeiyuVoice-RVC>：模型/音色/源录音没有授予
> 通用的开源或商用许可，只在你已获授权的场景使用；不要把权重或训练素材提交进
> 本仓库。

## 目录

```
docker/cover/
├── server.py    # FastAPI：/health、/cover
└── README.md
```

服务本身不做搜歌。parallel 插件（`src/plugins/cover`）负责网易云搜歌/取流，
再把原曲字节 POST 到 `/cover`；这样服务可以部署在任意 GPU 机器上。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `COVER_ROOT` | `~/cover` | 部署根目录 |
| `COVER_RVC_PACKAGE` | `$COVER_ROOT/models/FeiyuVoice-RVC` | RVC 模型包（含 `.pth`、`.index`、`run_rvc.py`） |
| `COVER_RVC_PYTHON` | `$COVER_ROOT/rvc/venv/bin/python` | Applio/RVC 的 Python |
| `COVER_RVC_RUNTIME` | `$COVER_ROOT/rvc/runtime.local.json` | feiyu `setup_runtime.py`/`register_runtime.py` 生成的运行时配置 |
| `COVER_SEPARATOR_MODEL` | `UVR-MDX-NET-Inst_HQ_3.onnx` | audio-separator 模型名 |
| `COVER_SEPARATOR_MODEL_DIR` | `$COVER_ROOT/separator-models` | 分离模型缓存 |
| `COVER_WORK_DIR` | `$COVER_ROOT/work` | 临时文件（默认保留 24h 清理） |
| `COVER_FFMPEG` | 自动找 `imageio-ffmpeg`/PATH | ffmpeg 可执行文件 |
| `COVER_API_KEY` | 空 | 非空时 `/cover` 要求 `Authorization: Bearer <key>` |
| `COVER_PORT` | `8047` | 监听端口 |
| `COVER_MAX_UPLOAD_MB` | `50` | 上传上限 |
| `COVER_MAX_SECONDS` | `360` | 原曲时长上限（秒） |

## 部署（Linux + NVIDIA）

1. 准备 Python 3.11 + ffmpeg。`ffmpeg` 可以用 `imageio-ffmpeg` 的静态二进制：
   ```bash
   uv venv tools-venv --python 3.11.17
   uv pip install --python tools-venv/bin/python imageio-ffmpeg
   mkdir -p bin
   ln -sf "$(tools-venv/bin/python -c 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())')" bin/ffmpeg
   export PATH="$PWD/bin:$PATH"
   ```
2. 装 RVC 运行时。按 feiyu 的 `INSTALL_AGENT.md`：
   ```bash
   cd feiyu/server
   FEIYU_PY="$(uv python find 3.11.17)"
   "$FEIYU_PY" scripts/setup_runtime.py --backend cuda --engine rvc \
     --python "$FEIYU_PY" --destination "$HOME/cover/rvc"
   ```
   安装器会克隆固定 commit 的 Applio、覆盖兼容源码、下载 ContentVec/RMVPE、安装
   torch cu128 与依赖，并生成 `runtime.local.json`。
3. 下载模型包到 `$COVER_ROOT/models/FeiyuVoice-RVC`（ModelScope 或 HuggingFace），
   把 `runtime.local.json` 复制进去：
   ```bash
   cp "$HOME/cover/rvc/runtime.local.json" "$HOME/cover/models/FeiyuVoice-RVC/"
   ```
4. 装服务 venv（API + 分离）：
   ```bash
   uv venv "$HOME/cover/svc-venv" --python 3.11.17
   uv pip install --python "$HOME/cover/svc-venv/bin/python" \
     fastapi uvicorn python-multipart audio-separator imageio-ffmpeg soundfile numpy
   ```
5. 启动：
   ```bash
   COVER_API_KEY="$(openssl rand -hex 16)" \
   COVER_ROOT="$HOME/cover" COVER_PORT=8047 \
   "$HOME/cover/svc-venv/bin/python" "$HOME/cover/server.py"
   ```
6. 第一次 `/cover` 会下载分离模型并加载 RVC，可能多等几十秒；之后
   `/health` 会显示 `separator_loaded: true`。

## API

### `GET /health`

```json
{"ok":true,"service":"cover","rvc_package":true,"rvc_python":true,"runtime":true,
 "separator_model":"UVR-MDX-NET-Inst_HQ_3.onnx","separator_loaded":false,"device":"cuda"}
```

### `POST /cover`

`multipart/form-data`：

| 字段 | 必填 | 说明 |
|---|---|---|
| `audio` | 是 | 原曲文件（mp3/wav/flac/m4a…）；≤ `COVER_MAX_UPLOAD_MB` |
| `with_instrumental` | 否 | 默认 `true`；`false` 只返回换声后的人声 |
| `vocal_gain` | 否 | 人声音量，默认 `1.0`（0~2） |
| `instrumental_gain` | 否 | 伴奏音量，默认 `1.0`（0~2） |

成功返回 `audio/mpeg`，响应头 `x-cover-seconds` 是原曲时长。失败返回
`{"ok":false,"error":"..."}`，HTTP 400/413/422/500/503。

单 GPU 串行：同时只处理一个请求，忙时返回 503。

## 许可与合规

- 代码：MIT。
- RVC 运行时来自 [Applio](https://github.com/IAHispano/Applio)（MIT），模型包来自
  FeiyuVoice-RVC（`license: other`，见其 `NOTICE.md`）。
- 只处理你拥有合法授权的音频；翻唱成品对外发布时遵守当地关于 AI 生成内容的标识
  规定。
- 不要把模型权重、训练素材或带 Key 的配置提交进仓库。
