import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** 流式计算文件的 SHA256（十六进制小写）：第三方发行包解压执行前必须校验 */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolveP, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolveP(h.digest('hex')));
  });
}
