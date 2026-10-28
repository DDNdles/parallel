# parallel —— harness 形态的 QQ 机器人

内核是一个可接入 LLM 的 **agent loop**，通过它掌控一个 QQ 账号，在群聊和私信里充当机器人。QQ 接入只是它的一种通道——协议适配本身也是插件形态，将来可以同一内核换接其他通道。

**一切皆插件**：角色化聊天、沙箱、搜索……全部是热插拔插件；内核只保留 agent loop、Pipeline、服务容器与插件运行时（dsh 式组织，zcode 式四贡献面清单）。

```
┌─────────────────────── 桌面端 UI（zcode/codex 风格，内核自托管 http://127.0.0.1:3080）───────────────────────┐
│   控制台 · 会话流 · 工作 · 人格 · 模型 · 记忆 · 用户 · 报错中心 · 沙箱 · 用量 · 设置 · 插件 · 翻唱 · 表情包      │
└────────────────────────────── REST + WebSocket（同一份状态，与 QQ 侧互通）──────────────────────────────────┘
┌────────────────────────────────────── parallel 内核（TypeScript / Node ≥ 24）────────────────────────────────┐
│ OneBot11 适配器(反向WS+token) → Pipeline：拉黑/隐藏收口 → 拟人层开口门控(frequency) → 限速 → AgentLoop        │
│                                                                     → 出站纯程序按句分条（气泡期可被打断）    │
│ Agent Loop：system(固定节 + 插件分节 + 工具自带规则) + 历史 + 尾部强化 → LLM → 工具(chat 两轮 / work 不设上限)  │
│ 服务：LLM(pi-ai) / 记忆(SQLite+FTS5) / 沙箱 / 发送(限速+抖动) / 调度 / 报错中心 / 会话日志(JSONL)               │
│ 插件容器：热插拔 · 分群开关 · 声明式权限门控 · 崩溃隔离(同错3次自动停用) · MCP stdio                            │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌────────────── 协议端（二选一，内核内嵌托管） ──────────────┐
│ LuckyLilliaBot：无头纯协议直连 / 有头 PMHQ 注入本机 QQNT   │
│ NapCat：注入本机 QQNT 客户端                               │  ← 都以 OneBot 11 反向 WS 连回内核
└────────────────────────────────────────────────────────────┘
```

## 快速开始

三种安装路线，任选其一（npm 包与 zip 自带构建好的桌面端，装完即用；克隆开发才需要自己 build）：

```bash
# ── 方式一：npm 包（推荐）──────────────────────────────
# 从 GitHub Releases 下载 .tgz（如 ddnoodles-parallel-0.2.0.tgz）后：
npm install -g ddnoodles-parallel-0.2.0.tgz   # 依赖（ws / pi agent runtime）自动装
parallel                                       # 在任意目录启动；数据落在当前目录 ./data

# ── 方式二：zip（不熟 npm 的话）────────────────────────
# 从 Releases 下载 parallel-vX.Y.Z.zip，解压后双击 parallel.cmd

# ── 方式三：克隆开发 ───────────────────────────────────
# 要求 Node ≥ 24（内核直接运行 TS 源码，不编译）
# work 模式还需要 Docker、Python 3、Bash；只聊天可以先不装（环境检查页可跳过）
git clone <本仓库> && cd parallel
npm install        # 运行时依赖：ws + pi 的 agent runtime
                   #   @earendil-works/pi-ai —— 模型层唯一引擎（三种连接方式全交给它）
                   #   @earendil-works/pi-agent-core —— agent loop（轮次/工具调度/事件流）
npm run build      # 桌面端：Next 静态导出到 ui/（内核托管这个目录，克隆后要先构建一次）

# 启动（任选其一）：
parallel.cmd        # Windows：双击或命令行运行
./parallel.sh       # macOS / Linux
npm start           # = node bin/parallel.js
```

启动后：
- 桌面端：<http://127.0.0.1:3080>。令牌不用手填——内核启动时自动打开浏览器并带 `#token=<uiToken>`；若是自己另开的标签页、或提示"浏览器令牌与内核不匹配"，重启一次内核让它重新带着令牌打开即可（`uiToken` 在 `data/secrets.json`）
- **第一次跑会先停在「环境检查」页**：探测 Node / 数据目录可写 / QQNT / 协议端发行包 / Docker / Python / Bash / ffmpeg。第三方软件只给官方下载页链接——parallel 不替人装软件；协议端发行包是唯一点一下就能由内核自己下的（官方源优先，下载后校验官方 SHA256）。走过一次就不再拦（`ui.setupDoneAt`）；Docker/Python/Bash 缺失只影响 work，聊天可以点「跳过」直接进
- OneBot 反向 WS 端点：`ws://127.0.0.1:3001/onebot`，token 是 `data/secrets.json` 里的 `onebotAccessToken`
- **不插真 QQ 号也能验证**：桌面端「会话」页可以以 bot 身份发言，走完整 Pipeline/AgentLoop/插件链路；测试套件用模拟协议端（`npm test`）

### 接入真机

1. 选协议端：目前只认手改 `data/config.json` 的 `onebot.flavor`（`llbot` / `napcat`），改完重启内核。**内嵌托管只支持 Windows**（发行包是 win-x64，NapCat 还要注入本机 QQNT）；macOS/Linux 上内核本身可跑，但请自行运行 OneBot 11 协议端并指向内核。Windows 上两端都由内核托管——自动下载发行包、预写反向 WS 配置（token 自动注入）、拉起并守护，QQ 路径自动探测
2. 在弹出的 QQ 窗口扫码登录**专用小号**。LLBot 有头模式要先填「账号」（bot 的 QQ 号），否则拒绝启动，免得顶掉你本机登录的号
3. 用你自己起的协议端也行：在其 WebUI 添加反向 WS 客户端 `ws://127.0.0.1:3001/onebot` + accessToken（见上）
4. 在桌面端「用户」页的权限名单里配置主人 QQ（`masterIds`）；`chat` 是 core 插件、默认生效，其余插件默认按群开启，可在「插件」页的开关矩阵里逐群调整

## 功能地图

| 功能 | 状态 | 说明 |
|------|------|------|
| 角色化聊天 | ✅ 完整 | `canon.json` 一份装 **Canon**（主角记号 / 世界 / 配角 / 语言）/ **Perspective**（价值观）/ **Voice**（语气样例）/ **Lore**（关键词命中的世界事实）；运行时演化出的稳定变化落 **Overlay 层**（模型经 `remember_setting` 写入，桌面端人格页可查看/清空，不动 Canon）。内置人格 **CETACEA_MOLI**（`src/plugins/chat/personas/whale-girl/canon.json`）；「人格」页可新建/编辑，用户人格写 `data/personas/`（同名覆盖内置，升级不丢、不会随发布包外泄） |
| 人格=插件 | ✅ 完整 | persona 类插件 `locked`：QQ 侧仅主人可切换/查看，普通成员不可套取内容；改 canon 与清演化层同样仅主人 |
| 模型优先链 | ✅ 完整 | 供应商统一登记，聊天 / 工作各一条优先链，连续失败到达阈值自动降级下一个（`llm.chatChain` / `workChain`） |
| agent loop | ✅ 交给 pi-agent-core | 轮次推进、工具调度、早停、事件流都由 `@earendil-works/pi-agent-core` 的 `Agent` 负责；内核只做翻译、轮次上限、收尾交付与压缩。chat 轮**最多两轮**（第二轮摘掉工具，防工具面自嗨）；work 轮**不设轮次上限**（2026-10-23 用户定）。模型请求经 `LlmService.chainStreamFn` 走链，不是直连 pi-ai |
| 会话条目树 | ✅ | `data/sessions/*.jsonl` 每条带 `parentId`（同一会话串成一条活动分支），压缩落成 `compaction` 条目，历史由「活动分支 + 最近压缩边界」投影而来 |
| 上下文压缩 | ✅ 用 pi 的 | 阈值判断、token 账、原文序列化全部来自 pi-agent-core；内核只留"切点不落在工具结果上"与摘要回填。上下文窗口按 **10 分钟时间窗 + 条数上限** 双约束（`humanlike.contextMinutes` / `llm.historyLimit`） |
| 模型层 | ✅ 交给 pi-ai | 三种连接方式（Chat Completions / OpenAI Responses / Anthropic Messages）与 Gemini 原生协议全部由 `@earendil-works/pi-ai` 实现；内核只保留供应商配置、两条优先链、用量账、模型页契约、附件整形 |
| work 子代理（pi） | ✅ 完整 | chat 面工具 `work_dispatch` 派活（只有派发原文的转发，模型不能改写任务；权限与归属取**本轮实际说话人**）；work 模型在隔离上下文里跑 agent loop（常驻 Python / 浏览器 / shell / 文件 / 联网），用 `work_finish` 交回结构化结论。跑完后内核另起一轮，由 chat 带着 @发起人 用自己的人设汇报，产物由系统直接逐条发文件。`work_status` 只查调用者自己的进度；`work_ask` 可停下来提问，回答在 30 分钟内拼成续接任务。入口任务程序上限 4 个 |
| work→子代理 | ✅ 完整 | work 模型用 `delegate` 把子任务派给专职子代理（单个或并行，上限 4）；每个子代理独立上下文 + 窄工具白名单。嵌套深度上限 `work.maxDepth`（默认 2）。定义在 `src/plugins/work/agents/*.md`（内置 work / research / data，`<data>/agents/` 可自加覆盖） |
| 拟人化（chat 区） | ✅ 完整 | 内核自有的一层（不是插件）：**开口侧** = 条数门槛（pending ≥ `frequency.pendingThreshold`）+ 空窗补偿 + 连续不理人指数退避；「仅 @ 后才回复」默认关；@ 触发的轮次不可打断。**出站侧** = 纯程序按句分条（硬上限 100 字 / 6 条，推荐 2~3 条），被插话打断时剩余气泡不发也不进历史；私聊同样合批。**没有**剧本体 `<say>`、Alter 情绪偏移、耗时打分（likelihood）、typing 参数或 replyStyle——这些旧层 2026-10-17/10-23 已整体删除，`humanlike/` 下现存 frequency / delivery / interrupt / repetition / jargon / rhythm / agency / schedule（后三者只保留日程与节奏纠偏所需的配置与判据） |
| 沙箱 | ✅ 完整 | 每会话独立目录（字面 + realpath 双重越界校验、chatKey 消毒）、Python/JS/bash 执行（超时/输出截断/每会话 1 并发 + 全局 8 并发/频率配额）、TTL 扫盘清理（容器直写也清）；chat 档 Docker 不可用时回落本机子进程（弱隔离，仅告警一次），work 档强制容器、不可用直接报错 |
| 插件系统 | ✅ 完整 | 热插拔（不重启进程）、三类来源、四贡献面（tools/userConfig/mcpServers/hooks）、声明式权限门控；内置 9 个（bilibili / chat / cover / imagegen / sandbox / skills / sticker / web-search / work），其中 chat/sandbox/skills/web-search/work 为底座、不在插件页显示 |
| 分群开关 | ✅ 完整 | `chat`/`sandbox` 是 core、永远生效；其余默认开启，可在「插件」页的开关矩阵里逐群调整；禁用的插件在该群工具列表缺席、命令不可用、普通成员完全不可见 |
| 用户记忆 | ✅ 完整 | 按 QQ 号：昵称/事实（FTS 检索）/拉黑（完全不收）；插件按权限读写；桌面端可管理、搜索、导入导出 |
| 网络搜索 | ✅ 可用 | Tavily REST 封装（未配 key 时如实说用不了）；`web_fetch` 只抓公网地址（拦环回/RFC1918/元数据，重定向逐跳复检） |
| 桌面端 UI | ✅ 完整 | Next.js 15 静态导出（`web/` 源码 → `ui/` 产物，内核自托管）：黑白双主题、会话流 + 工作抽屉、日轨回看、打断按钮、全站品牌光标；14 个页面覆盖全部操控面 |
| 可测试 | ✅ 完整 | 模拟协议端 E2E + 单测（`npm test`，470+ 项） |

## 红线对照

1. **接入**：QQ 接入经 LuckyLilliaBot 或 NapCat 协议端（两端都内嵌托管、常驻拉起）；都以 OneBot 11 反向 WS 连回，access token 强制鉴权（`src/kernel/adapters/onebot11.ts`）。
2. **沙箱边界**：`SandboxService.resolveInside` 先做字面路径强校验，再对真实路径（realpath）复核，符号链接指到沙箱外一律拒绝；`chatKey` 只留 `[A-Za-z0-9._-]`，`..` 不能参与目录名；`ChatService.sendFile` 只发沙箱内文件。
3. **风控克制**：`risk` 段只设内核红线，`humanlike` 段管行为人格。令牌桶限速**按条计费**（配额不够就截断成前几条而不是整批丢弃）；主动消息默认关闭；本群没开任何插件时普通成员彻底静默。回复前的等待只有拟人化一个来源，"要不要理这条"也只有一处判（frequency 门槛 + @ 必回；私聊必回但同样攒批）。**出站可被打断**：气泡期对面再发消息按概率砍掉剩余气泡，被砍掉的正文不回灌历史；**重复消息** 2 分钟内一字不差重发且上一轮真答过就不再另起一轮。QQ 指令面已为空：以 `/` 开头的消息按普通消息处理，不再有内建命令。
4. **健壮性**：配置原子落盘 `.tmp→rename→.bak×3`（`util/fsutil.ts`）；插件回调全部过 `guarded()` 隔离，同错 3 次自动停用并私聊主人；卸载走统一 deactivate 协议（定时器/子进程/监听器经 disposers 逆序清理），并清空该插件的全部密钥。
5. **权限**：主人>群管理员/群主>普通用户；越权在容器/工具层被拒绝（`PermissionDeniedError`），不靠提示词自觉。工具还按**可见面**（`ToolDef.surface`）在收集阶段切分：`surface:'work'` 的重工具在 chat 轮的工具列表里根本不存在，work 轮再受 agent 定义的白名单约束。
6. **可测试**：模拟协议端（test/mock-onebot）+ 桌面端以 bot 身份发言双通道，无需真号。
7. **敏感信息**：API key/token 只落 `data/secrets.json`（该目录不入库），代码默认值与插件清单一律为空。桌面端只听 127.0.0.1 且要 uiToken；免 token 的 `/api/setup/*`、`/api/login/*` 额外要求回环来源 + 回环 Host + 非跨站 Origin。密钥在桌面端明文回显是显式取舍（便于自查），前提是上面这道本机边界。

## 目录

```
bin/parallel.js        启动器（自动带 --experimental-transform-types）
src/kernel/           内核：总线/配置/存储/报错/限速/调度/会话日志
src/kernel/services/  LLM / 记忆 / 沙箱 / 发送 / MCP 客户端 / work 执行器 / 协议端托管
src/kernel/services/pi-ai.ts  pi-ai 桥接（backend:'pi-ai' 的供应商走这里）
src/kernel/work-prompt.ts  work 轮 system 的组装（pi 式具名分节 + 工具自带的规则 + 交付格式解析）
src/kernel/work-agent.ts   work agent 定义加载（agents/*.md 的 frontmatter + 正文，带内置兜底）
src/kernel/humanlike/ 拟人化层（chat 区行为本身，不在插件体系里）：
                     frequency.ts 开口门槛、空窗补偿、退避
                     delivery.ts  出站分条与气泡节奏（纯程序）
                     interrupt.ts 出站打断判定
                     repetition.ts / jargon.ts 重复惩罚与口癖词
                     rhythm.ts    聊天节奏反定型（移植 HDSI 判据）
                     agency.ts    主体行动窗口（日程负荷/隐私/设备容量）
                     schedule.ts  日程：周规律 + 日期例外
                     service.ts   每会话心流：入站门控 + 防抖合批 + 主动唤醒 + 出站计划
src/kernel/adapters/  OneBot 11 反向 WS 适配器
src/kernel/api/       REST API + 事件 WS + 静态 UI 服务
src/plugins/          内置插件 9 个；chat 的 personas/ 是内置人格目录
src/plugins/work/agents/  子代理定义（work.md 入口 / research.md / data.md）；用户可在 <data>/agents/ 自加
examples/             示例插件（自建模板，含 MCP server 示例）
web/                  桌面端源码（Next.js 15 静态导出）
ui/                   桌面端产物（`npm run build` 生成，不入库）
test/                 单测 + E2E（模拟协议端）
scripts/              运维/验收脚本：`pack-release.mjs` 打发布包（默认要求工作区干净）、
                     `dump-payloads.mjs` 抓 chat/work 真实请求报文、`verify-humanlike.mjs` 拟人层验收、
                     `serve-ui.mjs` 起临时内核预览桌面端、`smoke-work-tools.ts` 工作工具冒烟
data/                 运行时数据（config.json / secrets.json / parallel.db / sandbox/ / sessions/ / plugins/ / personas/），不入库
```

## 许可

本项目以 [AGPL-3.0](LICENSE)（GNU Affero General Public License v3.0）许可发布：自行使用与修改不受限；
若把修改后的版本作为网络服务提供或对外分发，需按 AGPL-3.0 提供对应源码。选择该许可证的直接原因：
拟人化层 `agency.ts` 的行动容量判定移植自 HDS-Interlude（AGPL-3.0）。随包第三方组件与借鉴来源见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；QQ 表情美术图不随仓库/发布包分发，运行时由内核
从本机协议端发行包转码生成到 `data/face/`。
