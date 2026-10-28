# 第三方组件与来源声明

本项目自身尚在决定分发许可（仓库根暂无 LICENSE）。下面列出随包运行时组件与已明确标注的借鉴来源；
更细的逐文件来源说明保留在对应源码注释里。

## 运行时依赖（随发布包）

| 组件 | 许可 | 说明 |
|---|---|---|
| `@earendil-works/pi-ai` | MIT | 模型层唯一引擎（三种连接方式） |
| `@earendil-works/pi-agent-core` | MIT | agent loop（轮次/工具调度/事件流/压缩） |
| `ws` | MIT | WebSocket（桌面端事件流与 OneBot 反向 WS） |

上述 npm 包若未在包内附带 LICENSE 原文，以各包 `package.json` 的 `license` 字段与上游仓库为准。

## 桌面端产物（`ui/` 编译内嵌）

`next`、`react`、`react-dom` 均为 MIT。产物由 `web/` 静态导出生成。

## 开发依赖（仅开发期，`--slim` 与常规发布包均不包含）

`typescript`（Apache-2.0）、`@types/*`（MIT）。

## 设计与思想借鉴

- **pi / Pi Agent Harness**：agent loop 与压缩语义、工具面组织方式（依赖使用，非代码拷贝）。
- **ZCode**（Apache-2.0）：工作页活动流与抽屉的交互形态（自行实现，非逐行拷贝）。
- **AstrBot / dsh**：分层与插件组织方式的类比。
- **MaiBot**（GPL-3.0）：拟人化的部分参数、判定逻辑与理由字符串有移植/对齐痕迹
  （见 `src/kernel/humanlike/*.ts` 的头注）。**相关 copyleft 义务尚未完成决策**；
  在所有者明确许可方案前，请勿再分发本项目。
- **HDSI / HDS-Interlude**：节奏反定型、行动窗口、日程的判据顺序与理由字符串参考
  （见 `agency.ts` / `rhythm.ts` / `schedule.ts` 的头注），上游许可待核。

## 素材

- `web/public/assets/login-mesh.jpg`：来自 Unsplash，按 Unsplash License 使用；
  原署名记录在 `ui-legacy/assets/CREDITS.md`（历史存档目录，不入发布包）。
- QQ 表情图片（`web/public/face/*.webp`）：美术版权归腾讯所有，见
  `web/public/face/README.md`；**不单独再分发**。其随仓库/发布包存在的合规性
  待项目所有者决策。
- `logos/`、`gemini/` 为自产/生成的设计过程稿，运行时零引用，不随发布包。
