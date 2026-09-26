import type { PluginContext } from '../../kernel/types.ts';

// ============================================================
// link-parser —— B 站/小红书链接解析（todo 骨架）
// B 站：使用无需登录的公开接口（api.bilibili.com/x/web-interface/view）。
// 小红书：无稳定公开 API（反爬强），v1 只做识别+提示（TODO: v2 接解析服务）。
// ============================================================

const BV_RE = /(BV[0-9A-Za-z]{10})|(av(\d+))/i;
const XHS_RE = /https?:\/\/(www\.)?xiaohongshu\.com\/(explore|discovery\/item)\/[0-9a-zA-Z]+/i;
const URL_RE = /https?:\/\/[^\s，。,]+/i;

interface Parsed {
  kind: 'bilibili' | 'xiaohongshu' | 'unknown';
  text: string;
}

async function parseLink(url: string): Promise<Parsed> {
  // B 站
  const bv = url.match(BV_RE);
  if (bv) {
    const id = bv[1] ?? `av${bv[3]}`;
    try {
      const resp = await fetch(`https://api.bilibili.com/x/web-interface/view?${bv[1] ? 'bvid=' + bv[1] : 'aid=' + bv[3]}`, {
        headers: { 'user-agent': 'Mozilla/5.0 parallel-bot' },
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json() as any;
      if (data?.code === 0) {
        const v = data.data;
        return {
          kind: 'bilibili',
          text: `📺 ${v.title}\nUP: ${v.owner?.name ?? '?'}  播放 ${v.stat?.view ?? '?'}  弹幕 ${v.stat?.danmaku ?? '?'}\n${String(v.desc ?? '').slice(0, 120)}\nhttps://www.bilibili.com/video/${bv[1] ?? id}`,
        };
      }
      return { kind: 'bilibili', text: `（B 站视频 ${id}：接口返回 ${data?.code}，无法取到简介）` };
    } catch (e) {
      return { kind: 'bilibili', text: `（B 站视频 ${id}：解析失败 ${(e as Error).message}）` };
    }
  }
  // 小红书：仅识别 + 提示
  if (XHS_RE.test(url)) {
    return {
      kind: 'xiaohongshu',
      // TODO: 小红书反爬强，v2 接入解析服务（第三方解析 API 或无头浏览器快照）
      text: '（识别到小红书链接。小红书反爬较强，暂不支持解析内容摘要，建议直接打开查看～）',
    };
  }
  return { kind: 'unknown', text: '' };
}

export function setup(ctx: PluginContext): void {
  ctx.llm.registerTool({
    name: 'parse_link',
    description: '解析 B 站视频/小红书链接，返回标题、UP主/作者、简介摘要。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '链接' } },
      required: ['url'],
    },
    handler: async (args) => {
      const r = await parseLink(String(args.url ?? ''));
      return r.text || '（不是可识别的链接）';
    },
  });

  ctx.hooks.onChatMessage = (event) => {
    const urlMatch = event.text.match(URL_RE);
    if (!urlMatch) return;
    const url = urlMatch[0];
    const isBv = BV_RE.test(event.text) || url.includes('bilibili.com');
    const isXhs = XHS_RE.test(url);
    if (!isBv && !isXhs) return;
    void (async () => {
      try {
        const r = await parseLink(url);
        if (r.text) await ctx.chat.reply(event, r.text);
      } catch (e) {
        ctx.log.error(`链接解析失败: ${(e as Error).message}`);
      }
    })();
    // TODO: 防重（同一链接短时间只解析一次）
  };
}
