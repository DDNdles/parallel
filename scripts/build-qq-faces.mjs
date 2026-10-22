/**
 * 生成 QQ 经典表情的本地资源与名称表。
 *
 * 图片源：LLBot 自带 WebUI 的 face/*.png（128px APNG，QQ 表情原图）。
 * 这里统一转成 64px 静态 WebP 放进 web/public/face/，让桌面端直接用 <img> 内联；
 * 名称表从 scripts/qq-faces.json（OneBot/QQ 表情 ID→中文名）生成后端与前端两份 TS。
 *
 * 用法：node scripts/build-qq-faces.mjs [源目录]
 * 默认源目录：data/llbot/bin/llbot/webui/face
 *
 * 注：表情美术版权归腾讯所有，这里只为本机桌面端展示而转码；不要单独再分发这套图片。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const srcDir = resolve(process.argv[2] || join(root, 'data/llbot/bin/llbot/webui/face'));
const outDir = join(root, 'web/public/face');
const ffmpeg = existsSync(join(root, 'data/bin/ffmpeg.exe')) ? join(root, 'data/bin/ffmpeg.exe') : 'ffmpeg';

if (!existsSync(srcDir)) {
  console.error(`找不到表情源目录：${srcDir}\n先让内核拉好 LLBot（有头/无头都带 webui/face），或用参数指定目录。`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const pngs = readdirSync(srcDir).filter((f) => /^\d+\.png$/.test(f)).sort((a, b) => Number(a) - Number(b));
let converted = 0;
for (const f of pngs) {
  const id = f.replace(/\.png$/, '');
  const out = join(outDir, `${id}.webp`);
  // 第一帧即可：聊天里 20px 的内联表情，动图收益很小，体积却差 30 倍
  const r = spawnSync(ffmpeg, [
    '-y', '-loglevel', 'error', '-i', join(srcDir, f),
    '-vf', 'scale=64:64:flags=lanczos', '-frames:v', '1',
    '-c:v', 'libwebp', '-quality', '80', out,
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`转换失败：${f}`);
  converted++;
}

const names = JSON.parse(readFileSync(join(root, 'scripts/qq-faces.json'), 'utf-8'));
const entries = Object.entries(names).sort((a, b) => Number(a[0]) - Number(b[0]));
const body = entries.map(([id, name]) => `  '${id}': ${JSON.stringify(name)},`).join('\n');
const ts = `// 由 scripts/build-qq-faces.mjs 从 scripts/qq-faces.json 生成，勿手改。\nexport const QQ_FACE_NAMES: Record<string, string> = {\n${body}\n};\n`;
writeFileSync(join(root, 'src/kernel/util/qqface-names.ts'), ts);
writeFileSync(join(root, 'web/src/lib/qqFaceNames.ts'), ts);
writeFileSync(join(outDir, 'README.md'), [
  '# QQ 表情资源',
  '',
  '`<id>.webp` 由 `scripts/build-qq-faces.mjs` 从 LLBot WebUI 自带的 QQ 表情 APNG 转码而来（64×64 静态 WebP）。',
  '表情美术版权归腾讯所有，仅用于本机桌面端展示，不要单独分发这些图片。',
  '',
  `共 ${converted} 个；名称表见 ` + '`scripts/qq-faces.json`。',
  '',
].join('\n'));

console.log(`完成：${converted} 个表情 → ${outDir}`);
console.log(`名称表：${entries.length} 条 → src/kernel/util/qqface-names.ts / web/src/lib/qqFaceNames.ts`);
