'use client';
/** 行内问号提示：悬停/聚焦浮出说明卡（与站内浮层同一配方）。
 *  默认向右展开；悬停时现场测量——贴着裁剪容器（.mset-detail 的 overflow-x:hidden）或视口
 *  右缘时自动向左翻，否则说明卡会被裁掉半张。 */
import { useRef, useState } from 'react';
import { Icon } from '@/components/Icon';

export default function Hint({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [flip, setFlip] = useState(false);
  const place = () => {
    const el = ref.current;
    const pop = el?.querySelector<HTMLElement>('.mset-hint-pop');
    if (!el || !pop) return;
    let p: HTMLElement | null = el.parentElement;
    let clipper: HTMLElement | null = null;
    while (p) {
      if (getComputedStyle(p).overflowX !== 'visible') { clipper = p; break; }
      p = p.parentElement;
    }
    const limit = clipper ? clipper.getBoundingClientRect().right : window.innerWidth;
    setFlip(el.getBoundingClientRect().right + 9 + pop.offsetWidth > limit - 8);
  };
  return (
    <span ref={ref} className="mset-hint" tabIndex={0} aria-label={text} onMouseEnter={place} onFocus={place}>
      <Icon name="help" size={13} />
      <span className="mset-hint-pop" data-flip={flip || undefined}>{text}</span>
    </span>
  );
}
