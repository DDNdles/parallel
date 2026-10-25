import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { collectRecentArtifacts, extractArtifacts } from '../src/kernel/services/work.ts';

test('work 产物补扫：收 run 期间新增文件，排除 inbox/技能/缓存/旧文件/内部预览页', () => {
  const root = mkdtempSync(join(tmpdir(), 'work-art-'));
  const now = Date.now();
  const mk = (rel: string, body: string, mtime = now) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    utimesSync(abs, new Date(mtime), new Date(mtime));
  };

  mk('paper/paper.tex', 'tex');
  mk('paper/figs/fig1.png', 'png');
  mk('paper/data/results.csv', 'csv');
  mk('inbox/photo.jpg', 'jpg');                 // 收件箱镜像：不是交付物
  mk('.skills/x/SKILL.md', 'skill');            // 技能装配：不是交付物
  mk('paper/tools/__pycache__/x.pyc', 'pyc');   // 缓存：不是交付物
  mk('paper/figs/_contact.html', 'html');       // 内部预览页：不是交付物
  mk('old.md', 'old', now - 30 * 60_000);       // 本次 run 之前的老文件
  mk('_dev/p_172312.html', 'preview');          // _ 前缀目录（模型内部工作区）：不是交付物

  const out = collectRecentArtifacts(root, now - 5 * 60_000).sort();
  assert.deepEqual(out, ['paper/data/results.csv', 'paper/figs/fig1.png', 'paper/paper.tex']);
  rmSync(root, { recursive: true, force: true });
});

test('extractArtifacts：文本里提到的文件名必须真实存在于沙箱才收（ls 输出不污染交付）', () => {
  const root = mkdtempSync(join(tmpdir(), 'work-ext-'));
  const now = Date.now();
  const mk = (rel: string, body: string) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    utimesSync(abs, new Date(now), new Date(now));
  };
  mk('report.md', 'x');
  mk('town/index.html', 'x');

  // 步骤文本里混着真实文件、ls 看到的旧文件（imagegen/ 下的裸名不存在）、目录名、越界路径
  const steps = [
    '已写入 report.md',
    'drwxr-xr-x imagegen/ doubao_vs_nailong.jpg town/ index.html',
    '读 ../etc/passwd 和 /tmp/x.png 备用',
  ];
  const out = extractArtifacts(steps, root).sort();
  assert.ok(out.includes('report.md'), `应收 report.md：${JSON.stringify(out)}`);
  assert.ok(!out.includes('doubao_vs_nailong.jpg'), 'ls 里出现过的旧文件不能进交付');
  assert.ok(!out.some((p) => p.includes('passwd') || p.includes('tmp')), '越界/绝对路径不能进交付');
  rmSync(root, { recursive: true, force: true });
});
