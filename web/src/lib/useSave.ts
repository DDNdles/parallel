'use client';
/** 写入失败的就地报错（全站不用 toast：只有模型连接测试与依赖检测才允许提示条） */
import { useCallback, useState } from 'react';
import { post } from './api';

export function useSave() {
  const [err, setErr] = useState('');
  /** 给手写 try/catch 的流程用：把异常转成就地红字 */
  const fail = useCallback((e: unknown) => setErr(`未保存：${(e as Error)?.message ?? String(e)}`), []);
  /** 跑一次写入：成功清掉旧错误并执行 after，失败把原因留下就地显示 */
  const run = useCallback((fn: () => Promise<unknown>, after?: () => void) => {
    fn().then(() => { setErr(''); after?.(); }).catch(fail);
  }, [fail]);
  const save = useCallback((path: string, body?: unknown, after?: () => void) =>
    run(() => post(path, body ?? {}), after), [run]);
  return { err, setErr, fail, run, save };
}
