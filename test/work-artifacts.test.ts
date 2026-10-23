import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { collectRecentArtifacts } from '../src/kernel/services/work.ts';

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

  const out = collectRecentArtifacts(root, now - 5 * 60_000).sort();
  assert.deepEqual(out, ['paper/data/results.csv', 'paper/figs/fig1.png', 'paper/paper.tex']);
  rmSync(root, { recursive: true, force: true });
});
