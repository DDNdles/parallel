# cover（翻唱）

把现成的歌变成「大肥鱼人声 + 原曲伴奏」，以 QQ `record` 段发出。
服务端（UVR 分离 + FeiyuVoice-RVC）在 `docker/cover/`；本目录是 parallel 插件。

## 音源（插件设置）

| `source` | 说明 |
|---|---|
| `netease`（默认） | 网易云公开搜索/outer 链；VIP/版权曲可能拿不到播放地址 |
| `neteaseApi` | 自部署 NeteaseCloudMusicApi 兼容服务；填 `neteaseApiBaseUrl`（可选 `neteaseApiCookie`）。推荐 [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)（MIT）并开 `ENABLE_GENERAL_UNBLOCK`（全局解灰），VIP/灰色歌自动从酷狗/酷我/咪咕/B站等免费源换流 |
| `custom` | 你自部署/有授权的第三方库；填 `customBaseUrl`（可选 `customToken`） |
| `local` | 本地曲库：默认 `data/music`，可用 `musicDir` 改；支持 mp3/wav/flac/m4a/ogg |

`neteaseApi` 走标准 NeteaseCloudMusicApi 接口：`/search?keywords=`（type=1）拿歌单，`/song/url/v1?id=&level=exhigh` 拿流。
没开解灰的自部署服务对 VIP 歌同样回不了 url，行为跟 `netease` 一样会报「没拿到播放地址」。

`custom` 的最小契约：

```http
GET {customBaseUrl}/search?q=<歌名 歌手>
→ {"songs":[{"id":"...","name":"...","artist":"..."}]}

GET {customBaseUrl}/download?id=<id>
→ 音频字节（mp3/wav/flac/ogg/m4a）
  或 {"url":"https://..."}
```

有 `customToken` 时以 `Authorization: Bearer <token>` 发送。

> 仓库**不内置任何第三方音源地址**。`custom` 只是接口，填什么、有没有授权由使用者自己负责；
> 不要用它接绕过 VIP/DRM 的源。

## 107 半自动登录

翻唱服务部署在 107 时，SCOW 代理需要登录 Cookie。插件页「107 登录」按钮会拉起
`scow-login.mjs`：Playwright 打开平台登录页 → 人工过一次验证码（或统一认证）→
脚本检测到 `SCOW_USER` 且作业 API 200 → 回写 `data/secrets.json` 和插件配置。

- 依赖：`playwright-core` + 系统 Edge/Chrome（不会再下浏览器）。
- 不保存账号密码；浏览器 session 存在 `data/cover/scow-storage-state.json`（gitignored）。
- 状态文件：`data/cover/login-status.json`（桌面页轮询）。
- 全自动识图登录刻意没做：验证码识错重试有锁号风险。

## 验证

```bash
node --experimental-transform-types --no-warnings --test test/cover.test.ts
node src/plugins/cover/scow-login.mjs   # 人工登录（可选）
```
