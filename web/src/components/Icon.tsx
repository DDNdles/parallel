import type { CSSProperties } from 'react';

/** parallel 图标系统：24×24 网格 · stroke 2 · currentColor · outline 风格（沿旧版矢量集） */
const PATHS: Record<string, string> = {
  console: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  chats: '<path d="M8 9h8M8 13h6M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5l-5 3v-3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z"/>',
  plugins: '<path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/><rect x="6" y="6" width="12" height="12" rx="3"/>',
  personas: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  models: '<path d="M12 2.9 20.4 7.5v9L12 21.1 3.6 16.5v-9z"/><path d="M3.6 7.5 12 12.1l8.4-4.6M12 12.1v9"/>',
  memory: '<path d="M12 4a6 6 0 0 1 6 6c0 2.5-1.5 4-2.5 5.5-.6.9-.5 2.5-.5 2.5h-6s.1-1.6-.5-2.5C7.5 14 6 12.5 6 10a6 6 0 0 1 6-6z"/><path d="M10 21h4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1.2-3.2 3.6-5 6.5-5s5.3 1.8 6.5 5"/><circle cx="17.5" cy="9.5" r="2.5"/><path d="M16.5 15.5c2.6.3 4.4 1.9 5 4.5"/>',
  errors: '<path d="M12 3 2.5 20h19z"/><path d="M12 9.5V14M12 17.2v.3"/>',
  sandbox: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M8 15l2-2-2-2"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  pin: '<path d="M9 4h6l-1 7 3.5 3.5a1 1 0 0 1-.7 1.7H7.2a1 1 0 0 1-.7-1.7L10 11z"/><path d="M12 16v4.5"/>',
  group: '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5"/><path d="M16 6.5a3 3 0 0 1 0 5.6M17.5 14.2c1.6.7 2.7 2.3 3.2 4.3"/>',
  friend: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5.5 20c1-4 3.6-6 6.5-6s5.5 2 6.5 6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M9.9 5.9A9.5 9.5 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7M6.6 6.6A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 3.4-.6"/><path d="M10 10a2.8 2.8 0 0 0 4 4"/>',
  collapse: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>',
  moon: '<path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 15V4M7 8l5-5 5 5M4 20h16"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6"/>',
  warn: '<path d="M12 3 2.5 20h19z"/><path d="M12 9.5V14M12 17.2v.3"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  block: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
  /** 「工作」面板动作行的行首图标：执行=console（带框提示符）、编辑=write 铅笔 */
  write: '<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="M14.5 5.5l4 4"/>',
  /** 列表行的拖动把手：三条横线（模型优先级链上下挪动用） */
  grip: '<path d="M5 8.5h14M5 12h14M5 15.5h14"/>',
  think: '<path d="M12 3.5l1.8 4.7 4.7 1.8-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8z"/><path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
  /** 能力图标：文件（文件夹）、联网（地球）、浏览器（带顶栏的窗口）、其他工具（扳手） */
  file: '<path d="M3.5 7a2 2 0 0 1 2-2h3.4l1.9 2.4H18a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.8 2.6 2.8 14.4 0 17"/><path d="M12 3.5c-2.8 2.6-2.8 14.4 0 17"/>',
  browser: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9.2h17"/><path d="M6.4 6.9h.01M9.1 6.9h.01M11.8 6.9h.01"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  /** 模型设置页：更多菜单（实心点，17px 下描边圆会糊成一圈）、当前使用/连接、用量、被锁定的选项 */
  dots: '<circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
  plug: '<path d="M9.5 2.5v5M14.5 2.5v5"/><path d="M6.5 7.5h11v2.6a5.5 5.5 0 0 1-11 0z"/><path d="M12 15.6v5.9"/>',
  bolt: '<path d="M13 2.5 5 14h5.2L9 21.5 19 10h-5.4z"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
  /** 文件类型徽章（行首动作图标之后那枚） */
  fText: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/><path d="M9.5 12h5M9.5 15.5h5"/>',
  fCode: '<path d="M9 8.5L5.5 12 9 15.5"/><path d="M15 8.5 18.5 12 15 15.5"/><path d="M13.2 7.5l-2.4 9"/>',
  fData: '<path d="M12 4c4.4 0 8 .9 8 2v12c0 1.1-3.6 2-8 2s-8-.9-8-2V6c0-1.1 3.6-2 8-2z"/><path d="M20 6c0 1.1-3.6 2-8 2S4 7.1 4 6"/><path d="M20 12c0 1.1-3.6 2-8 2s-8-.9-8-2"/>',
  fImage: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M4 16.5l4.4-4.8 3.2 3.4 2.6-2.4 6 6.3"/><circle cx="9" cy="9.8" r="1.6"/>',
  /** 品牌 mark：∥ 平行符入圆角牌（bot 与人类 QQ 平行交错） */
  brand: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M9.8 16.5l2.7-9"/><path d="M14.6 16.5l2.7-9"/>',
  /** 工作（work 子代理）：素材库（asset-library:mcp-icon，mining）的镐子，实心版。
   *  源素材 https://mdn.alipayobjects.com/infographicservice/afts/img/ez7TQZiWdEYAAAAAQBAAAAgAevFJAQFr/original
   *  是 512 网格的**细线描边**图（8 条子路径勾出轮廓、内部是空的，洪水填充测得 7 处空洞）。
   *  逐条渲染核对后确认：第一条子路径本身就是镐子的外轮廓，单独填充即"外轮廓 1:1、内部填实"
   *  ——与原图逐像素比对，原图有而它没有的像素为 0，多出的部分正好是那 11.4% 空洞面积。
   *  这里用 <g> 把它从 512 网格换算进 24 网格（24/512 = 0.046875），再缩到 18.5 单位居中，
   *  与 moon(17.8) / refresh(18) 等图标的视觉大小对齐。 */
  work: '<g transform="translate(2.75 2.75) scale(0.0361328125)"><path fill="currentColor" stroke="none" d="M457.73 159.5a45.13 45.13 0 0 0 4.1-45.69l23.04-23.04a15 15 0 0 0 4.39-10.6 57.49 57.49 0 0 0-57.42-57.43 15 15 0 0 0-10.61 4.4l-23.04 23.03a45.13 45.13 0 0 0-45.7 4.1 345.85 345.85 0 0 0-219.08-52.67c-14.24 1.38-18.64 20.2-6.4 27.71a1083.26 1083.26 0 0 1 146.57 107.93 45.23 45.23 0 0 0 .99 36.56c-9.31 9.3-240.42 240.4-261.38 261.37a44.97 44.97 0 0 0 0 63.64 44.97 44.97 0 0 0 63.64 0c20.88-20.89 251.97-251.97 261.37-261.38a45.16 45.16 0 0 0 36.55 1 1083.24 1083.24 0 0 1 107.94 146.56c7.47 12.17 26.32 7.92 27.71-6.4a345.86 345.86 0 0 0-52.67-219.08z"/></g>',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 15, style }: { name: string; size?: number; style?: CSSProperties }) {
  const d = PATHS[name] ?? '';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      width={size}
      height={size}
      style={style}
      dangerouslySetInnerHTML={{ __html: d }}
    />
  );
}

/** 命令式场景取 svg 字符串（主题扩散动画的浮动图标用） */
export function iconSvg(name: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ''}</svg>`;
}
