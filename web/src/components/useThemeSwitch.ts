'use client';
/**
 * useThemeSwitch —— parallel 主题切换（Next.js/React 全托管）
 *
 * 动效设计：
 * ① 图标元素绑定：`.theme-btn-ic` 挂 view-transition-name，浏览器把它提升为独立 VT 组，
 *    旧图标旋转淡出 / 新图标旋转淡入 = 两组伪元素上的合成动画（GPU，绝对丝滑），
 *    且组位置由浏览器按元素实时跟踪——窗口尺寸变化天然免疫。
 * ② 圆内新主题 / 圆外旧主题：VT 的 new 视图是活渲染，clip-path 圆形揭示。
 *    圆心与最大半径在起手时按图标元素算一次，写进 CSS 变量，之后由 @keyframes 逐帧插值——
 *    动画期间零 JS。原先用 rAF 逐帧驱动：每帧一次 getBoundingClientRect（强制布局）
 *    加三次 :root 自定义属性写入（每次都会让整树样式失效），等于每帧一次抖动，所以发涩。
 * ③ 过渡回调内只动 DOM（data-theme），零 React 渲染——起手不卡；结束后同步状态。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ThemeName = 'dark' | 'light';

export function useThemeSwitch() {
  const [theme, setThemeState] = useState<ThemeName>('dark');
  const switchingRef = useRef(false);

  // 挂载时对齐浏览器里已保存的主题（防闪烁脚本已先行设置 data-theme）
  useEffect(() => {
    setThemeState((document.documentElement.dataset.theme as ThemeName) || 'dark');
  }, []);

  const applySync = useCallback((t: ThemeName) => {
    document.documentElement.dataset.theme = t;
    localStorage.setItem('parallel_theme', t);
    setThemeState(t);
  }, []);

  const switchTo = useCallback((next: ThemeName) => {
    const root = document.documentElement;
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> };
    };
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!doc.startViewTransition || reduced || switchingRef.current) {
      applySync(next);
      return;
    }
    switchingRef.current = true;

    // 圆心 = 主题按钮图标中心；最大半径 = 到视口四角的最远距离。只读一次布局，之后交给 CSS 动画。
    const iconEl = document.querySelector('.theme-btn-ic');
    const rect = iconEl?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : innerWidth / 2;
    const cy = rect ? rect.top + rect.height / 2 : innerHeight / 2;
    const maxR = Math.hypot(Math.max(cx, innerWidth - cx), Math.max(cy, innerHeight - cy));
    root.style.setProperty('--vt-cx', `${cx.toFixed(1)}px`);
    root.style.setProperty('--vt-cy', `${cy.toFixed(1)}px`);
    root.style.setProperty('--vt-max-r', `${maxR.toFixed(1)}px`);

    // 过渡回调：只动 DOM（data-theme 翻转 → 双字形图标/配色即时切换），零 React 渲染
    const vt = doc.startViewTransition(() => {
      root.dataset.theme = next;
      // 起手就落盘：动画这条路径原先漏了这步，切完一刷新就回到旧主题
      localStorage.setItem('parallel_theme', next);
    });

    vt.finished.finally(() => {
      root.classList.remove('theme-leaving', 'theme-entering');
      setThemeState(next); // 过渡已结束，安全同步 React 状态
      switchingRef.current = false;
    }).catch(() => {
      switchingRef.current = false;
    });
  }, [applySync]);

  const toggle = useCallback(() => {
    switchTo(theme === 'light' ? 'dark' : 'light');
  }, [theme, switchTo]);

  return { theme, switchTo, toggle };
}
