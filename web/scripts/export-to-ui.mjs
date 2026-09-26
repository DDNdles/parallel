/** 构建后把 Next 静态导出产物同步到内核托管目录 ../ui（运行时零 npm） */
import { rmSync, cpSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));            // web/scripts
const web = dirname(here);                                        // web
const root = dirname(web);                                        // 项目根（parallel/）
const out = join(web, 'out');
const ui = join(root, 'ui');

if (!existsSync(join(out, 'index.html'))) {
  console.error('[export] out/index.html 不存在——先 next build');
  process.exit(1);
}

// 整树替换 ui/（旧版 UI 已备份于 ui-legacy/）
rmSync(ui, { recursive: true, force: true });
mkdirSync(ui, { recursive: true });
cpSync(out, ui, { recursive: true });

if (!existsSync(join(ui, 'index.html'))) {
  console.error('[export] 拷贝后缺少 index.html');
  process.exit(1);
}
const assets = listFiles(join(ui, '_next')).length;
console.log(`[export] ui/ 已更新：index.html + _next/${assets} 个静态资源`);

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out2 = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out2.push(...listFiles(p));
    else out2.push(p);
  }
  return out2;
}
