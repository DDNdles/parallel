'use client';
/**
 * 左栏名字：不截断不打点，超出就把右端渐隐掉；悬停/选中时整行来回滚动把名字读完。
 * 与会话页左栏 `ChatName` 同一套口径（量一次「文字宽 - 容器宽」作为位移距离）。
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/** 右端渐隐带宽度（px），与 globals.css 的 --nm-fade 默认值一致 */
const NAME_FADE = 24;
/** 最长横向位移：work 的任务名是整段任务（可能 200 字），按原速滚完要一分多钟；
 *  这里只滚一小段让人看出「后面还有」，完整文本靠 title 悬停读。 */
const MAX_SHIFT = 220;

export function FadeName({ text, className = 'mset-item-nm' }: { text: string; className?: string }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const [scroll, setScroll] = useState<{ shift: number; dur: number } | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const tt = box.firstElementChild as HTMLElement | null;
      if (!tt || box.clientWidth < 40) return;   // 折叠中/未布局时量出来的宽度没意义
      // 多滚一个渐隐带 + 4px：滚到最远端时名字尾巴停在渐隐带之前，整名是全亮的
      const over = tt.scrollWidth - box.clientWidth;
      const shift = over > 1 ? Math.min(over + NAME_FADE + 4, MAX_SHIFT) : 0;
      setScroll((p) => {
        if (!shift) return p ? null : p;
        // 滚动速度 ~24px/s（比初版慢 30%，长名字也来得及读）；超长任务名封顶 8.5s
        return p && p.shift === shift ? p : { shift, dur: Math.max(2.9, Math.min(8.5, shift / 23.8)) };
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    // 悬停时行内布局可能变化（状态点/操作键浮出），进出各补量一次
    const row = box.closest('.mset-item');
    row?.addEventListener('mouseenter', measure);
    row?.addEventListener('mouseleave', measure);
    if (document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {});
    return () => {
      ro.disconnect();
      row?.removeEventListener('mouseenter', measure);
      row?.removeEventListener('mouseleave', measure);
    };
  }, [text]);

  return (
    <span
      ref={boxRef}
      className={className + (scroll ? ' ovf' : '')}
      style={scroll ? ({
        '--nm-fade': `${NAME_FADE}px`,
        '--nm-shift': `${scroll.shift}px`,
        '--nm-dur': `${scroll.dur.toFixed(2)}s`,
      } as CSSProperties) : undefined}
    >
      <span className="tt">{text}</span>
    </span>
  );
}
