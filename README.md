# parallel —— 通用 harness 形态的 QQ 机器人

内核是一个可接入 LLM 的 **agent loop**，通过它掌控一个 QQ 账号，在群聊和私信里充当机器人。QQ 接入只是它的一种通道——协议适配本身也是插件形态，将来可以同一内核换接其他通道。

**一切皆插件**：角色化聊天（人格+好感度）、沙箱、搜索、每日推送……全部是热插拔插件；内核只保留 agent loop、Pipeline、服务容器与插件运行时（dsh 式组织，zcode 式四贡献面清单）。

```
┌─────────────────────── 桌面端 UI（zcode/codex 风格，内核自托管 http://127.0.0.1:3080）───────────────────────┐
│   控制台 · 会话流(工具卡片/斜杠命令) · 插件管理(全局+分群矩阵) · 人格 · 模型 · 记忆 · 用户 · 报错中心 · 沙箱 · 设置  │
└────────────────────────────── REST + WebSocket（同一份状态，与 QQ 侧互通）──────────────────────────────────┘
┌────────────────────────────────────── parallel 内核（TypeScript / Node ≥ 24）────────────────────────────────┐
│ OneBot11 适配器(反向WS+token) → Pipeline：黑名单→唤醒→限速→命令/AgentLoop → 装饰发送(分段+抖动)                │
│ Agent Loop：system(人格五插槽) + few-shot + 历史 + 尾部强化 → LLM → 工具(≤8轮) → 输出校验                      │
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
npm install        # 内核唯一依赖：ws
npm run build      # 桌面端：Next 静态导出到 ui/（内核托管这个目录，克隆后要先构建一次）

# 启动（任选其一）：
parallel.cmd        # Windows：双击或命令行运行
./parallel.sh       # macOS / Linux
npm start           # = node bin/parallel.js
```

启动后：
- 桌面端：<http://127.0.0.1:3080>，首次登录输入 `data/secrets.json` 里的 `uiToken`
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
| 角色化聊天 | ✅ 完整 | 人格五插槽：人设卡 / 世界书(关键词注入) / few-shot+尾部强化 / 好感度·心情状态注入 / 记忆融合；内置人格 **CETACEA_MOLI**（`personas/whale-girl`），「人格」页可新建 |
| 好感度 | ✅ 完整 | LLM 工具自更新（防刷：单日±15封顶、60s冷却），分段解锁称呼语气（阈值可配），每轮注入 |
| 人格=插件 | ✅ 完整 | persona 类插件 `locked`：QQ 侧仅主人可切换/查看，普通成员不可套取内容 |
| 模型优先链 | ✅ 完整 | 供应商统一登记，聊天 / 工作各一条优先链，连续失败到达阈值自动降级下一个（`llm.chatChain` / `workChain`） |
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
3. **风控克制**：令牌桶限速+随机抖动（`ChatService`）；主动消息默认关闭（`Scheduler` proactive 门控，UI 标注风险）；群聊默认仅 @/回复唤醒（`Pipeline.isAwake`）。
4. **健壮性**：配置原子落盘 `.tmp→rename→.bak×3`（`util/fsutil.ts`）；插件回调全部过 `guarded()` 隔离，同错 3 次自动停用并私聊主人；卸载走统一 deactivate 协议（定时器/子进程/监听器经 disposers 逆序清理，调度任务一并注销）。
5. **权限**：主人>群管理员/群主>普通用户；越权在容器/命令/工具层被拒绝（`PermissionDeniedError`），不靠提示词自觉。
6. **可测试**：模拟协议端（test/mock-onebot）+ 桌面注入双通道，无需真号。
7. **敏感信息**：API key/token 只落 `data/secrets.json`（**该目录不入库**），代码默认值与插件清单一律为空——新装实例所有密钥都是未配置状态，得用户自己填。桌面端只听 127.0.0.1 且要 uiToken，在这个前提下密钥明文回显便于自查。

## 目录

```
bin/parallel.js        启动器（自动带 --experimental-transform-types）
src/kernel/           内核：总线/配置/存储/报错/限速/调度/会话日志
src/kernel/services/  LLM / 记忆 / 沙箱 / 发送 / MCP 客户端
src/kernel/adapters/  OneBot 11 反向 WS 适配器
src/kernel/api/       REST API + 事件 WS + 静态 UI 服务
src/plugins/          内置插件 11 个（chat / plugin-manager / sandbox / web-search / work 是底座，不在插件页显示；
                      daily-question / link-parser / mc-daily / music-daily / poem-daily / sticker 可玩）
examples/             示例插件（自建模板，含 MCP server 示例）
web/                  桌面端源码（Next.js 15 静态导出）
ui/                   桌面端产物（`npm run build` 生成，不入库）
test/                 单测 + E2E（模拟协议端）
data/                 运行时数据（config.json / secrets.json / parallel.db / sandbox/ / sessions/ / plugins/），不入库
```
