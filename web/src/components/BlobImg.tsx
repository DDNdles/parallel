'use client';
/** 带 token 的图片显示：内核图片端点认 x-auth-token 头，<img> 带不上头，
 *  所以走 api.getBlob 拿 Blob 再 objectURL 显示（卸载即回收）。 */
import { useEffect, useState } from 'react';
import { getBlob } from '@/lib/api';

export function BlobImg({ path, className, zoomable = false, onZoom }: {
  path: string; className?: string; zoomable?: boolean; onZoom?: () => void;
}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let u = '';
    let alive = true;
    getBlob(path)
      .then((b) => { u = URL.createObjectURL(b); if (alive) setUrl(u); })
      .catch(() => { /* 读不到的图留占位块，不在网格里报红 */ });
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [path]);
  if (!url) return <span className={'blob-ph' + (className ? ' ' + className : '')} />;
  const img = <img className={className} src={url} alt="" loading="lazy" />;
  return zoomable
    ? <button className="blob-zoom" title="放大看" onClick={onZoom}>{img}</button>
    : img;
}
