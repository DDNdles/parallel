'use client';
/** 顶栏圆形工具钮 → 页面的一次性指令通道（各页共用一套，见 App.tsx 的 PAGE_TOOLS） */
import { useEffect, useRef } from 'react';

export interface PageCmd { page: string; kind: string; n: number }

/** 只认发给本页的指令；挂载那一次不算（初值取当前 n，否则切页回来会把旧指令再吃一遍） */
export function usePageCmd(page: string, cmd: PageCmd | undefined, handle: (kind: string) => void) {
  const last = useRef(cmd?.page === page ? cmd.n : -1);
  const cb = useRef(handle);
  cb.current = handle;
  useEffect(() => {
    if (!cmd || cmd.page !== page || cmd.n === last.current) return;
    last.current = cmd.n;
    cb.current(cmd.kind);
  }, [cmd, page]);
}
