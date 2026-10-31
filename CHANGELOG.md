# Changelog

## 0.3.0 (2026-10-31)

分发形态全面铺开的版本：npm 直装、零依赖绿色版、一键安装、winget。

- **npm registry**：包转公开（`private: false`），`npm i -g @ddnoodles/parallel` 直装；Release CI 在配好 `NPM_TOKEN` 后自动 publish。
- **零依赖绿色版**：发布 zip 内置 win-x64 Node 运行时（`runtime/node.exe`，nodejs.org 官方源 + SHA256 校验后入包）与完整 node_modules——不再要求目标机装过 Node；`parallel.cmd` 优先用包内运行时。修复两处 zip 老坑：CI（ubuntu GNU tar）把 `.zip` 打成裸 tar；本地（Git 的 GNU tar 命中后掉进 Compress-Archive 兜底）丢顶层目录。现在压缩后硬校验 PK 魔数与首条目前缀。
- **一键安装**：`scripts/install.ps1`——解析最新 Release、下载解压到 `%LOCALAPPDATA%\Programs\parallel`、加用户 PATH、建开始菜单快捷键；`irm ... | iex` 即用。
- **winget**：`scripts/winget-manifest.mjs` 按版本生成 manifest 三件套（提交官方源走 fork + PR）。
- **其他**：会话页删掉「打断当前回复」按钮；README 截图区精简为拟人化 / 工作真机演示 + 桌面活动流，致谢区 MaiBot / AstrBot 补上链接；仓库 topics 上齐。

## 0.2.1 (2026-10-31)

- **发布包剔除私人插件 cover**（npm files 负 pattern + zip FORBIDDEN 双管），仓库与开发目录保留；插件缺席时 supervisor 不启动、UI 走现成「插件未启用」兜底。
- 修复 CI zip 实为裸 tar（魔数 `para` 非 `PK`）——v0.2.0 的 zip 即此问题，撤回重发。

## 0.2.0 (2026-10-29)

两轮全量审查（131 + 105 条发现）落地后的首个打包版本。

- **安全**：内核日志 token 脱敏；mdLite 链接属性注入 XSS 修复；免 token 端点强制回环来源与 Origin；请求体上限；沙箱真实路径（realpath）校验防符号链接逃逸 + 聊天键消毒；`web_fetch` 拒绝内网/环回/元数据地址；卸载插件清空密钥。
- **资源**：消息积压保护真正生效；work 运行记录内存淘汰；会话列表尾部限窗读；docker 调用全链异步化（不再冻结事件循环）；分群开关缓存；全局执行并发帽；python 桥超时中断；沙箱配额/TTL 真实扫盘。
- **业务/前端**：work 汇报轮结构化标记；派活归属取实际说话人；桌面端打断按钮、发送失败反馈、会话页竞态守卫；人格写入 `data/personas`（不再改源码树）；内核身份节不再写死人格；core 插件不受分群开关约束（修复新装实例 chat 不生效）；环境检查走过一次不再重复拦截。
- **分发**：协议端发行包官方源优先 + SHA256 校验；发布脚本干净树闸门；`logos/`、`ref/`、`__pycache__` 不入发布物。
- **许可与素材**：许可证定为 **AGPL-3.0-only**（`agency.ts` 行动容量判定为 HDS-Interlude 逐行移植，见 `THIRD-PARTY-NOTICES.md`）；258 张腾讯版权 QQ 表情移出仓库与发布包，运行时由内核从本机协议端发行包转码生成到 `data/face/`。
- **打包**：npm 化（`bin`/`files`/`engines`/prepack 检查），GitHub Actions CI 与 tag→Release 自动出 `.tgz` + `.zip`；全局安装时数据目录落在用户工作目录；npm 包内带编译产物 `dist/`（Node 拒绝对 node_modules 里的 TS 做类型剥离，安装版必须跑编译 JS，开发/zip 仍直跑 TS 源码）。

## 0.1.0 (2026-10-28)

首个可用快照：内核（agent loop / Pipeline / 拟人层 / 沙箱 / 插件容器）+ 9 个内置插件 + 桌面端（14 页）。
