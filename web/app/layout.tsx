import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PARALLEL · QQ bot harness',
  description: '通用 harness 形态的 QQ 机器人 · 桌面端管控',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

// 防闪烁：渲染前同步应用主题（与 localStorage 保存值一致）
const antiFlash = `document.documentElement.dataset.theme = localStorage.getItem('parallel_theme') === 'light' ? 'light' : 'dark';`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: antiFlash }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
