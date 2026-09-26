'use client';
/** 圆角胶囊 + 自定义展开面板的下拉：替代原生 select（人格页的「人格文件」切换器是首个用法） */
import { useState } from 'react';
import { Icon } from '@/components/Icon';

export interface PillOpt { v: string; t: string }

export function PillSelect({ value, options, onChange, label, align = 'right' }: {
  value: string; options: PillOpt[]; onChange: (v: string) => void; label: string; align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pf-switch">
      <button className={'pf-btn' + (open ? ' open' : '')} onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox" aria-expanded={open} aria-label={label}>
        <span>{options.find((o) => o.v === value)?.t ?? value}</span>
        <span className={'pf-chev' + (open ? ' open' : '')}><Icon name="chevron" size={12} /></span>
      </button>
      {open && (
        <>
          <div className="mset-scrim" onClick={() => setOpen(false)} />
          <div className={'pf-menu' + (align === 'left' ? ' left' : '')} role="listbox">
            {options.map((o) => (
              <button key={o.v} role="option" aria-selected={o.v === value}
                className={'pf-item' + (o.v === value ? ' sel' : '')}
                onClick={() => { setOpen(false); if (o.v !== value) onChange(o.v); }}>
                <span>{o.t}</span>
                {o.v === value && <Icon name="check" size={13} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
