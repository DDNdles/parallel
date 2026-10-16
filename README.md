# parallel —— 通用 harness 形态的 QQ 机器人

内核是一个可接入 LLM 的 **agent loop**，通过它掌控一个 QQ 账号，在群聊和私信里充当机器人。QQ 接入只是它的一种通道——协议适配本身也是插件形态，将来可以同一内核换接其他通道。

**一切皆插件**：角色化聊天（人格+好感度）、沙箱、搜索、每日推送……全部是热插拔插件；内核只保留 agent loop、Pipeline、服务容器与插件运行时（dsh 式组织，zcode 式四贡献面清单）。

```
┌─────────────────────── 桌面端 UI（zcode/codex 风格，内核自托管 http://127.0.0.1:3080）───────────────────────┐
│   控制台 · 会话流(工具卡片/斜杠命令) · 插件管理(全局+分群矩阵) · 人格 · 模型 · 记忆 · 用户 · 报错中心 · 沙箱 · 设置  │
└────────────────────────────── REST + WebSocket（同一份状态，与 QQ 侧互通）──────────────────────────────────┘
┌────────────────────────────────────── parallel 内核（TypeScript / Node ≥ 24）────────────────────────────────┐
│ OneBot11 适配器(反向WS+token) → Pipeline：黑名单→拟人层门控(必要性打分/防抖合批/空窗补偿)→限速→命令/AgentLoop │
│                                                                     → 逐条分段发送(打字节奏/错字自纠/引用自嘲)  │
│ Agent Loop：system(HDSI 式分层设定 + 具名节) + 语气样例 + 历史 + 尾部强化 → LLM → 工具(≤8轮) → 剧本体解析       │
│ 服务：LLM Provider 抽象 / 记忆(SQLite+FTS5) / 沙箱 / 发送(限速+抖动) / 调度 / 报错中心 / 会话日志(JSONL)        │
│ 插件容器：热插拔 · 分群开关(默认全关) · 声明式权限门控 · 崩溃隔离(同错3次自动停用) · MCP stdio                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌────────────── 协议端（二选一，内核内嵌托管） ──────────────┐
│ LuckyLilliaBot：无头纯协议直连 / 有头 PMHQ 注入本机 QQNT   │
│ NapCat：注入本机 QQNT 客户端                               │  ← 都以 OneBot 11 反向 WS 连回内核
└────────────────────────────────────────────────────────────┘
```

## 快速开始

```bash
# 要求 Node ≥ 24（内核直接运行 TS 源码，不编译）、Python 3（沙箱脚本用，可选）
npm install        # 依赖：ws + pi（Pi Agent Harness）的 agent runtime（见下）
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
- **第一次跑会先停在「环境检查」页**：探测 Node / 数据目录可写 / QQNT / 协议端发行包 / Docker / Python / Bash / ffmpeg，缺的必备项不让你往下走。第三方软件（QQ、Docker…）只给官方下载页链接——parallel 不替人装软件；协议端发行包是唯一点一下就能由内核自己下的。走过一次就不再拦（`ui.setupDoneAt`），随时想看回去把该值改回 0 并重启内核
- OneBot 反向 WS 端点：`ws://127.0.0.1:3001/onebot`，token 是 `data/secrets.json` 里的 `onebotAccessToken`
- **不插真 QQ 号也能验证**：桌面端「会话」页可以注入模拟用户消息、以 bot 身份发言，走完整 Pipeline/AgentLoop/插件链路；测试套件用模拟协议端（`npm test`）

### 接入真机

1. 桌面端「设置 → QQ 接入」选协议端（LuckyLilliaBot / NapCat）：两端都由内核内嵌托管——自动下载发行包、预写反向 WS 配置（token 自动注入）、拉起并守护，QQ 路径自动探测
2. 在弹出的 QQ 窗口扫码登录**专用小号**。LLBot 有头模式要先填「账号」（bot 的 QQ 号），否则拒绝启动，免得顶掉你本机登录的号
3. 用你自己起的协议端也行：在其 WebUI 添加反向 WS 客户端 `ws://127.0.0.1:3001/onebot` + accessToken（见上）
4. 桌面端「设置」配置主人 QQ（`masterIds`）；群聊里让管理员发 `/插件 开启 chat` 激活聊天

## 功能地图

| 功能 | 状态 | 说明 |
|------|------|------|
| 角色化聊天 | ✅ 完整 | **设定层照 HDSI（HDS Interlude）分层**，替代原「人设卡 + 世界书 + few-shot」三件套：`canon.json` 一份装 **Canon**（主角记号 / 世界 / 配角 / 语言，剧情起点，只由人写）/ **Perspective**（独立于 Canon 的个体价值观）/ **Voice**（说话方式与语气样例，样例本身写成小说片段）/ **Lore**（关键词命中的世界事实）；运行时演化出的稳定变化落 **Overlay 层**（模型经 `remember_setting` 写入，可追溯来源，`/设定` 与人格页可查看/清空，不动 Canon）。注入顺序 剧本(1000) → 看世界的方式(1040) → 长期演化(1050) → 世界事实(1100) → 关系状态(1200) → 记忆(1300)。内置人格 **CETACEA_MOLI**（`personas/whale-girl/canon.json`），「人格」页可新建 |
| 好感度 | ✅ 完整 | LLM 工具自更新（防刷：单日±15封顶、60s冷却），分段解锁称呼语气（阈值可配），每轮注入 |
| 人格=插件 | ✅ 完整 | persona 类插件 `locked`：QQ 侧仅主人可切换/查看，普通成员不可套取内容；改剧本文件（`canon.json`）与清演化层同样仅主人 |
| 模型优先链 | ✅ 完整 | 供应商统一登记，聊天 / 工作各一条优先链，连续失败到达阈值自动降级下一个（`llm.chatChain` / `workChain`） |
| agent loop | ✅ 交给 pi-agent-core | 轮次推进、工具调度（sequential：工具共享沙箱/常驻容器状态，不能并发串味）、`terminate` 早停、事件流都由 `@earendil-works/pi-agent-core` 的 `Agent` 负责；内核只做翻译（工具面 → `AgentTool`、`AgentEvent` → 桌面端事件）、轮次上限、收尾交付（`work_finish`）与压缩。**模型请求经 `LlmService.chainStreamFn` 走链**，不是直连 pi-ai——降级链是内核的能力，不能在换内核时丢掉 |
| 会话条目树 | ✅ | `data/sessions/*.jsonl` 每条带 `parentId`（同一会话串成一条活动分支），压缩落成 `compaction` 条目，历史由「活动分支 + 最近压缩边界」投影而来——重启后不会把压缩过的历史又变回全文 |
| 上下文压缩 | ✅ 用 pi 的 | 阈值判断 `shouldCompact`、token 账 `estimateContextTokens`、原文序列化 `serializeConversation`、默认阈值 `DEFAULT_COMPACTION_SETTINGS` 全部来自 pi-agent-core；内核只留"切点不落在工具结果上"与摘要回填这两处它管不到的胶水（`work.compaction` 可配） |
| 模型层 | ✅ 交给 pi-ai | 三种连接方式（Chat Completions / OpenAI Responses / Anthropic Messages）全部由 `@earendil-works/pi-ai` 实现：请求整形、SSE 解析、工具调用聚合、各家缓存字段折算都不再由内核自己写。内核只保留自己的价值面——供应商配置、聊天/工作两条优先链与降级阈值、用量账、模型页契约、附件按 `inputTypes` 整形 |
| work 子代理（pi） | ✅ 完整 | 管理员 `/work <任务>` 触发，work 模型在隔离上下文里跑 agent loop（常驻 Python / 浏览器 / shell / 文件 / 联网），用 `work_finish` 交回结构化结论，chat 模型再用自己的人格转述；信息不足且猜错代价明显时用 `work_ask` 停下来提问——转述按「等你回答」口径（不再说成已完成），管理员回一句 `/work <回答>`（30 分钟内有效）就把上次的问题与这次的回答拼成新任务交回去接着干（run 之间不保留上下文，产物留在会话沙箱里）。身份与工具白名单在 `src/plugins/work/agents/*.md`（内置 work / research / data，`<data>/agents/` 可自加并同名覆盖；`tools:` 不写 = 不设白名单，拿到全部 work 面工具）；system 由内核按「agent 定义 + 具名分节 + 各工具自带的 promptSnippet/promptGuidelines」组装（工具面一变规则自动跟着变，不会漂移）；上下文超窗自动压缩（`work.compaction`）。设置页「工作」分节可改：入口 agent、子代理目录、嵌套上限、压缩开关与两个 token 预算，以及 pi 内核的 chat 工具轮上限/每会话历史条数 |
| work→子代理 | ✅ 完整 | work 模型可用 `delegate` 把子任务派给专职子代理（`{agent, task}` 单个，或 `{tasks: [...]}` 并行，上限 4）；每个子代理**独立上下文 + 各自的窄工具白名单**，完成后把结论/产物/备注交回父代理。嵌套深度上限 `work.maxDepth`（默认 2），到顶那层 `delegate` 在收集阶段就不存在 |
| 拟人化（chat 区） | ✅ 完整 | 内核自有的一层（不是插件），chat 区的行为就是它：**⓪剧本体** 模型写的是**小说的下一段**——旁白写动作/神态/环境，主角要说出口的话用 `<say id="s1">…</say>` 包住，**只有 say 块里的字进 QQ**；旁白留在剧本里并**带标签**回灌历史（摘掉标签模型下一轮就不写 say 了，实测退化）。动作描写于是从结构上漏不到群里，不是靠过滤。沉默用 `[silent]`。**①分段发送** 一段回复按语义拆成几条短消息（规则断句或再叫一次模型、逐字校验不改写；`？！` 单独成条且语气标点保留，`？！` 与换行是硬边界不参与概率合并；`maxSentenceNum`/`maxSplitNum`/颜文字保护），**②打字节奏** 第一条立刻发、之后每条按字数等"正在输入"（中文 0.3s/字、单字×3、emoji 1s，可封顶），**③会接话** 必要性打分决定开不开口（@=100/提及=80/私聊=40 + 内容分 + 积压压力 − 自己占最近 5 分钟发言比的存在感惩罚，×频率系数后过阈值），**④会主动** 沉默够久按群平均节奏折算"等效消息数"补上阈值（封顶保证必须有真实积压消息），连续不理人则指数退避，**⑤防抖合批** 群里几条消息攒一起再回（老话过了 TTL 就丢），**⑥频率** 全局/按群/按时段三层 + **表达风格**（`timing.replyStyle`，MaiBot `personality.reply_style` 原值：让模型自己就写平淡短句——分段器只负责把写短的话切开）+ 错字自纠（错字后引用自己回一条纠正）。移植自 MaiBot 的 `reply_necessity` / `turn_gates` / `idle_backoff` / 响应分段器 / `typing_speed` / `reply_style`，参数名与默认值对齐；**两处刻意偏离**见 `src/kernel/humanlike/splitter.ts`（`？！` 补进分隔符集；`maxSentenceNum/maxSplitNum` 8/3 → 12/6）。**⑦HDSI 四件套**：**节奏反定型**（连着几轮回复结构同构 → 以角色视角注入纠偏；gentle/balanced/aggressive 三档，熔断可配）、**情绪偏移 Alter**（每轮 `<alter>±n</alter>` 净变化，动态阈值+同向加权/反向衰减，命中阈值后由侧端模型写一段氛围描述注入，不阻塞可见回复）、**主体行动窗口 Agency**（日程负荷/隐私/设备三样构成主动开口的容量，安静时段直接不开口，判据顺序与理由字符串照搬 HDSI）、**日程 Schedule Preplan**（周规律+日期例外，供容量判断与主动轮参考，注入时明确标注"是计划不是已发生的事实"）。设置页「拟人化」分节可调全部参数，`GET /api/humanlike/status` 看某会话当前为什么不出声；`/设定` 看演化层、`/日程` 看日程 |
| gemini-3.8-flash | ⛔ 占位 | Provider 抽象完整（流式+工具调用）；gemini 只有接口与配置占位 `enabled=false`，UI 显示"未接入"，实现位在 `src/kernel/services/llm.ts` 的 TODO |
| 沙箱 | ✅ 完整 | 每会话独立目录（防路径穿越强校验）、Python/JS 受限执行（超时/输出截断/并发与频率配额）、TTL 自动清理、收发文件仅限沙箱 |
| 插件系统 | ✅ 完整 | 热插拔（不重启进程）、三类来源、四贡献面（tools/commands/userConfig/mcpServers）、声明式权限门控 |
| 分群开关 | ✅ 完整 | 默认全部关闭；禁用的插件在该群工具列表缺席、命令不可用、普通成员完全不可见；开关权限=群管理员/群主/主人 |
| 用户记忆 | ✅ 完整 | 按 QQ 号：昵称/事实(FTS 检索)/状态(好感度)；插件按权限读写；"忘记我"；UI 管理+导入导出+审计 |
| 表情包 | ✅ 可用 | 群级库：收图建库/搜索/随机/LLM 调用发图 |
| 网络搜索 | ✅ 可用 | Tavily REST 封装（MCP 等价封装），未配 key 自检提示 |
| 每日一题 / MC 推荐 / 每日音乐 / 每日诗 / 链接解析 | 🚧 骨架 | 能装、能开关、命令可触发、留清晰 TODO |
| 桌面端 UI | ✅ 完整 | Next.js 15 静态导出（`web/` 源码 → `ui/` 产物，内核自托管）：黑白双主题、40rem 居中会话列、工具调用折叠行、毛玻璃顶栏+模型选择器、大圆角 composer、全站品牌光标；全部操控面 |
| 可测试 | ✅ 完整 | 模拟协议端 E2E + 单测（`npm test`） |

## 红线对照

1. **接入**：QQ 接入经 LuckyLilliaBot 或 NapCat 协议端（两端都内嵌托管、常驻拉起）；都以 OneBot 11 反向 WS 连回，access token 强制鉴权（`src/kernel/adapters/onebot11.ts`）。
2. **沙箱边界**：`SandboxService.resolveInside` 把一切路径解析后强校验在会话沙箱根内；`ChatService.sendFile` 只发沙箱内文件；聊天收到文件落沙箱 `inbox/`。
3. **风控克制**：`risk` 段只设内核红线，`humanlike` 段管行为人格，两边不重复设同一个旋钮。令牌桶限速**按条计费**（`ChatService.sendPlanned` 拿 `plans.length` 个令牌，配额不够就截断成前几条而不是整批丢弃）；主动消息默认关闭（`Scheduler` proactive 门控，UI 标注风险）；本群没开任何插件时普通成员彻底静默（不暴露"这是个机器人"）。回复前的等待只有拟人化一个来源（打字节奏 `humanlike.typing` / 合批 `humanlike.merge`），"要不要理这条"也只有拟人层一处判（群聊走必要性打分 / `@` 必回，私聊与命令直通）—— 风控里不再留第二套唤醒与抖动旋钮。拟人层的"主动开口"同样是显式开关：空窗补偿只补真实积压、连续不理人指数退避、`humanlike.proactive` 默认关。
4. **健壮性**：配置原子落盘 `.tmp→rename→.bak×3`（`util/fsutil.ts`）；插件回调全部过 `guarded()` 隔离，同错 3 次自动停用并私聊主人；卸载走统一 deactivate 协议（定时器/子进程/监听器经 disposers 逆序清理，调度任务一并注销）。
5. **权限**：主人>群管理员/群主>普通用户；越权在容器/命令/工具层被拒绝（`PermissionDeniedError`），不靠提示词自觉。工具还按**可见面**（`ToolDef.surface`）在收集阶段切分：`surface:'work'` 的重工具（常驻 Python / 浏览器 / shell）在 chat 轮的工具列表里根本不存在，work 轮再受 agent 定义的白名单约束。
6. **可测试**：模拟协议端（test/mock-onebot）+ 桌面注入双通道，无需真号。
7. **敏感信息**：API key/token 只落 `data/secrets.json`（**该目录不入库**），代码默认值与插件清单一律为空——新装实例所有密钥都是未配置状态，得用户自己填。桌面端只听 127.0.0.1 且要 uiToken，在这个前提下密钥明文回显便于自查；pi-ai 那条路上 key 也是**按请求传**的，不进 pi-ai 自己的凭证库。

## 目录

```
bin/parallel.js        启动器（自动带 --experimental-transform-types）
src/kernel/           内核：总线/配置/存储/报错/限速/调度/会话日志
src/kernel/services/  LLM / 记忆 / 沙箱 / 发送 / MCP 客户端 / work 子代理执行器
src/kernel/services/pi-ai.ts  pi-ai 桥接（backend:'pi-ai' 的供应商走这里）
src/kernel/work-prompt.ts  work 轮 system 的组装（pi 式具名分节 + 工具自带的规则 + 交付格式解析）
src/kernel/work-agent.ts   work agent 定义加载（agents/*.md 的 frontmatter + 正文，带内置兜底）
src/kernel/humanlike/ 拟人化层（chat 区行为本身，不在插件体系里）：
                     script.ts    剧本体：<say id> 台词摘取（移植 HDSI authored-actions）+ 输出格式要求
                     rhythm.ts    聊天节奏反定型（移植 HDSI ChatRhythm）
                     alter.ts     情绪偏移追踪（移植 HDSI Alter；含侧端分析契约与解析）
                     agency.ts    主体行动窗口（移植 HDSI Agency 的容量判据与配置默认值）
                     schedule.ts  日程：周规律 + 日期例外（移植 HDSI Schedule Preplan 的口径）
                     necessity.ts 该不该开口的打分（移植 MaiBot reply_necessity + turn_gates 空窗补偿）
                     frequency.ts 发言频率规则与空闲退避（移植 MaiBot talk_value_rules + idle_backoff）
                     splitter.ts  分段与打字节奏（移植 MaiBot 响应分段器 / 颜文字保护 / typing_speed / 错字）
                     service.ts   每会话心流：入站门控 + 防抖合批 + 主动唤醒 + 出站计划
                     types.ts     humanlike 配置形状（字段名与 MaiBot 对齐）+ TriggerBatch
src/kernel/adapters/  OneBot 11 反向 WS 适配器
src/kernel/api/       REST API + 事件 WS + 静态 UI 服务
src/plugins/          内置插件 11 个（chat / plugin-manager / sandbox / web-search / work 是底座，不在插件页显示；
                      daily-question / link-parser / mc-daily / music-daily / poem-daily / sticker 可玩）
src/plugins/work/agents/  子代理定义（work.md 入口 / research.md / data.md：工具白名单 + 身份正文；
                      用户可在 <data>/agents/ 自加，同名覆盖内置）
examples/             示例插件（自建模板，含 MCP server 示例）
web/                  桌面端源码（Next.js 15 静态导出）
ui/                   桌面端产物（`npm run build` 生成，不入库）
test/                 单测 + E2E（模拟协议端）
scripts/              一次性脚本：`verify-humanlike.mjs` 端到端验收拟人层、
                     `dump-payloads.mjs` 抓 chat/work 真实请求报文、
                     `probe-scene.mjs` 看模型是否按剧本体输出（都不需要真号，给 USTC_KEY 即用真模型）、
                     `serve-ui.mjs` 起一个临时内核（自带模拟协议端，不碰真 QQ）用来预览/验收桌面端
data/                 运行时数据（config.json / secrets.json / parallel.db / sandbox/ / sessions/ / plugins/），不入库
```
