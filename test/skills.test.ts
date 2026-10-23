import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findSkill, readSkillBody, resolveInsideSkill, scanSkills, skillCatalogLines, skillStateKey,
} from '../src/kernel/skills.ts';
import { startApiServer } from '../src/kernel/api/server.ts';

// ============================================================
// 技能库（2026-10-23）
//
//  1. 扫描：目录式（SKILL.md + 附带文件）与平铺 md 都认，user 同名覆盖 builtin；
//  2. 边界：skill_file 只能读技能目录内，绝对路径/.. 一律拒绝；
//  3. 工具面：技能工具只进 work 入口（research/data 白名单里没有就不出现）；
//  4. 开关：桌面端 API 写 plugin_kv，插件立即按新状态回话，停用的技能不进 work 目录；
//  5. skill_install：整个技能目录（含脚本）复制进会话沙箱 .skills/。
// ============================================================

const write = (dir: string, rel: string, text: string): void => {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};

const freePort = () => new Promise<number>((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

test('技能扫描：目录与平铺两种形态，user 覆盖 builtin，frontmatter 与正文分离', () => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-skills-scan-'));
  try {
    const builtin = join(root, 'builtin');
    const user = join(root, 'user');
    write(builtin, 'alpha/SKILL.md', '---\nname: 内置 Alpha\ndescription: 内置版\n---\n旧正文');
    write(builtin, 'alpha/scripts/old.py', 'print(1)');
    write(user, 'alpha/SKILL.md', '---\nname: 用户 Alpha\ndescription: 用户版\n---\n# 正文\n按这个做。');
    write(user, 'alpha/references/spec.md', '规格');
    write(user, 'alpha/scripts/run.py', 'print(2)');
    write(user, 'alpha/logo.bin', 'not really an image');
    write(user, 'beta.md', '---\ndescription: 轻量技能\n---\nbeta 正文');
    mkdirSync(join(user, 'gamma'), { recursive: true }); // 没有 SKILL.md：不是技能
    write(user, 'note.txt', 'x');                        // 非 md：忽略

    const list = scanSkills({ builtinDir: builtin, userDir: user });
    assert.deepEqual(list.map((s) => s.id), ['alpha', 'beta']);

    const a = findSkill(list, 'alpha')!;
    assert.equal(a.name, '用户 Alpha');
    assert.equal(a.description, '用户版');
    assert.equal(a.source, 'user');
    assert.equal(a.attachments.length, 3, '附带文件 = references/scripts/其它二进制，不含 SKILL.md');
    assert.ok(a.attachments.some((x) => x.rel === 'references/spec.md'));
    assert.equal(a.hasScripts, true);
    assert.equal(readSkillBody(a).text.includes('旧正文'), false, 'user 同名技能要覆盖 builtin');
    assert.match(readSkillBody(a).text, /按这个做/);

    const b = findSkill(list, 'beta')!;
    assert.equal(b.dir, '');
    assert.equal(b.description, '轻量技能');
    assert.equal(skillCatalogLines([a])[0], '- 用户 Alpha（alpha）：用户版');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('技能文件边界：越界与绝对路径一律拒绝，平铺 md 只能读自己', () => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-skills-path-'));
  try {
    write(root, 'demo/SKILL.md', '---\nname: demo\n---\n正文');
    write(root, 'demo/references/spec.md', '规格');
    write(root, 'flat.md', '平铺');
    const list = scanSkills({ userDir: root });
    const demo = findSkill(list, 'demo')!;
    const flat = findSkill(list, 'flat')!;

    assert.ok(resolveInsideSkill(demo, 'references/spec.md'));
    assert.ok(resolveInsideSkill(demo, 'SKILL.md'));
    assert.equal(resolveInsideSkill(demo, '../secret.txt'), null);
    assert.equal(resolveInsideSkill(demo, '..\\secret.txt'), null);
    assert.equal(resolveInsideSkill(demo, '/etc/passwd'), null);
    assert.equal(resolveInsideSkill(demo, 'C:\\Windows\\win.ini'), null);

    assert.equal(resolveInsideSkill(flat, 'SKILL.md'), flat.file);
    assert.equal(resolveInsideSkill(flat, 'flat.md'), flat.file);
    assert.equal(resolveInsideSkill(flat, 'other.md'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('技能工具：只进 work 入口、开关即时生效、install 把脚本装配进沙箱', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'parallel-skills-kernel-'));
  const skillsRoot = join(dataDir, 'plugin-data', 'skills');
  write(skillsRoot, 'demo/SKILL.md', '---\nname: 演示技能\ndescription: 用来验证技能工具\n---\n# 步骤\n1. 跑 scripts/hello.py');
  write(skillsRoot, 'demo/scripts/hello.py', 'print("hello")');

  const { Kernel } = await import('../src/kernel/kernel.ts');
  const kernel = new Kernel({ dataDir, noApi: true });
  const cfg = kernel.config.config as any;
  cfg.onebot.port = await freePort();
  cfg.ui.port = await freePort();
  cfg.masterIds = ['10001'];

  const chat = { platform: 'qq' as const, type: 'group' as const, chatId: '9701' };
  await kernel.boot();
  let api: any = null;
  try {
    // ① 工具面：work 面有技能工具，入口 agent 认领；research 的白名单里没有就不出现
    const workTools = kernel.container.toolsForChat(chat, 'admin', 'work').map((t) => t.name);
    for (const n of ['skill', 'skill_file', 'skill_install']) assert.ok(workTools.includes(n), `work 面缺少 ${n}`);
    const entry = kernel.container.workAgent();
    assert.ok(kernel.container.workToolsFor(chat, 'admin', entry, 0).some((t) => t.name === 'skill'));
    const research = kernel.container.listWorkAgents().find((a) => a.name === 'research')!;
    assert.ok(!kernel.container.workToolsFor(chat, 'admin', research, 0).some((t) => t.name === 'skill'),
      '没有把 skill 写进 tools 的子代理不应拿到技能工具');

    const tctx = { chat, role: 'admin', event: { userId: '10001', nickname: '主人' } } as any;
    const skillTool = kernel.container.toolsForChat(chat, 'admin', 'work').find((t) => t.name === 'skill')!;
    const fileTool = kernel.container.toolsForChat(chat, 'admin', 'work').find((t) => t.name === 'skill_file')!;
    const installTool = kernel.container.toolsForChat(chat, 'admin', 'work').find((t) => t.name === 'skill_install')!;

    assert.match(String(await skillTool.handler({ name: 'demo' }, tctx)), /跑 scripts\/hello\.py/);
    assert.match(String(await fileTool.handler({ name: 'demo', path: 'scripts/hello.py' }, tctx)), /print\("hello"\)/);
    assert.match(String(await fileTool.handler({ name: 'demo', path: '../secret.txt' }, tctx)), /路径越界/);

    // ② 目录注入：只在工具面里有 skill 时出现
    const workReq = (tools: any[]) => ({ chat, event: {}, system: '', messages: [], tools, workRunId: 'r1' } as any);
    const withCatalog = await kernel.container.runWorkHooks(workReq([skillTool]));
    const section = (withCatalog.systemSections ?? []).find((s: any) => s.name === 'skill-catalog');
    assert.ok(section, 'work system 里要有技能目录节');
    assert.match(section.text, /演示技能/);
    const without = await kernel.container.runWorkHooks(workReq([]));
    assert.ok(!(without.systemSections ?? []).some((s: any) => s.name === 'skill-catalog'),
      '工具面没有 skill 就不该提技能');

    // ③ 装配进沙箱
    assert.match(String(await installTool.handler({ name: 'demo' }, tctx)), /已装配/);
    const dest = join(kernel.sandbox.root(chat), '.skills', 'demo');
    assert.ok(existsSync(join(dest, 'SKILL.md')));
    assert.ok(existsSync(join(dest, 'scripts', 'hello.py')));

    // ④ 桌面端 API：列表 → 停用 → 插件立即按停用回话、目录节消失 → 再打开
    api = await startApiServer(kernel);
    const base = `http://127.0.0.1:${cfg.ui.port}`;
    const token = kernel.config.secrets.uiToken;
    const getJson = async (p: string) => (await fetch(base + p, { headers: { 'x-auth-token': token } })).json();
    const postJson = async (p: string, body: unknown) => (await fetch(base + p, {
      method: 'POST',
      headers: { 'x-auth-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).json();

    const before = await getJson('/api/skills') as any;
    assert.equal(before.skills.length, 1);
    assert.equal(before.skills[0].id, 'demo');
    assert.equal(before.skills[0].enabled, true);
    assert.ok(String(before.dir).includes('plugin-data'));

    assert.equal((await postJson('/api/skills/toggle', { name: 'demo', enabled: false }) as any).enabled, false);
    assert.equal((await getJson('/api/skills') as any).skills[0].enabled, false);
    assert.equal(kernel.db.get<{ value: string }>('SELECT value FROM plugin_kv WHERE plugin_id=? AND key=?', 'skills', skillStateKey('demo'))?.value,
      JSON.stringify({ enabled: false }));
    assert.match(String(await skillTool.handler({ name: 'demo' }, tctx)), /已停用/);
    const offCatalog = await kernel.container.runWorkHooks(workReq([skillTool]));
    assert.ok(!(offCatalog.systemSections ?? []).some((s: any) => s.name === 'skill-catalog'));

    await postJson('/api/skills/toggle', { name: 'demo', enabled: true });
    assert.match(String(await skillTool.handler({ name: 'demo' }, tctx)), /跑 scripts\/hello\.py/);
  } finally {
    if (api) await new Promise<void>((r) => api.close(() => r()));
    await kernel.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
