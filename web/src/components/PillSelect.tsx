'use client';
/** 圆角胶囊 + 自定义展开面板的下拉：替代原生 select（人格页的「人格文件」切换器是首个用法） */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/Icon';

export interface PillOpt { v: string; t: string }

export function PillSelect({ value, options, onChange, label, align = 'right', portal = false, compact = false }: {
  value: string; options: PillOpt[]; onChange: (v: string) => void; label: string;
  align?: 'left' | 'right';
  /** 渲染到 body 并固定定位：用来避开左栏/弹窗的 overflow 裁剪（模型链行里的思考强度） */
  portal?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);

  const toggle = () => {
    if (!open && portal && btn.current) {
      const r = btn.current.getBoundingClientRect();
      const w = 148;
      const h = Math.min(260, options.length * 32 + 12);
      const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w));
      const top = r.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6;
      setPos({ top, left });
    }
    setOpen((v) => !v);
  };
  useEffect(() => {
    if (!open || !portal) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, portal]);

  const menu = (
    <div className={'pf-menu' + (align === 'left' ? ' left' : '') + (compact ? ' pf-compact' : '')} role="listbox"
      style={portal && pos ? { position: 'fixed', top: pos.top, left: pos.left, right: 'auto', width: 148 } : undefined}>
      {options.map((o) => (
        <button key={o.v} role="option" aria-selected={o.v === value}
          className={'pf-item' + (o.v === value ? ' sel' : '')}
          onClick={() => { setOpen(false); if (o.v !== value) onChange(o.v); }}>
          <span>{o.t}</span>
          {o.v === value && <Icon name="check" size={13} />}
        </button>
      ))}
    </div>
  );

  return (
    <div className="pf-switch">
      <button ref={btn} className={'pf-btn' + (open ? ' open' : '')} onClick={toggle}
        aria-haspopup="listbox" aria-expanded={open} aria-label={label}>
        <span>{options.find((o) => o.v === value)?.t ?? value}</span>
        <span className={'pf-chev' + (open ? ' open' : '')}><Icon name="chevron" size={12} /></span>
      </button>
      {open && (portal ? createPortal(
        <>
          <div className="mset-scrim" onClick={() => setOpen(false)} />
          {menu}
        </>,
        document.body,
      ) : (
        <>
          <div className="mset-scrim" onClick={() => setOpen(false)} />
          {menu}
        </>
      ))}
    </div>
  );
}
