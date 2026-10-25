# 唱歌 TTS 服务（ACE-Step 1.5 包装）

插件「唱歌」的自部署后端。把 ACE-Step 1.5 的 **参考音频克隆音色 + 歌词整曲生成**
包成插件 `provider=custom` 的通用契约：

```
QQ 插件 ──POST /generate {lyrics,tags,seconds}──▶ FastAPI ──▶ ACE-Step
                                                        └──▶ ffmpeg ──▶ mp3 字节
```

| 文件 | 用途 |
| --- | --- |
| `server.py` | FastAPI 包装：`/health`、`/generate`、鉴权、单 GPU 串行锁、ffmpeg 转码 |
| `Dockerfile` | CUDA 12.8 + Python 3.11 + ACE-Step 源码 + 服务代码 |
| `docker-compose.yml` | 端口 8046、GPU 声明、`./ref:/ref`、模型缓存命名卷 |
| `README.md` | 本文 |
| `ref/` | 参考音频挂载点（`.gitignore` 已忽略内容，避免把音频入库） |

> 本服务只做「唱歌」这一件事，不提供 Gradio / 官方 REST API 的通用接口；
> 插件只会调 `POST /generate` 和人工调 `GET /health`。

---

## 1. 契约

### 1.1 `GET /health`

```json
{"ok": true, "model_loaded": false, "ref_loaded": true, "device": "cuda"}
```

- `model_loaded`：ACE-Step 的 DiT 与 LM 都加载完成才为 `true`。模型在启动时由后台
  线程加载，`/health` 立即可用（首次启动可能需要下载/加载权重）。
- `ref_loaded`：`SING_REF_DIR` 下能找到默认参考音频（`dafatyu.wav`）才为 `true`。
- `device`：实际使用的设备，`cuda` 或 `cpu`；申请了 `cuda` 但没有可用 GPU 时
  服务会自动回退并在这里显示 `cpu`（很慢，仅用于功能验证）。

### 1.2 `POST /generate`

与 `src/plugins/sing/index.ts:492-525` 的 `generateCustom` 完全一致：

```http
POST /generate
Authorization: Bearer <SING_API_KEY>
Content-Type: application/json

{"lyrics": "[Verse]\n...", "tags": "cute female vocal, pop", "seconds": 60}
```

成功：**`200`，响应体直接是音频字节**（`Content-Type: audio/mpeg`）。
格式固定为 **mp3 / 24 kHz / 单声道 / 24 kbps**，由 ffmpeg 从 ACE-Step 的
48 kHz 立体声中间产物转出。插件按文件头识别 mp3（`index.ts:66-75`），
本服务的 MP3 帧同步头（`FF Fx`）能通过该检查。

请求字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `lyrics` | string | 必填，非空；上限 10000 字符（插件自己先钳到 3000） |
| `tags` | string | 可选，风格描述；空则用 `SING_DEFAULT_TAGS`（默认 `cute female vocal, pop, bright`，与插件默认一致） |
| `seconds` | number | 可选，**钳到 10..120**；默认 60。同时作为 ACE-Step 的 `duration` |
| `ref` | string | 可选，`/ref` 下的文件名（可省略扩展名）；默认 `dafatyu` → `/ref/dafatyu.wav`。禁止路径分隔符与 `..` |

失败一律非 200 + `{"error": "..."}`（插件会从 `error` 字段取人话）：

| 状态 | `error` | 场景 |
| --- | --- | --- |
| 400 | 具体原因 | 歌词为空、JSON 非法、ref 不存在/越界、seconds 非数字 |
| 401 | `unauthorized` | 设置了 `SING_API_KEY` 但 Bearer 不匹配 |
| 413 | `请求体太大` | 超过 256 KiB |
| 503 | `busy` | 已有生成在跑（单 GPU 串行；拿不到锁立刻返回） |
| 503 | `模型还在加载...` | 权重尚未加载完成 |
| 503 | `模型加载失败：...` | 加载抛错（详见容器日志） |
| 500 | `ACE-Step 生成失败...` / `ffmpeg 转码失败...` | 生成或转码失败 |

并发语义：**同一时刻只跑一个生成**。服务用非阻塞锁，第二个请求立刻得到
`503 {"error":"busy"}`，不会排队堆积显存。插件一次只发一首，正常不会撞上。

---

## 2. 引擎调用形状（按 2026-10 调研实现）

`server.py` 里的调用与调研给出的最小示例逐项对应，关键来源：

```python
from acestep.handler import AceStepHandler
from acestep.llm_inference import LLMHandler
from acestep.model_downloader import ensure_lm_model
from acestep.inference import GenerationParams, GenerationConfig, generate_music

dit = AceStepHandler()
status, ok = dit.initialize_service(
    project_root="/app", config_path="acestep-v15-turbo", device="cuda",
    offload_to_cpu=True, offload_dit_to_cpu=True,
    quantization="int8_weight_only", prefer_source="modelscope")

# LM 权重不会由 LLMHandler 自动下载：先 ensure_lm_model(...)
ensure_lm_model("acestep-5Hz-lm-0.6B",
                checkpoints_dir="/app/checkpoints",
                prefer_source="modelscope")
llm = LLMHandler()
lm_status, lm_ok = llm.initialize(checkpoint_dir="/app/checkpoints",
               lm_model_path="acestep-5Hz-lm-0.6B",
               backend="vllm", device="cuda", offload_to_cpu=True)

params = GenerationParams(
    task_type="text2music",
    caption=tags,                 # 风格标签
    lyrics=lyrics,
    reference_audio="/ref/dafatyu.wav",   # 音色克隆
    duration=60.0,                # 10..120
    inference_steps=8,            # Turbo 推荐 8
    vocal_language="zh",
    thinking=True,                # 5Hz LM 规划
)
config = GenerationConfig(batch_size=1, audio_format="wav")
result = generate_music(dit, llm, params, config, save_dir="/tmp/sing-xxx")
# result.success / result.audios[0]["path"] / result.error
```

来源：`acestep/inference.py:110-140`、`docs/zh/INFERENCE.md:20-60`、
`acestep/handler.py:121`（固定 48 kHz）、
`acestep/core/generation/handler/io_audio.py:117-176`（参考音频归一化）。

调研里没有写死、由本包显式选择/修正的部分：

- `inference_steps=8` / `vocal_language="zh"` / `thinking=True`：来自调研示例；
  可用 `SING_INFERENCE_STEPS`、`SING_VOCAL_LANGUAGE` 覆盖。歌词是英文时
  可改成 `SING_VOCAL_LANGUAGE=unknown` 让 LM 自动识别。
- **返回值是元组**：核对上游源码后确认 `initialize_service` 与
  `LLMHandler.initialize` 都返回 `(status_message, success)`
  （`acestep/core/generation/handler/init_service_orchestrator.py:48-66`、
  `acestep/llm_inference.py:499-518`），本包按元组解包；失败时把
  `status_message` 写进加载异常，`/generate` 返回 503，细节看容器日志。
- **offload/量化必须显式传参**：`initialize_service` 自己**不读**
  `ACESTEP_OFFLOAD_TO_CPU` 等环境变量（那是官方 API/Gradio 启动层的逻辑）。
  本包读取 env 后以参数传入：`offload_to_cpu`、`offload_dit_to_cpu`、
  `quantization`、`prefer_source`。
- **权重自动下载**：`initialize_service(prefer_source=...)` 会 ensure
  DiT/VAE；LM 需要先 `ensure_lm_model(...)`（`LLMHandler.initialize` 只报
  “model not found”，不会下载，见 `acestep/llm_inference.py:588-590`）。
  `server.py` 两件事都做了，默认 `prefer_source=modelscope`。
- `GenerationParams` 字段名（`caption` / `reference_audio` / `duration` /
  `thinking`）按调研写死；上游改签名时服务会直接报错，不会悄悄唱错。

### 硬件与耗时口径（调研结论）

- RTX 3080 10GB 属于官方 **Tier 4（8–12 GB）**，只支持 2B DiT
  （`acestep-v15-turbo` 8 steps / `acestep-v15-sft` 50 steps），
  **不支持 XL (4B)**。
- Tier 4 预设：`offload_to_cpu`、`offload_dit_to_cpu`、INT8 权重量化、
  VRAM Guard 与自适应 VAE 分块。本包的 compose 已打开前三项。
- 30 s 曲目约 **4–6 s**，60 s 约 **8–12 s**（GPU Turbo，batch=1）。
- 纯 CPU 约 **3–15 分钟**，官方标注「仅用于功能测试」；`/health` 会显示
  `device: "cpu"`。

---

## 3. 参考音频怎么放

前序同事已产出 **`data/sing/ref/dafatyu.wav`**（插件仓库内，`data/` 不入库）。
实测该文件为 **20.0 s / 24 kHz / 单声道 / 16-bit PCM**。部署时拷进挂载卷：

```bash
cd docker/sing
mkdir -p ref
cp ../../data/sing/ref/dafatyu.wav ref/
ls -lh ref/                      # 应看到 dafatyu.wav
```

compose 把它只读挂到容器内 `/ref`；请求不带 `ref` 时服务读
`/ref/dafatyu.wav`。想换音色就把别的 10–30 秒干声放进同目录，请求里传
`"ref": "另一个文件名.wav"`（不能带路径）。

ACE-Step 对参考音频的处理（调研结论）：

- 支持 WAV / MP3 / FLAC / OGG / AAC 等；内部自动重采样为 48 kHz 立体声。
- 不足 30 秒会循环填充到 30 秒；超过 30 秒会在前/中/后各取 10 秒拼成 30 秒。
- 全静音或读不出的参考音频会被上游**丢弃**（`process_reference_audio` 返回
  `None`，日志 `Invalid or unsupported reference audio`），等于没有克隆音色；
  部署前务必试听一遍参考音频。
- 参考音频控制的是**全局音色/声学质感**；要控制旋律走向是另一个
  `src_audio + audio_cover_strength` 任务，本服务不暴露。
- 强烈建议先做人声分离：带伴奏的参考音频会污染音色。

---

## 4. 本地 Docker 起法

### 4.1 前置条件

- NVIDIA 驱动 + `nvidia-container-toolkit`，`docker run --gpus all` 可用；
- 显存 ≥ 10 GB（Tier 4 下限；XL 4B 需要 ≥ 12–20 GB，本包不用 XL）；
- 磁盘 ≥ 20 GB（镜像 + 权重 + 缓存）；
- Docker Compose v2。

### 4.2 第一次启动：权重自动下载

权重落在命名卷 `sing-models`（容器内 `/app/checkpoints`），重建镜像/容器不会重复下载。
`server.py` 启动时做两件事（已对照 ACE-Step 源码）：

1. `initialize_service(prefer_source=...)` 内部确保主模型 + DiT + VAE；
2. `ensure_lm_model(...)` 先取 0.6B LM，再 `LLMHandler.initialize`。

默认 `ACESTEP_DOWNLOAD_SOURCE=modelscope`。直接启动即可：

```bash
cd docker/sing
mkdir -p ref && cp ../../data/sing/ref/dafatyu.wav ref/
export SING_API_KEY='<自己生成的一串随机值>'   # 可选；生产必设
docker compose up -d --build
docker compose logs -f sing        # 首次会看到 [Model Download] 与加载日志
```

下载慢或失败时：

- 切 HuggingFace 源（走镜像）：`ACESTEP_DOWNLOAD_SOURCE=huggingface`（镜像已设
  `HF_ENDPOINT=https://hf-mirror.com`）；
- 或离线准备：本地下载好后塞进命名卷，再启动。compose 项目名是 `qqbot-sing`，
  卷名通常是 `qqbot-sing_sing-models`（以 `docker volume ls` 为准）：
  ```bash
  docker run --rm -v qqbot-sing_sing-models:/app/checkpoints \
    -v "<本地权重目录>:/src:ro" alpine sh -c 'cp -a /src/. /app/checkpoints/'
  ```
- 兜底：用官方 API 服务的一次性启动拉权重（调研给出的
  `--download-source modelscope`）：
  ```bash
  docker compose run --rm sing \
    python -m acestep.api_server --host 127.0.0.1 --port 8001 --download-source modelscope
  # 日志显示权重就绪后 Ctrl+C
  ```

> 本包在没有 GPU/权重的环境里没有跑过真实下载；上面的依据是上游源码里的
> `ensure_main_model` / `ensure_dit_model` / `ensure_lm_model` 与
> `initialize_service` 的 `prefer_source` 分支（2026-10 的 main 分支）。

### 4.3 启动

```bash
cd docker/sing
export SING_API_KEY='<自己生成的一串随机值>'   # 可选；生产必设
# 也可写进 docker/sing/.env（该文件已在 .gitignore 里），compose 会自动读取
docker compose up -d --build

# 首次加载可能要几分钟（后台线程加载，/health 先返回 200）
curl -fsS http://127.0.0.1:8046/health
# {"ok":true,"model_loaded":false,"ref_loaded":true,"device":"cuda"}  ← 还在加载
# {"ok":true,"model_loaded":true,"ref_loaded":true,"device":"cuda"}   ← 就绪

docker compose logs -f sing
```

GitHub 不通时，构建前指定镜像仓库：

```bash
docker compose build --build-arg ACESTEP_REPO=<可访问的 ACE-Step 仓库地址>
docker compose up -d
```

生产构建建议再把 `ACESTEP_REF` 固定到验证过的 tag/commit
（`--build-arg ACESTEP_REF=<tag 或 commit>`），避免上游 `main` 漂移。

### 4.4 冒烟测试

```bash
curl -fsS -X POST http://127.0.0.1:8046/generate \
  -H "Authorization: Bearer $SING_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"lyrics":"[Verse]\n小小的鱼儿游呀游\n[Chorus]\n唱一首歌给你听","tags":"cute female vocal, pop","seconds":30}' \
  -o /tmp/sing-test.mp3

file /tmp/sing-test.mp3            # 应为 MPEG audio
ffprobe -v error -show_entries \
  stream=codec_name,sample_rate,channels,bit_rate -of default=nw=1 /tmp/sing-test.mp3
```

预期：`mp3 / 24000 Hz / 1 channel / 24 kb/s` 左右。

---

## 5. 与插件 userConfig 的对应关系

插件设置（桌面端「插件 → 唱歌」）：

| 插件字段 | 填什么 | 说明 |
| --- | --- | --- |
| `provider` | `custom` | 未命中内置 preset 时都按 custom 处理（`index.ts:124-128`） |
| `baseUrl` | `http://<服务地址>:8046` | **只填到根**，插件自己拼 `/generate`；不要带尾斜杠或 `/generate` |
| `apiKey` | 与 `SING_API_KEY` 相同 | 插件对所有 provider 都要求非空（`index.ts:649-651`）；服务端没设 key 时也要填一个占位串 |
| `maxSeconds` | 建议 `60` | 插件先钳到 10..`maxSeconds`，服务端再钳 10..120 |
| `timeoutMs` | 默认 `300000` | GPU Turbo 一首 4–12 s，足够；107 排队/CPU 模式要加大 |
| `voiceId` / `refAudio` | 留空 | custom 分支不会把它们发给服务（`index.ts:492-525`），音色由服务端 `/ref` 决定 |
| `cooldownSeconds` / `dailyQuota` | 按需 | 自建无按次计费，可放宽 |

> 小提示：插件用 `estimateSeconds` 按 **128 kbps** 估 mp3 时长
> （`index.ts:109-119`），而本服务产物是 24 kbps，所以工具回复里的
> 「约 N 秒」会明显偏小（约 1/5）。只影响文案，不影响音频本身。

---

## 6. 部署到一〇七平台

「一〇七平台」指中科大本科生算力平台 <https://107.ustc.edu.cn/>。下面的结论
来自本包交付时读过的平台文档（overview / resources / jobs / slurm / cli /
environments / files / faq / quickstart / changelog）。

### 6.1 先看清平台模型：它是 Slurm 集群，不是容器平台

- 平台的核心使用方式是「登录节点准备文件和环境 → Slurm 提交作业 → 计算节点运行」
  （`overview/`）。登录节点不能跑重计算，GPU 任务要通过 `srun`/`sbatch` 申请。
- 默认分区 `Students`、默认 QOS `qos_stu_default`；默认配额 **4 CPU / 1 GPU / 4 h**
  （`basics/jobs/`、`basics/slurm/`）。更高资源走「资源申请」。
- 环境自行用 Miniconda 建，官方建议用中科大镜像源
  （`basics/environments/`）。
- **这些文档里没有 Docker / Singularity / Apptainer 的说明**，也没有端口映射/
  公网入口的承诺（SSH 入口也不保证，`basics/cli/` 明确说不要假设能 SSH）。
  因此：**不要假设计算节点能跑 `docker compose`**。本目录的 Docker 方案用于
  普通 GPU 主机/自管服务器；在 107 上走下面的「原生进程 + Slurm」路径。

### 6.2 在 107 上跑这个服务

**① 准备目录（Web Shell / VS Code 里）**

```bash
mkdir -p ~/projects/qqbot-sing/{logs,checkpoints,ref}
cd ~/projects/qqbot-sing
```

**② 上传代码**

平台访问 GitHub / HuggingFace 可能不稳定（`basics/files/`、`basics/faq/`），
建议本地准备好后打包上传：

- ACE-Step 源码目录 `ACE-Step-1.5/`（本地 `git clone` 后 `tar -czf` 上传）；
- 本目录的 `server.py`；
- 参考音频 `dafatyu.wav`；
- 权重文件（`checkpoints/`，同样建议本地/镜像下载后上传，不要指望正式作业里
  现场下载；文档明确不建议依赖运行时在线下载）。如果平台网络能访问
  ModelScope，首次启动也会自动下载（`ACESTEP_DOWNLOAD_SOURCE=modelscope`），
  但正式作业仍建议提前准备好。

**③ 建环境（登录节点做，按 `basics/environments/` 的镜像源）**

```bash
wget https://mirrors.ustc.edu.cn/anaconda/miniconda/Miniconda3-latest-Linux-x86_64.sh
bash Miniconda3-latest-Linux-x86_64.sh -b -p "$HOME/miniconda3"
~/miniconda3/bin/conda init bash && source ~/.bashrc

conda create -n acestep python=3.11 -y
conda activate acestep
pip config set global.index-url https://mirrors.ustc.edu.cn/pypi/web/simple
pip install uv
```

**④ 安装 ACE-Step（在计算节点或短作业里做）**

```bash
cd ~/projects/qqbot-sing/ACE-Step-1.5
export UV_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/web/simple
export HF_ENDPOINT=https://hf-mirror.com
uv sync --frozen --no-dev --python 3.11 || uv sync --no-dev --python 3.11
```

GPU 版 PyTorch 的 CUDA 版本按平台当前驱动选（`basics/environments/` 给了
`CONDA_OVERRIDE_CUDA` 的写法；不要机械照抄 12.4）。

**⑤ 放参考音频**

```bash
cp /path/to/dafatyu.wav ~/projects/qqbot-sing/ref/
```

**⑥ 用 sbatch 起服务**

`~/projects/qqbot-sing/scripts/sing.sbatch`（注意先 `mkdir -p logs`）：

```bash
#!/bin/bash
#SBATCH -J qqbot-sing
#SBATCH -p Students
#SBATCH --qos=qos_stu_default
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH -t 04:00:00
#SBATCH -o logs/%x-%j.out
#SBATCH -e logs/%x-%j.err
set -euo pipefail

source "$HOME/miniconda3/etc/profile.d/conda.sh"
conda activate acestep

export ACESTEP_ROOT="$HOME/projects/qqbot-sing/ACE-Step-1.5"
export ACESTEP_CHECKPOINTS_DIR="$HOME/projects/qqbot-sing/checkpoints"
export ACESTEP_CONFIG_PATH=acestep-v15-turbo
export ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-0.6B
export ACESTEP_LM_BACKEND=vllm
export ACESTEP_DOWNLOAD_SOURCE=modelscope
export ACESTEP_QUANTIZATION=int8_weight_only
export ACESTEP_OFFLOAD_TO_CPU=true
export ACESTEP_OFFLOAD_DIT_TO_CPU=true
export HF_ENDPOINT=https://hf-mirror.com
export SING_REF_DIR="$HOME/projects/qqbot-sing/ref"
export SING_REF_DEFAULT=dafatyu
export SING_PORT=8046
# Key 放个人文件，chmod 600，不要写进脚本/仓库
export SING_API_KEY="$(cat "$HOME/.config/sing-api-key")"

cd "$ACESTEP_ROOT"
nvidia-smi
exec uv run --no-sync python "$HOME/projects/qqbot-sing/server.py"
```

提交与查看：

```bash
mkdir -p ~/projects/qqbot-sing/logs
cd ~/projects/qqbot-sing
sbatch scripts/sing.sbatch
squeue -u "$USER"                 # PD=排队, R=运行
tail -n 100 logs/qqbot-sing-*.out
```

- **GPU 型号**：平台文档明确说 A100 / 5090 等型号与节点分布会变，提交前用
  `sinfo` / `scontrol show part` 或平台页面确认（`overview/resources/`）。
  本服务需要 ≥ 10 GB 显存；XL 4B 不要用。
- **作业时长**：默认 QOS 最长 4 h，到点服务随作业结束。需要长期在线时，
  按平台流程申请 `qos_stu_long`（文档示例：16 CPU / 1 GPU / 64G / 72h），
  或定时重新提交。
- **端口可达性（重要）**：107 文档没有承诺计算节点端口对外映射，也没有保证
  SSH。`http://<节点>:8046` 能否被 bot 访问取决于平台网络策略：
  - 若 bot 与计算节点在同一可达网段，直接用节点名/IP；
  - 若不在，需要平台管理员开通入口，或自建反向隧道——**这两条都超出本文档
    已核实的范围，部署前必须先确认**。不要假设 `localhost:8046` 在登录节点
    可用（服务跑在计算节点上）。
  - 节点名可从作业日志里的 `hostname` 或 `squeue`/`scontrol show job` 拿到。

### 6.3 为什么不直接搬 compose 到 107

| Docker 方案 | 107 平台 |
| --- | --- |
| `docker compose up` + GPU 声明 | Slurm 申请 GPU，进程直接跑在计算节点 |
| 命名卷持久化权重 | 共享存储（`~/projects/.../checkpoints`） |
| compose 端口映射 | 平台不保证端口映射/公网入口 |
| 镜像内 Python 3.11 | conda 环境 + `uv sync` |
| `restart: unless-stopped` | 作业结束即停止，按 QOS 时长运行 |

所以 107 上把 `server.py` 当普通 Python 进程跑即可；Docker 相关文件只在
自管 GPU 主机上使用。

### 6.4 实测结论（2026-10-26）：今天不能交付可常驻调用的服务

本节是交付后在宿舍网 Windows 机器上实际尝试登录/部署的记录，**不是推测**。
结论：**平台统一身份密码有效，但被短信二次验证挡住；即使通过认证，107 的机制
也只允许最长 4 小时的 Slurm 作业，计算节点没有公网/校园网入口，且 SCOW 代理只认
Cookie `SCOW_USER`；插件 custom 分支只发 `Authorization: Bearer`、不发 Cookie
（`src/plugins/sing/index.ts:503`）。因此没有「随叫随到、24h 常驻」的部署形态。**

实测记录：

| 通道 | 结果 | 证据 |
| --- | --- | --- |
| 统一身份认证 | 账号密码有效，随后进入「二次身份验证」：短信验证码 / 动态口令 / 邮件验证码，绑定手机 `****9527`，页面无跳过项 | Playwright 走 `https://107.ustc.edu.cn/auth/public/ustc/oauth/start`；CAS 提交后 URL 变为 `https://id.ustc.edu.cn/cas/login?service=...codecallback&t=...`，BODY 含「二次身份验证…已绑定手机号：*******9527」 |
| 平台本地登录 | 同一账号 + 验证码提交后返回「密码无效，请重新输入」→ SCOW 本地密码与统一身份密码不通用 | `POST https://107.ustc.edu.cn/auth/public/scowAuth`（Playwright 表单提交，SVG 验证码已解） |
| SSH | `107.ustc.edu.cn:22` 实际开放（`SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.14`），但只允许 `publickey`；本机 `~/.ssh/id_ed25519` 未被平台接受 | `ssh -i ~/.ssh/id_ed25519 -o BatchMode=yes <学号>@107.ustc.edu.cn hostname` → `Permission denied (publickey)`；paramiko 返回 `allowed types: ['publickey']` |
| 作业配额 | 默认 QOS `qos_stu_default`：4 CPU / 1 GPU / 16G / **4h** | 平台文档 `basics/jobs/`、`overview/resources/` |
| 登录节点 | 无 GPU，禁止常驻重进程 | 平台文档 `overview/`、`basics/cli/` |
| 计算节点 | 私网，无公网/校园网可路由入口；平台未公布端口映射 | 平台文档 + 本次网络探测 |
| SCOW 代理 | 只从 Cookie 取 token：`TOKEN_KEY = "SCOW_USER"`；`checkCookie()` 用 `parseCookies` | OpenSCOW 源码 `apps/portal-web/src/auth/cookie.ts:17`、`auth/server.ts:24`、`apps/portal-web/src/pages/api/proxy/.../[[...path]].ts` |
| 插件契约 | custom 分支只发 `content-type` + `authorization: Bearer`，不发 Cookie | `src/plugins/sing/index.ts:503` |

#### 主人日后续接步骤（三条通道，按推荐顺序）

**① SSH 公钥通道（推荐）**

1. 主人浏览器登录 <https://107.ustc.edu.cn/>，自己完成统一身份二次验证；
2. 在平台的 SSH/密钥设置里加入本机公钥（整行，来自 `~/.ssh/id_ed25519.pub`）：
   ```
   ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJEdiA1E2k9V1J1AYNXG6uvwL1MViYawJQG021KyCaM/
   ```
3. 本机验证：`ssh -i ~/.ssh/id_ed25519 <学号>@107.ustc.edu.cn 'hostname; sinfo -s'`；
4. 用 `rsync`/`scp` 上传 `server.py`、`dafatyu.wav`、ACE-Step 源码与权重；
5. `sbatch scripts/sing.sbatch`，`squeue -u $USER` 拿计算节点名；
6. **本机端口转发**：`ssh -i ~/.ssh/id_ed25519 -N -L 8046:<计算节点>:8046 <学号>@107.ustc.edu.cn`，
   然后本机 `curl http://127.0.0.1:8046/health`，插件 `baseUrl` 填 `http://127.0.0.1:8046`。
   前提是登录节点 sshd 允许 `AllowTcpForwarding`——登记公钥后先测；不允许就只能走下面的 relay 方案；
7. **4h 续作业**：本机 watcher 每 60s 探 `/health`；失败就 SSH 重新 `sbatch`、从
   `squeue --format=%N` 取新节点、重建 `ssh -L`。权重在共享存储，重启只重新加载，不重新下载。
   这是这些限制下最接近「常驻」的架构：**作业在跑时本机可达，4h 边界有短暂中断**。

**② SCOW 本地密码通道**

1. 主人把平台「账号密码登录」的密码（不是统一身份密码）写进
   `data/secrets.ustc.json` 的 `scowPassword` 字段（`data/` 已被 `.gitignore` 忽略，不会入库）；
2. 重试本地登录：`POST https://107.ustc.edu.cn/auth/public/scowAuth`，带
   `username` / `password` / `code` 与隐藏域 `token`、`callbackUrl`；`code` 来自
   `/auth/public/refreshCaptcha` 的 SVG 验证码（仍需人工或 OCR）；
3. 成功后拿到 `SCOW_USER` Cookie，可调 SCOW API/代理；但插件仍不能带 Cookie，
   需要在 bot 与本机之间加一个 relay（见下）。

**③ 短信验证码协作**

1. 主人坐在键盘前时告知，我们先在 CAS 二次验证页点「获取验证码」，短信发到 `****9527`；
2. 主人在 5 分钟内把 6 位码发回；脚本在**同一浏览器会话**里填入并勾选
   「信任此设备」提交；
3. 成功后保存 `SCOW_USER` Cookie。注意：Cookie 会过期，且每次应用/作业的节点与端口会变，
   只适合临时调试，不适合生产。

#### 这些限制下最可行的架构

- **首选：sbatch 作业 + 本机 `ssh -L` 隧道**（见 ①）。服务跑在计算节点，
  本机 `127.0.0.1:8046` 可达，插件无需改代码；代价是 4h 续作业与短暂中断。
- **备选：SCOW 代理 + 本机 relay**。relay 转发时加 `Cookie: SCOW_USER=<token>`，
  插件 `baseUrl` 指向 relay；但代理 URL 随节点/端口变化，Cookie 会过期，且需要额外常驻进程。
- **不建议**：把服务跑在登录节点（平台红线，且无 GPU）；把 `SCOW_USER` 直接填进插件
  ——插件 custom 分支不会发 Cookie，必须改插件代码（本次未改，留作后续建议）。

> 结论：107 适合课程作业与离线训练，不适合作为 QQ bot 的 24h 在线推理后端。
> 要「随叫随到」，优先本机独显或公网 GPU 主机；107 只能作为临时演示。

---

## 7. 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `/health` 一直 `model_loaded:false` | 后台仍在加载；`docker compose logs -f sing` 看进度。若日志有 `加载失败`，多为权重缺失/路径不对 |
| `ref_loaded:false` | `ref/dafatyu.wav` 没放或文件名不符；请求里传的 `ref` 不能带路径 |
| `503 busy` | 上一首还在生成；单 GPU 设计为串行，稍后重试。插件超时默认 300 s |
| `401 unauthorized` | `SING_API_KEY` 与插件 `apiKey` 不一致（注意首尾空格） |
| `CUDA out of memory` | 确认 `ACESTEP_OFFLOAD_TO_CPU/DIT_TO_CPU=true`；不要换 XL 4B；关闭其他占卡进程 |
| 生成很慢（分钟级） | `/health` 的 `device` 是 `cpu`：没有可用 GPU 或驱动未透传 |
| `ffmpeg 转码失败` | 镜像里缺 ffmpeg 或被替换；`docker compose run --rm sing ffmpeg -version` 检查 |
| 工具回复时长明显偏小 | 插件按 128 kbps 估算 24 kbps 产物（见 §5），只是文案问题 |
| 107 上 `curl` 连不上 | 服务在计算节点，端口未被平台暴露；见 §6.2 的可达性说明 |

安全：

- 本文与所有文件**不包含任何真实密钥字面量**；`SING_API_KEY` 只从环境变量/
  宿主 `.env` 读取。
- 端口 8046 暴露到公网时务必设置 `SING_API_KEY`，并放在反向代理/防火墙后。
- 参考音频是个人生物特征数据，`ref/` 已在 `.gitignore` 中忽略，不要入库。

---

## 8. 本包验证范围（诚实记录）

- 已执行：
  - `python -m py_compile docker/sing/server.py` 通过；
  - 用桩 ACE-Step 模块跑 FastAPI TestClient 契约测试 **37 项全过**：`/health`
    字段与加载状态、Bearer 鉴权 401、非法 JSON / 空歌词 / 非法 seconds /
    路径穿越 ref / 缺失 ref 的 400、`seconds` 10/120 钳制、默认 tags、默认/显式
    ref、`GenerateParams`/`GenerationConfig` 实际入参、初始化参数
    （GPU 下 offload/量化/prefer_source；CPU 下自动关闭量化与卸载）、
    `503 {"error":"busy"}`、生成失败 500、模型未加载 503；
  - 用真实 ffmpeg（portable build）把一个 48 kHz 立体声 WAV 转成 mp3，
    ffmpeg 自报 **24000 Hz / mono / 24 kb/s**，时长 3.05 s；产物带 ID3 头，
    能通过插件 `sniffAudioMime` 的 mp3 判定；
  - `docker compose config` 解析通过；`docker build --check` 无警告；
  - 对照上游 ACE-Step `main` 分支（`ca1e85f`）源码核对了
    `initialize_service` / `LLMHandler.initialize` / `ensure_lm_model` /
    `GenerationResult` 的真实签名与返回结构（见 §2 引用）。
- 未执行：
  - 完整的 `docker build`（需要拉取数 GB 依赖并克隆 ACE-Step）；
  - 真实 ACE-Step 推理（本机无 GPU、无权重）；
  - 107 平台实机运行与端口可达性验证。
  这些需要部署环境完成，失败时按 §7 定位。
