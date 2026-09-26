'use client';
/** 弹窗与表单外壳：模型页与插件页共用，保证两页的对话框、字段、开关长得一样。 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/Icon';

/** 弹窗栈：嵌套时（添加供应商里再弹模型卡片）Escape 只关最上面那层 */
const modalStack: object[] = [];

export function Modal({ title, wide, onClose, children }: {
  title: string; wide?: boolean; onClose: () => void; children: ReactNode;
}) {
  const self = useRef({}).current;
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    modalStack.push(self);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === self) cb.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = modalStack.indexOf(self);
      if (i >= 0) modalStack.splice(i, 1);
    };
  }, [self]);
  return createPortal(
    <div className="mset-ovl" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={'mset-modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="mset-mhead">
          <span>{title}</span>
          <button className="mset-ibtn" onClick={onClose} aria-label="关闭"><Icon name="close" size={15} /></button>
        </div>
        <div className="mset-mbody">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mset-field">
      <label className="mset-flabel">{label}</label>
      {children}
    </div>
  );
}

export function Switch({ on, onChange, title }: { on: boolean; onChange: () => void; title?: string }) {
  return (
    <div className={'switch' + (on ? ' on' : '')} role="switch" aria-checked={on} title={title} onClick={onChange} />
  );
}
