# 第三方组件与来源声明

本项目以 **GNU Affero General Public License v3.0（AGPL-3.0-only）** 发布（见根目录 `LICENSE`）。

为什么是 AGPL：拟人化层里有一处（`src/kernel/humanlike/agency.ts` 的行动容量判定，含其
reason 标记词）是与 HDS-Interlude（AGPL-3.0）`src/agency.ts` 的 `evaluateAgencyCapacity`
逐行级对应的移植——判定顺序、分支结构与标记字符串沿用上游。AGPL-3.0 的作品不能以
GPL-3.0-only 再发布，因此整体采用 AGPL-3.0（它同时覆盖 MaiBot 的 GPL-3.0 义务：
GPLv3 代码可以并入 AGPL-3.0 作品）。人格化聊天其余部分（frequency/jargon/repetition/
rhythm/schedule/delivery 等）为独立实现，仅机制与参数口径参考上游。

AGPL 对你的实际影响：自己用、改了自己用不需要做任何事；**如果你把修改后的版本作为
网络服务提供给他人使用，或对外分发，需要按 AGPL-3.0 提供对应源码**（保留 LICENSE 与
本文件、注明修改）。QQ 表情美术图不属于本项目代码，不随仓库/发布包分发（运行时从
用户本机协议端发行包生成，见下）。

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

- **pi / Pi Agent Harness**（MIT）：agent loop 与压缩语义、工具面组织方式（依赖使用）。
- **ZCode**（Apache-2.0）：工作页活动流与抽屉的交互形态（自行实现，非逐行拷贝）。
- **AstrBot / dsh**：分层与插件组织方式的类比。
- **MaiBot**（GPL-3.0）：发言频率、空窗补偿、退避、黑话学习等机制与参数口径参考
  （见 `src/kernel/humanlike/*.ts` 头注；无源码级复制）。
- **HDS-Interlude**（AGPL-3.0）：节奏反定型、行动窗口、日程的思路参考；
  其中 `agency.ts` 的判定函数为逐行级移植（见顶部说明）。

## 素材

- `web/public/assets/login-mesh.jpg`：来自 Unsplash，按 Unsplash License 使用；
  原署名记录在 `ui-legacy/assets/CREDITS.md`（历史存档目录，不入发布包）。
- QQ 表情图片：美术版权归腾讯所有，**不随本仓库或发布包分发**。运行时所需的表情图由
  内核在首次需要时从用户本机已安装的协议端发行包里转码生成（`ensureFaces` /
  `scripts/build-qq-faces.mjs`），只落在本机 `data/face/`。
- `logos/`、`gemini/` 为自产/生成的设计过程稿，运行时零引用，不随发布包。
