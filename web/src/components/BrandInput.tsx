'use client';
/** 全站统一的文本输入控件：文字由"文本层"显示，插入光标是层内的内联元素 = parallel 品牌花押。
 *  与会话页 composer 同一手法（那里是内联实现，这里把它做成可复用组件）：
 *  真控件铺在下面负责输入与选区（文字与原生 caret 都透明），文本层照抄它的字体/内边距来对齐。 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react';
import { Icon } from '@/components/Icon';

type Field = HTMLInputElement | HTMLTextAreaElement;

interface Props {
  value: string | number;
  onChange: (e: ChangeEvent<Field>) => void;
  placeholder?: string;
  /** text / password（password 在文本层里画圆点，绝不回显原文）
   *  number = 只收数字：底层仍是 text（number 类型读 selectionStart 会抛，光标没法镜像），
   *  顺带也就没有右侧那对上下箭头；decimal = 数字档额外保留一个小数点（频率这类 0-1 字段） */
  type?: 'text' | 'password' | 'number';
  decimal?: boolean;
  multiline?: boolean;
  rows?: number;
  /** 多行框随内容长高（下限=rows 撑出来的高度）。固定高度的框装不下内容时会把最后半行字裁掉，
   *  长高后真控件永远不用滚动，也就没有了文本层与控件失同步的机会。 */
  grow?: boolean;
  autoFocus?: boolean;
  spellCheck?: boolean;
  id?: string;
  /** 布局样式挂在包裹层上（宽度/flex 由外层决定），字号字体等仍由真控件的既有 CSS 决定 */
  style?: CSSProperties;
  className?: string;
  onKeyDown?: (e: KeyboardEvent<Field>) => void;
  /** 交给浏览器别记住/回填这一格：密钥类输入用 new-password，删掉的 key 才不会在下次挂载时被自动填回来 */
  autoComplete?: string;
  onBlur?: (e: FocusEvent<Field>) => void;
  onFocus?: (e: FocusEvent<Field>) => void;
}

/** 文本层必须与真控件逐字对齐：这些计算样式原样抄过去，内边距另加控件的边框宽度 */
const COPY = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textIndent', 'textTransform'] as const;

export function BrandInput({
  value, onChange, placeholder, type = 'text', decimal = false, multiline = false, rows = 4, grow = false,
  autoFocus, spellCheck = false, id, style, className, onKeyDown, onBlur, onFocus, autoComplete,
}: Props) {
  const fieldRef = useRef<Field | null>(null);
  const layerRef = useRef<HTMLSpanElement | null>(null);
  const [caret, setCaret] = useState({ on: false, pos: 0 });

  const sync = useCallback(() => {
    const f = fieldRef.current, layer = layerRef.current;
    if (!f) return;
    const focused = document.activeElement === f;
    const collapsed = (f.selectionStart ?? 0) === (f.selectionEnd ?? 0);
    const on = focused && collapsed;
    const pos = on ? (f.selectionStart ?? f.value.length) : 0;
    setCaret((c) => (c.on === on && c.pos === pos ? c : { on, pos }));
    if (!layer) return;
    const cs = getComputedStyle(f);
    for (const k of COPY) layer.style[k] = cs[k];
    const px = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    const py = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
    const pr = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
    layer.style.padding = `${py}px ${pr}px ${py}px ${px}px`;
    /* 同步滚动只能让层"自己滚"：transform 会把裁剪框一起搬走，文字整块飘到框外压住上面的标题。
       overflow:hidden 仍然允许程序滚动，所以层的盒子始终钉在控件上。 */
    if (layer.scrollTop !== f.scrollTop) layer.scrollTop = f.scrollTop;
    if (layer.scrollLeft !== f.scrollLeft) layer.scrollLeft = f.scrollLeft;
  }, []);

  useEffect(() => { sync(); }, [value, sync]);
  /* rows 撑出来的高度就是长高的下限，只在第一次量（之后 height 已被我们写死，量不到原值） */
  const minH = useRef(0);
  const refit = useCallback(() => {
    if (!grow || !multiline) return;
    const f = fieldRef.current as HTMLTextAreaElement | null;
    if (!f) return;
    f.style.height = 'auto';
    const cs = getComputedStyle(f);
    /* textarea 的 height:auto 仍取 rows（不是内容高），内容高只能读 scrollHeight；
       scrollHeight 含 padding 不含 border，而全站是 border-box，所以补回上下边框。 */
    const nat = f.getBoundingClientRect().height;
    const need = f.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    if (!minH.current) minH.current = nat;
    f.style.height = `${Math.max(need, minH.current)}px`;
  }, [grow, multiline]);
  useEffect(() => { refit(); sync(); }, [value, refit, sync]);
  useEffect(() => {
    const bump = () => setTimeout(sync, 0);
    const onResize = () => { refit(); sync(); };
    document.addEventListener('selectionchange', sync);
    document.addEventListener('focusin', bump);
    document.addEventListener('focusout', bump);
    document.addEventListener('mousedown', bump);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('selectionchange', sync);
      document.removeEventListener('focusin', bump);
      document.removeEventListener('focusout', bump);
      document.removeEventListener('mousedown', bump);
      window.removeEventListener('resize', onResize);
    };
  }, [sync, refit]);

  const shown = type === 'password' ? '•'.repeat(String(value).length) : String(value);
  /* 上下键步进：原生 number 的箭头没了，但改数量的手感要留着（这些框都是尺寸/超时/端口，不给负数）。
     走 onChange 而不是改 DOM 再派发 input——React 的 value tracker 会吃掉自己赋值后的事件，
     真控件更新了、文本层却没跟上。数字档的 onChange 只保证 e.target.value 可读。 */
  const step = (d: number) => {
    const next = String(Math.max(0, (Number(shown) || 0) + d));
    if (next !== shown) onChange({ target: { value: next } } as unknown as ChangeEvent<Field>);
  };
  const keyDown = (e: KeyboardEvent<Field>) => {
    if (type === 'number' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      step(e.key === 'ArrowUp' ? 1 : -1);
      return;
    }
    onKeyDown?.(e);
  };
  /* 数字档：先抹掉非数字再往上抛。直接改 e.target.value 而不是伪造事件——
     事件对象指向真控件，改完读到的就是干净值，显示层也才不会和 DOM 脱节。
     decimal 档保留第一个小数点（频率 0-1；整数档维持原来的纯数字过滤）。 */
  const change = (e: ChangeEvent<Field>) => {
    if (type === 'number') {
      const keep = decimal ? e.target.value.replace(/[^\d.]/g, '') : e.target.value.replace(/\D/g, '');
      const clean = decimal ? keep.replace(/(\..*)\./g, '$1') : keep;
      if (clean !== e.target.value) e.target.value = clean;
    }
    onChange(e);
  };
  /* 空内容且光标亮起时，占位文字改由文本层画：原生占位从 padding-left 起排，
     会和 13px 宽的品牌光标叠在同一个字上，而文本层里的占位能被光标挤到右边 */
  const ownPh = !!placeholder && !shown && caret.on;
  const bind = {
    ref: fieldRef as never,
    value,
    onChange: change,
    placeholder: ownPh ? undefined : placeholder,
    'aria-label': placeholder,
    autoFocus,
    spellCheck,
    id,
    autoComplete,
    onKeyDown: keyDown,
    onFocus: (e: FocusEvent<Field>) => { sync(); onFocus?.(e); },
    onBlur: (e: FocusEvent<Field>) => { setCaret((c) => (c.on ? { on: false, pos: 0 } : c)); onBlur?.(e); },
    onScroll: sync,
    style: { color: 'transparent', caretColor: 'transparent' } as CSSProperties,
    className: 'bfield-field',
  };
  const layer = (
    <span className={'bfield-text' + (multiline ? '' : ' single')} ref={layerRef} aria-hidden>
      {shown.slice(0, caret.on ? caret.pos : shown.length)}
      {caret.on && <span className="caret-slot"><Icon name="brand" size={13} /></span>}
      {caret.on ? shown.slice(caret.pos) : ''}
      {ownPh && <span className="bfield-ph">{placeholder}</span>}
    </span>
  );

  return (
    <span className={'bfield' + (className ? ' ' + className : '')} style={style}>
      {multiline
        ? <textarea {...bind} rows={rows} />
        : <input {...bind} type={type === 'number' ? 'text' : type} inputMode={type === 'number' ? 'numeric' : undefined} />}
      {layer}
    </span>
  );
}
