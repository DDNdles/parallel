# 唱歌插件：参考音色与云服务接入指南

> 适用版本：`sing` 1.0.0（调研口径 2026-10）
> 插件代码：`src/plugins/sing/index.ts` · 参考音频脚本：`scripts/sing/prepare-ref.mjs`
> 桌面端入口：**插件 → 唱歌 → 可配置项**（`web/src/components/pages/PluginsPage.tsx:211-259`）

本插件不自带模型、不自带音色：你把**自己的云 API Key** 和**一份参考音频**填进插件设置，bot 把歌词送到云服务，拿回音频字节后作为 `record` 段直接发进当前会话（`src/plugins/sing/index.ts:1-31`）。

---

## 0. 先看结论

| 内置 preset | 服务 | 音色怎么给 | 需要填 `voiceId` 吗 | 适合谁 |
| --- | --- | --- | --- | --- |
| `fal-ai-ace-step`（默认） | fal.ai 托管的 ACE-Step | `refAudio`：每次请求带参考音频 | **不需要，留空** | 所有人；目前唯一真正打通「参考音频克隆 + 歌词演唱」的商业云 API |
| `minimax-music` | MiniMax 音乐生成 | `refAudio`：整曲音频做翻唱 | **不需要，留空** | 仅 2026-08-20 前已开通音乐接口的付费老用户 |
| `custom` | 你自部署的 `/generate` | 由你的服务自己决定 | **不会发给服务，填了也没用** | 有 GPU / 自建 ACE-Step 或包装服务的人 |

> **重要纠正**：三个内置 preset 都**没有**「先在控制台建一个 voice_id，再填进插件」的模式。调研结论已经确认：ACE-Step 是每次请求带参考音频；MiniMax 的 `voice_id` 只用于 TTS 朗读，音乐接口不吃；`custom` 的音色由服务端自己管。插件里的 `voiceId` 是一个通用占位字段，对当前三个 preset 请保持空字符串，把音频放进 `refAudio`（`src/plugins/sing/index.ts:331-346`）。
>
> `plugin.json` 里 `voiceId` 的那段描述是通用占位说明；本版本实际代码没有为任何内置 preset 实现持久 voice_id 复用，以本指南和代码为准。如果你在别处看到「建音色 → 填 voice_id」的教程，那通常是给 TTS（如 Fish Audio）用的，不能直接套到本插件的唱歌 preset 上。

最短路径：

1. 跑 `scripts/sing/prepare-ref.mjs`，得到 `data/sing/ref/dafatyu.wav`；
2. 按第 2 节在 fal.ai 注册、建 API Key；
3. 插件设置里填 `provider=fal-ai-ace-step`、`apiKey=<你的 FAL_KEY>`、`refAudio=<dafatyu.wav 的绝对路径>`；
4. 在 QQ 里对大肥鱼说「唱一段」。

---

## 1. 参考音色：用 `prepare-ref.mjs` 从 B 站视频提取

### 1.1 命令

```bash
# 在仓库根目录执行
node scripts/sing/prepare-ref.mjs
```

默认等价于：

```bash
node scripts/sing/prepare-ref.mjs --start 30 --dur 20
```

产物：

```text
data/sing/ref/dafatyu.wav
```

`data/` 已在 `.gitignore` 里（`.gitignore:9`），这个 wav 不会进 git。

### 1.2 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--url <URL>` | `https://www.bilibili.com/video/BV1fYpn6SEk9` | 视频地址或 `BV` 号 |
| `--part <N>` | 不指定 | 多 P 视频的分 P，例如 `--part 1` |
| `--start <秒>` | `30` | 截取起点 |
| `--dur <秒>` | `20` | 截取时长（脚本限制 5~60 秒；参考音色建议 10~30 秒） |
| `--out <路径>` | `data/sing/ref/dafatyu.wav` | 输出 wav；必须位于仓库目录内；相对路径按当前工作目录解析，父目录自动创建 |
| `--force` | 关 | 输出已存在时覆盖；默认拒绝，避免误覆盖已经挑好的干声 |
| `-h`, `--help` | — | 打印完整用法 |

脚本全部在 Docker 里执行，本机不需要 ffmpeg / yt-dlp / Python：

- 首次运行自动构建镜像 `qqbot-sing-prepare-ref:1`：`python:3.12-slim` + `apt-get install ffmpeg` + `pip install yt-dlp`；之后复用；
- 容器内用 `yt-dlp -f "ba"` 下载最佳音质音频流；
- `ffmpeg` 按 `--start/--dur` 截段，转成 **单声道 24000 Hz 16-bit PCM WAV**；
- 最后容器内 `ffprobe` 校验采样率与声道数，失败会明确报错。

脚本不读取、不保存任何账号 Cookie；只尝试公开视频的免登录下载。遇到 B 站风控要求登录时会如实报错，不会伪造凭据。

### 1.3 本次实际跑出来的结果

实际执行：

```bash
node scripts/sing/prepare-ref.mjs
```

结果（`ffprobe` 复核）：

```text
codec_name=pcm_s16le
sample_rate=24000
channels=1
bit_rate=384000
duration=20.000000
size=960078
```

**最终取的是 `30.0s–50.0s` 区间。** 为了确认 30 秒处不是前奏/纯伴奏，本次用 `faster-whisper`（`base` 模型、`zh`）对原始视频和 20 秒切片做了转写：0 秒起就有人声，30–50 秒覆盖「和那目中 / 无人的神情 / 这无法无天的心情 / 是从小时 / 难道说…」等连续唱段，因此保留脚本默认的 `--start 30 --dur 20`。

> **注意：脚本产出是原视频的混音切片，不是纯人声干声。** 该视频是翻唱，伴奏仍在。调研结论明确指出：带伴奏的音频会污染 ACE-Step 提取的 Speaker Embedding，生成结果可能出现金属杂音或走音。要追求最佳音色，请先用 **UVR5（Ultimate Vocal Remover）或 Demucs** 分离出 `vocals` 轨，再把分离后的 10~30 秒人声切片填进插件的 `refAudio`——插件本身不内置人声分离模型，`prepare-ref` 只负责下载、截段和转码。

### 1.4 把音频交给插件

`refAudio` 支持以下写法（`src/plugins/sing/index.ts:267-329`）：

| 写法 | 示例 | 说明 |
| --- | --- | --- |
| 绝对路径（推荐） | `C:\...\parallel\data\sing\ref\dafatyu.wav` | 最不容易被工作目录影响 |
| 仓库相对路径 | `data/sing/ref/dafatyu.wav` | bot 从仓库根目录启动时可用；插件先按 `pluginDataDir` 解析，再按进程 cwd 解析（`index.ts:289-292`） |
| 公网 URL | `https://你的对象存储/.../dafatyu.wav` | 适合 ACE-Step；国内服务器建议对象存储走可访问的域名 |
| data URI / 原始 base64 | `data:audio/wav;base64,...` | 插件会解码校验；大文件会让请求体变大，不推荐 |

限制：

- 支持 mp3 / wav / ogg / m4a / aac / flac；
- 文件上限 **20 MB**（`REF_MAX_BYTES`，`index.ts:42`）；
- 参考音色建议 10~30 秒、发音清晰、尽量少伴奏。

`voiceId` 的处理：

- `refAudio` 优先；只有 `refAudio` 为空时才会尝试 `voiceId`；
- 对 ACE-Step / MiniMax，`voiceId` 也会被当作**音频来源**解析；填一个真正的克隆 id 会得到「当前唱歌供应商不支持复用克隆音色 id，请把 10~30 秒纯净干声填进 refAudio」；
- 所以当前三个 preset 都请把 `voiceId` 留空。

---

## 2. 内置 preset：`fal-ai-ace-step`（默认，推荐）

### 2.1 为什么默认选它

调研结论（2026-10）：目前商业云 API 中，真正打通「输入参考音频克隆音色 + 输入歌词 → 生成带编曲旋律的整曲人声演唱」的，只有 ACE Studio 与阶跃星辰联合开源的 ACE-Step。fal.ai 提供托管版，异步队列、按秒计费，中文支持好。

- 模型页：<https://fal.ai/models/fal-ai/ace-step/audio-to-audio>
- API 文档：<https://fal.ai/models/fal-ai/ace-step/audio-to-audio/api>
- ACE-Step 论文：<https://arxiv.org/html/2506.00045v1>
- 供应商对比（调研来源）：<https://fal.ai/learn/tools/best-text-to-music-apis-2026>

### 2.2 注册与拿 API Key

1. 打开 <https://fal.ai/>，用 GitHub 或 Google 账号登录（个人即可，无需企业资质）。
2. 进入 Dashboard → **API Keys** → 新建 Key。
3. 复制 Key，填进插件设置：

| 设置项 | 填什么 |
| --- | --- |
| `provider` | `fal-ai-ace-step` |
| `apiKey` | 你的 `FAL_KEY`（只填到插件里，不要写进仓库、README 或聊天记录） |
| `voiceId` | **留空**（ACE-Step 没有可复用的 voice_id） |
| `refAudio` | `dafatyu.wav` 的绝对路径，或公网 URL |
| `baseUrl` | 留空用官方地址；国内直连不稳时填代理/网关（见 2.5） |

插件里 `apiKey` 是 `secret: true`，会存进 `data/secrets.json`，桌面端不回显（`src/kernel/config.ts:315-356`；`web/src/components/pages/PluginsPage.tsx:233-259`）。

### 2.3 用 `dafatyu.wav` 建音色：不需要建 voice_id

ACE-Step 属于「每次请求带参考音频」的模式：

- 请求体里的 `audio_url` 可以是**公网 URL**，也可以是 **base64 Data URI**；
- 模型每次从参考音频提取 512 维 Speaker Embedding 作为条件注入；
- 没有控制台「创建音色」步骤，也没有可复用的 `voice_id`。

所以：

- 用 `prepare-ref` 产出 `dafatyu.wav` 后，直接把路径填进 `refAudio`；
- 插件会把本地文件读成 `data:audio/wav;base64,...` 塞进 `audio_url`（`src/plugins/sing/index.ts:376-397`）；
- 如果你的部署更希望传 URL，把 wav 传到公网对象存储（OSS/COS/S3 等），把 URL 填进 `refAudio` 即可；
- **不要把 `voiceId` 填成 fal 的 request id 或任何字符串**，它不会生效，反而会报「不支持复用克隆音色 id」。

参考音频要求（调研结论 + 官方 API）：

- 格式：mp3、wav、ogg、m4a、aac；
- 建议 10~30 秒纯净干声；通过人声分离去掉伴奏；
- 单声道或立体声均可；
- 中文、日语、英语等多语言发音由 ACE Studio 歌声引擎优化。

### 2.4 计费、免费额度、国内直连

| 项目 | 调研结论（2026-10，最终以 fal 官网为准） |
| --- | --- |
| 计费 | **$0.0002 / 生成音频秒数**；约 **$0.012 / 分钟**；1 美元约合成 5000 秒（约 83 分钟） |
| 单曲成本 | 一首 2 分钟的歌约 **$0.024**，约 **¥0.17**（按调研汇率估算） |
| 免费额度 | **没有永久免费额度**；新注册账号偶尔赠送 $1~$5 试用金 |
| 国内直连 | fal.ai 节点在海外，国内服务器直连有几率被墙或高延迟；建议挂海外代理，或用 Cloudflare Worker 转发 |
| 个人门槛 | 极低：GitHub / Google 登录即可注册并获取 Key；充值需绑定海外信用卡 |

来源：

- <https://fal.ai/learn/tools/best-text-to-music-apis-2026>
- <https://fal.ai/models/fal-ai/ace-step/audio-to-audio/api>

### 2.5 请求长什么样（排错用）

插件实际发出的请求（`src/plugins/sing/index.ts:375-453`）：

```http
POST https://queue.fal.run/fal-ai/ace-step/audio-to-audio
Authorization: Key $FAL_KEY
Content-Type: application/json
```

```json
{
  "audio_url": "data:audio/wav;base64,<dafatyu.wav 的 base64>",
  "tags": "cute female vocal, pop, bright",
  "original_tags": "cute female vocal, pop, bright",
  "lyrics": "[verse]\n今天天气真好大肥鱼在游水\n[chorus]\n人是猫 人是猫 喵喵喵",
  "edit_mode": "lyrics",
  "guidance_scale": 15,
  "lyric_guidance_scale": 1.5
}
```

要点：

- 官方 OpenAPI 把 `original_tags` 标成**必填**（调研结论里漏了它）；插件用目标 `tags` 兜底传入（`index.ts:386-397`）。
- `edit_mode: "lyrics"` 表示按新歌词替换人声；`lyrics` 支持 `[verse]`、`[chorus]`、`[bridge]` 等结构标签。
- 没有 `seconds` 字段：歌多长由歌词和参考音频决定，所以插件设置里的 `maxSeconds` 对 fal 不生效，工具参数 `seconds` 也会被忽略。
- 流程是异步队列：提交 → 轮询 `status_url` → 请求 `response_url` → 下载 `audio.url`。插件已经封装好，正常不需要手写轮询。

**用代理/网关时注意**：`baseUrl` 会把提交地址改成 `{baseUrl}/fal-ai/ace-step/audio-to-audio`（`index.ts:381-384`）。但插件会优先使用提交响应里的 `status_url` / `response_url`（`index.ts:414-421`），如果代理不重写这两个字段，轮询会绕回 fal 官方域名，国内仍然不通。稳妥做法是让代理同时转发/重写这三个地址，或在代理层把 `status_url`、`response_url` 改写成自己的域名。

---

## 3. 内置 preset：`minimax-music`（仅老用户，整曲翻唱）

### 3.1 服务关停预警

MiniMax 官方文档明确公告：

> 自 **2026 年 8 月 20 日**起，付费接口（音乐生成、歌词生成）不再面向新用户提供服务，历史付费用户可继续使用现有 API 服务；免费音乐生成接口（Music-3.0-free、Music-2.6-free、music-cover-free）停止服务。

来源：

- <https://platform.minimaxi.com/document/music_generation>
- <https://platform.minimaxi.com/docs/api-reference/music-generation.md>

**新个人用户已经无法开通音乐生成 API。** 如果你不是 2026-08-20 前已付费的老用户，请直接选第 2 节的 ACE-Step，不要在这个 preset 上浪费时间。

### 3.2 注册与拿 API Key（仅老用户）

1. 打开 <https://platform.minimaxi.com/>，手机号注册并完成实名（个人可注册）。
2. 控制台 → **API Keys** → 创建/复制 Key。
3. 插件设置：

| 设置项 | 填什么 |
| --- | --- |
| `provider` | `minimax-music` |
| `apiKey` | 你的 MiniMax 开放平台 Key |
| `voiceId` | **留空**（音乐接口不支持 TTS 的 voice_id） |
| `refAudio` | `dafatyu.wav` 的本地路径，或公网 URL |
| `baseUrl` | 留空走 `https://api.minimax.cn`；填了则走 `{baseUrl}/v1/music_generation` |

### 3.3 为什么不能填 `voiceId`

这是 MiniMax 最容易误解的地方：

1. 开放平台的**声音快速复刻**接口（`POST /v1/voice_clone`）生成的 `voice_id`，只供语音大模型（T2A/TTS 朗读，如 `speech-2.6/2.8`）调用，**不能跨进音乐模型**。
2. 音乐模块的 `music-cover` 接受的是**整首歌曲音频**（`audio_url` 或 `audio_base64`，或两步流程里的 `cover_feature_id`），做的是曲风翻唱/改词，**不是提取单一音色唱新歌**。

所以：`dafatyu.wav` 在这里是「翻唱参考音频」，不是「克隆音色样本」。插件会把本地文件转成 `audio_base64`，或直接把公网 URL 作为 `audio_url`（`index.ts:456-490`）；`voiceId` 留空。

参考音频与歌词限制（官方文档）：

- 参考音频时长 6 秒 ~ 6 分钟，大小最大 50 MB，支持 mp3、wav、flac 等；
- 歌词用换行分隔，支持 `[Intro]`、`[Verse]`、`[Pre Chorus]`、`[Chorus]`、`[Bridge]`、`[Outro]` 等标签；
- `prompt`（插件里的 `tags`）官方要求 10~300 字符；`lyrics` 官方要求 10~1000 字符（插件自身允许到 3000，但 MiniMax 会按自己的上限报错）。

来源：

- <https://platform.minimaxi.com/docs/api-reference/music-generation.md>
- <https://platform.minimax.cn/docs/guides/speech-voice-clone>

### 3.4 计费与国内直连

| 项目 | 调研结论（2026-10，以官网为准） |
| --- | --- |
| 计费 | 旧付费用户按次计费，约 **0.2 元/次** |
| 免费额度 | 免费音乐生成接口已停止服务；新用户无法开通付费音乐接口 |
| 国内直连 | `api.minimax.cn` 节点在国内，速度极快、延迟低 |
| 个人门槛 | 手机号 + 实名即可注册；但新个人用户已被禁止开通音乐生成 API 权限 |

### 3.5 请求形状

```http
POST https://api.minimax.cn/v1/music_generation
Authorization: Bearer $MINIMAX_API_KEY
Content-Type: application/json
```

```json
{
  "model": "music-cover",
  "prompt": "二次元流行, 欢快, 电子萌系",
  "lyrics": "[verse]\n人是猫 人是猫\n[chorus]\n喵喵喵",
  "audio_url": "https://example.com/dafatyu.wav",
  "output_format": "url"
}
```

响应是同步直出：`data.audio` 是 24 小时有效的下载 URL；插件下载后再发进会话（`index.ts:456-490`）。如果本地文件不是公网 URL，插件会改用 `audio_base64`。

---

## 4. 内置 preset：`custom`（自部署通用 `/generate`）

### 4.1 什么时候用

- 你自己在 GPU 机器上部署了 ACE-Step，或写了一个包装服务；
- 你不想把参考音频/歌词发给第三方云；
- 你需要接一个内部网关，把多家供应商统一成同一个契约。

### 4.2 插件设置

| 设置项 | 填什么 |
| --- | --- |
| `provider` | `custom` |
| `baseUrl` | **必填**，例如 `http://127.0.0.1:8080` |
| `apiKey` | 你的服务要求的 Bearer Token；插件对**所有** provider 都要求非空（`index.ts:649-651`），即使服务不校验，也要填一个占位串 |
| `maxSeconds` | 单次 `seconds` 上限，实际钳到 10~120；默认 60 |
| `voiceId` / `refAudio` | **不会发送给服务**，留空即可 |

### 4.3 契约

插件会发：

```http
POST {baseUrl}/generate
Authorization: Bearer <apiKey>
Content-Type: application/json
```

```json
{
  "lyrics": "[verse]\n...",
  "tags": "cute female vocal, pop, 120bpm",
  "seconds": 60
}
```

服务必须**直接返回音频字节**（`audio/mpeg` 或 `audio/wav`），不能返回 JSON 包装。插件按文件头识别 mp3/wav；返回 JSON 错误文本会被当成「不是 mp3/wav 音频」（`index.ts:492-525`、`711-719`）。

`seconds` 的来源：工具参数优先；没给就用 `maxSeconds`；最终钳到 10~120。

### 4.4 `dafatyu.wav` 放哪

`custom` 分支**不会**把 `refAudio` / `voiceId` 发给服务（`generateCustom` 只发 `lyrics/tags/seconds`，`index.ts:492-525`）。所以：

- 把 `dafatyu.wav` 放到你的服务能读到的地方（例如 ACE-Step 的参考音频目录、对象存储、服务配置项）；
- 在服务端用它做音色条件；
- 插件设置里的 `refAudio` 对 `custom` 不生效，不要指望填了就会传过去。

### 4.5 计费

没有云厂商账单：成本是你的 GPU / 主机 / 电费；没有「免费额度」概念。若你用 Hugging Face 的免费 Space 作为后端，见 5.1 的稳定性说明。

---

## 5. 调研过但不内置的供应商（避免踩坑）

### 5.1 Hugging Face Space：ACE-Step v1.5

- 地址：<https://huggingface.co/spaces/ACE-Step/Ace-Step-v1.5>
- 免费（ZeroGPU 赞助），但有每日动态 GPU 配额；公共 Space 经常排队几十人甚至超时崩溃，不适合要求 SLA 的聊天机器人生产场景。
- Hugging Face 域名国内已被墙，必须配置海外 HTTP 代理。
- 每次调用通过 Gradio `handle_file` 上传参考音频，没有持久化 voice_id；可以用 `gradio_client` 调，但 Gradio SSE 不稳定。
- 如果你想用它，建议自己包一层 HTTP 服务，再按第 4 节 `custom` 接入；不要让 bot 直接依赖公共 Space 的队列。

### 5.2 Fish Audio

- **本质是 TTS 语音合成，不是音乐生成。** 没有 `[verse]` / `[chorus]` 结构，也没有伴奏、音高和旋律控制；加 `[singing]` 或 `(singing)` 只会在念白上做唱腔，不能算唱歌。
- 有 voice_id：可以在控制台上传，或 `POST https://api.fish.audio/model` 创建，之后在 `/v1/tts` 里作为 `reference_id` 使用；也支持每次请求用 `references` 传参考音频。
- 计费：**$15.00 / 100 万 UTF-8 字节**；有 `s2.1-pro-free` 免费模型（严格限速）。S1 模型官方已标记废弃，计划 2026-12-31 下线。
- 所以本插件不内置 Fish Audio；它解决不了「用自定义音色唱歌」的需求。

来源：

- <https://docs.fish.audio/features/voice-cloning>
- <https://docs.fish.audio/api-reference/endpoint/model/create-model>
- <https://docs.fish.audio/developer-guide/best-practices/emotion-control>
- <https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits>
- <https://docs.fish.audio/developer-guide/models-pricing/deprecations>

### 5.3 火山引擎

- **歌唱合成（MemeSong）**：只支持 15 秒以内的内置固定伴奏模板（《新年好》《找朋友》《洋娃娃和小熊跳舞》等），输入任意文本会被算法强行断句对齐模板；只有 3 个系统预设发音人，不支持外部复刻音色。
- **豆包语音声音复刻（1.0 / 2.0）**：可以上传 10~15 秒音频拿到 `speakerid`，但只供 TTS 朗读使用，无法驱动歌唱。
- **人声歌曲生成（GenSongV4）**：只支持预设 Timbre 枚举，没有克隆音频入口。
- 计费：声音复刻 **8 元/万字符**；歌唱合成有 **1000 次免费调用**（自开通起 3 个月），超出 **5~5.5 元/千次**。
- 国内机房直连很快，但功能不满足「自定义音色唱完整歌」，所以不内置。

来源：

- <https://docs.volcengine.com/docs/Audiotechnology/Interfacedescription-7>
- <https://www.volcengine.com/docs/DoubaoVoice/Soundreplicationorderingandusageguide>
- <https://www.volcengine.com/docs/6489/447836>
- <https://www.volcengine.com/docs/DoubaoVoice/Billinginstructions-21>

### 5.4 供应商对比

| 供应商 | 计费 | 免费额度 | 国内直连 | 自定义音色唱歌 |
| --- | --- | --- | --- | --- |
| fal.ai ACE-Step | $0.0002/秒，约 $0.012/分钟 | 无永久免费；新号偶尔 $1~$5 | 海外节点，建议代理 | ✅ 参考音频零样本 |
| MiniMax 音乐 | 旧付费用户约 0.2 元/次 | 免费接口已停；新用户不可开通 | 国内节点，快 | ❌ 整曲翻唱，不吃 voice_id |
| 自部署 ACE-Step / custom | 自己的 GPU/主机成本 | 无（自建） | 取决于部署 | ✅ 由你的服务决定 |
| HF ACE-Step Space | 免费（ZeroGPU） | 每日动态配额 | 被墙，需代理 | ✅ 但公共队列不稳定 |
| Fish Audio | $15/100 万 UTF-8 字节 | `s2.1-pro-free` 限速 | 海外，延迟较高 | ❌ 只是 TTS |
| 火山引擎 | 复刻 8 元/万字符；歌唱 5~5.5 元/千次 | 歌唱 1000 次/3 个月 | 国内，快 | ❌ 固定 15 秒模板 + 系统音色 |

---

## 6. 插件设置逐项说明

桌面端：**插件 → 唱歌 → 可配置项**。每改一项会单独保存并自动重载插件；API Key 是敏感项，读接口不回显（`PluginsPage.tsx:111-113`、`233-259`）。

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `provider` | `fal-ai-ace-step` | `fal-ai-ace-step` / `minimax-music` / `custom`；写错名字会按 `custom` 处理 |
| `apiKey` | 空 | **所有 provider 都必填**（`index.ts:649-651`）；fal 填 `FAL_KEY`，MiniMax 填开放平台 Key，custom 填服务端 Bearer |
| `voiceId` | 空 | 通用占位；当前三个 preset 都不支持持久 voice_id，保持空 |
| `refAudio` | 空 | 参考音频：绝对路径 / 仓库相对路径 / 公网 URL / data URI / base64；ACE-Step 和 MiniMax 走它 |
| `baseUrl` | 空 | custom 必填；内置 preset 可填代理/网关；fal 会拼 `/fal-ai/ace-step/audio-to-audio`，MiniMax 会拼 `/v1/music_generation` |
| `maxSeconds` | 60 | 单次时长上限，钳到 10~120；仅 custom 会真正使用 `seconds` |
| `cooldownSeconds` | 60 | 同一会话两次成功唱歌的最小间隔 |
| `dailyQuota` | 5 | 普通成员每个自然日成功唱歌上限；失败不计数 |
| `ownerUnlimited` | true | 主人与管理员不受每日次数限制 |
| `timeoutMs` | 300000 | 单次生成总超时（含轮询和下载），默认 5 分钟 |

安全：

- API Key 存 `data/secrets.json`，`data/` 已被 `.gitignore` 忽略（`src/kernel/config.ts:315-356`；`.gitignore:9`）；
- 不要把真实 Key 写进 README、脚本、聊天记录或 git commit；
- `prepare-ref` 不读取任何 Cookie，也不会把账号凭据带进容器。

---

## 7. 验证与排错

### 7.1 先验证脚本

```bash
node scripts/sing/prepare-ref.mjs --help
node scripts/sing/prepare-ref.mjs
```

成功时会打印类似：

```text
[prepare-ref] 校验通过：
[prepare-ref]   文件：...\data\sing\ref\dafatyu.wav
[prepare-ref]   格式：pcm_s16le / 24000 Hz / 1 声道 / 约 20.00 秒
```

也可以自己用容器里的 ffprobe 复核：

```bash
docker run --rm -v "<仓库绝对路径>:/work" qqbot-sing-prepare-ref:1 \
  ffprobe -v error -select_streams a:0 \
  -show_entries stream=codec_name,sample_rate,channels \
  -show_entries format=duration,size \
  -of default=noprint_wrappers=1 /work/data/sing/ref/dafatyu.wav
```

### 7.2 再验证 QQ

配置完成后，在 QQ 里对大肥鱼说：

> 唱一段

bot 的 LLM 会调用 `sing` 工具（`index.ts:749-795`），生成歌词和风格标签，云服务返回音频后作为 `record` 发进当前会话。第一次生成可能需要几十秒到几分钟；`timeoutMs` 默认 5 分钟。

### 7.3 常见错误

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `唱歌服务还没配置：缺 API Key` | `apiKey` 为空 | 按对应供应商填 Key；custom 也必须非空 |
| `还没配置参考音频（refAudio）或克隆音色（voiceId）` | 两个都空 | 填 `refAudio`（推荐） |
| `当前唱歌供应商不支持复用克隆音色 id` | 只填了 `voiceId`，或填了非音频字符串 | 把 `voiceId` 清空，改用 `refAudio` |
| `ACE-Step 接口不存在（HTTP 404）` | `provider` / `baseUrl` / 路径写错 | 核对 `baseUrl` 是否只填到网关根（插件会自动拼 `/fal-ai/ace-step/audio-to-audio`） |
| `超时了：等了 N 秒还没唱完` | 代理慢、队列排队、自部署 GPU 太慢 | 换代理/加大 `timeoutMs`/降低并发 |
| `回来的不是 mp3/wav 音频` | 服务把 JSON 错误当音频返回 | 查服务端日志/Key/参数；custom 必须直接返回音频字节 |
| `参考音频太大` | 超过 20 MB | 截短到 10~30 秒，或压缩成 mp3 |
| `读不到参考音频文件` | 相对路径解析到了 `data/plugin-data/sing` 而不是仓库根 | 改用绝对路径 |
| B 站下载失败（412 / 需要 cookies） | 风控/视频非公开 | 脚本按约定不使用账号 Cookie；换公开视频，或多 P 视频加 `--part` |
| yt-dlp 因 B 站改版失效 | 镜像里的 yt-dlp 太旧 | `docker rmi qqbot-sing-prepare-ref:1` 后重跑，脚本会重新构建并安装最新 yt-dlp |

### 7.4 关于「干净人声」

`prepare-ref` 默认输出的是**原视频混音**。如果你直接把它填进 ACE-Step，伴奏会一起进入 Speaker Embedding，效果可能打折。推荐流程：

1. 用 UVR5 / Demucs 对原视频音频做人声分离；
2. 取分离后的 `vocals` 轨，截 10~30 秒发音饱满的片段（可继续用 `prepare-ref --start/--dur` 的思路，或直接用 ffmpeg/音频编辑器）；
3. 把该干声文件填进 `refAudio`；
4. 重新生成一首，比较音色是否更稳。

参考音色来源：B 站视频 `BV1fYpn6SEk9`（UP 主「星落落_oi」用 DeepSeek TTS 衍生的大肥鱼声线翻唱《人是猫》）。原曲《人是猫》由张卡斯创作、洛天依演唱，原作 BV 号 `BV1Bfjq6LEDi`。

---

## 8. 最后一步

都配好后，在 QQ 里对大肥鱼说「**唱一段**」即可。
