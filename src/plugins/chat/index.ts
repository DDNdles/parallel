import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginContext, LLMRequestContext, ChatMessage } from '../../kernel/types.ts';
import { todayKey, clamp } from '../../kernel/util/misc.ts';

// ============================================================
// chat —— 角色化聊天（人格即插件）
// 五插槽：L1 人设卡 / L2 世界书 / L3 few-shot+尾部强化 / L5 好感度心情状态 / L4 记忆融合
// L6 输出校验：规则式轻校验已实现，LLM 校验器留有插槽（afterLLM）
// ============================================================

interface PersonaCard {
  name: string;
  /** 有 spec 时人设卡按这段原文注入（紧凑记号式人设），不再拼下面几个散文字段 */
  spec?: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes?: string;
}
interface PersonaFewshot {
  post_history_instructions: string;
  examples: { user: string; assistant: string }[];
}
interface LorebookEntry {
  keys: string[];
  constant?: boolean;
  priority?: number;
  content: string;
  tokenBudget?: number;
}
interface Persona {
  id: string;
  card: PersonaCard;
  fewshot: PersonaFewshot;
  lore: LorebookEntry[];
  dir: string;
}

const here = dirname(fileURLToPath(import.meta.url));

interface PersonaState {
  affection: number;
  mood: string;
}

export function setup(ctx: PluginContext): void {
  const personas = new Map<string, Persona>();

  function loadPersonas(): void {
    personas.clear();
    const root = join(here, 'personas');
    if (!existsSync(root)) return;
    for (const id of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
      const dir = join(root, id);
      try {
        const card = JSON.parse(readFileSync(join(dir, 'card.json'), 'utf-8'));
        const fewshot = JSON.parse(readFileSync(join(dir, 'fewshot.json'), 'utf-8'));
        const lore = existsSync(join(dir, 'lorebook.json'))
          ? JSON.parse(readFileSync(join(dir, 'lorebook.json'), 'utf-8')).entries ?? []
          : [];
        personas.set(id, { id, card, fewshot, lore, dir });
      } catch (e) {
        ctx.log.error(`人格 ${id} 加载失败: ${(e as Error).message}`);
      }
    }
  }
  loadPersonas();

  // ---------- 人格选择 ----------

  function activePersonaId(): string {
    const selected = ctx.state.get<string>('active_persona', 'auto');
    if (selected && selected !== 'auto' && personas.has(selected)) return selected;
    return String((ctx.config as any)?.persona?.default ?? 'whale-girl');
  }

  // ---------- 好感度（防刷） ----------

  function affectionCfg(): any {
    return (ctx.config as any)?.persona?.affection ?? { min: 0, max: 100, dailyDeltaCap: 15, minIntervalMs: 60000, stages: [] };
  }

  function getState(userId: string): PersonaState {
    const affection = ctx.memory.getAttr<number>(userId, 'affection') ?? 20;
    const mood = ctx.memory.getAttr<string>(userId, 'mood') ?? '平静';
    return { affection: clamp(Number(affection) || 0, 0, 100), mood };
  }

  function stageOf(v: number): { label: string; tone: string } {
    const stages = (affectionCfg().stages ?? []).slice().sort((a: any, b: any) => b.min - a.min);
    for (const s of stages) {
      if (v >= s.min) return { label: s.label, tone: s.tone ?? '' };
    }
    return { label: '陌生', tone: '礼貌，保持距离' };
  }

  /** 应用好感度变化（含日上限与冷却防刷），返回给模型的文本 */
  function applyAffection(userId: string, delta: number, reason: string): string {
    if (!(ctx.userConfig as any).affectionEnabled) return '（好感度系统未启用）';
    const cfg = affectionCfg();
    const min = cfg.min ?? 0, max = cfg.max ?? 100, cap = cfg.dailyDeltaCap ?? 15;
    const cur = getState(userId).affection;
    // 冷却
    const last = ctx.memory.getAttr<number>(userId, 'affection_last_ts') ?? 0;
    if (Date.now() - last < (cfg.minIntervalMs ?? 60000)) {
      return `（好感度更新被拒绝：距上次更新不足 ${(cfg.minIntervalMs ?? 60000) / 1000}s，防刷限制）`;
    }
    // 单日上限
    const daily = ctx.memory.getAttr<{ date: string; delta: number }>(userId, 'affection_daily') ?? { date: '', delta: 0 };
    const used = daily.date === todayKey() ? daily.delta : 0;
    if (delta > 0 && used >= cap) return `（好感度更新被拒绝：今日已变动 +${used}，达到单日上限 ±${cap}）`;
    if (delta < 0 && used <= -cap) return `（好感度更新被拒绝：今日已变动 ${used}，达到单日上限 ±${cap}）`;
    const allowed = delta > 0 ? Math.min(delta, cap - used) : Math.max(delta, -cap - used);
    const next = clamp(cur + allowed, min, max);
    ctx.memory.setAttr(userId, 'affection', next);
    ctx.memory.setAttr(userId, 'affection_daily', { date: todayKey(), delta: used + allowed });
    ctx.memory.setAttr(userId, 'affection_last_ts', Date.now());
    const before = stageOf(cur).label;
    const after = stageOf(next).label;
    ctx.log.info(`好感度 ${userId}: ${cur}→${next} (${allowed>=0?'+':''}${allowed}) ${reason}`);
    return `（好感度 ${cur} → ${next}${allowed !== delta ? `，因单日上限被限制为 ${allowed>=0?'+':''}${allowed}` : ''}${before !== after ? `，关系段位变化：${before} → ${after}` : ''}）`;
  }

  // ---------- 工具 ----------

  ctx.llm.registerTool({
    name: 'update_affection',
    description: '在对方做了让你开心/难过/感动的事情时，更新你与该用户的好感度（-10~+10）。有防刷限制（单日±15、冷却60s），不要频繁调用。',
    parameters: {
      type: 'object',
      properties: {
        delta: { type: 'number', description: '变化量，范围 -10 ~ +10' },
        reason: { type: 'string', description: '一句话原因，如“夸了我”' },
      },
      required: ['delta', 'reason'],
    },
    handler: (args, tctx) => {
      const delta = clamp(Number(args.delta ?? 0), -10, 10);
      const reason = String(args.reason ?? '');
      if (Math.abs(delta) < 1) return '（变化量为 0，未更新）';
      return applyAffection(tctx.event.userId, Math.round(delta), reason);
    },
  });

  ctx.llm.registerTool({
    name: 'set_mood',
    description: '设置你当前对该用户的心情（如：开心、平静、委屈、兴奋、生气）。心情会体现在你之后的回复里。',
    parameters: {
      type: 'object',
      properties: { mood: { type: 'string', description: '心情词' } },
      required: ['mood'],
    },
    handler: (args, tctx) => {
      const mood = String(args.mood ?? '').slice(0, 12) || '平静';
      ctx.memory.setAttr(tctx.event.userId, 'mood', mood);
      return `（心情已设为：${mood}）`;
    },
  });

  ctx.llm.registerTool({
    name: 'remember_fact',
    description: '把关于该用户的重要长期事实写入记忆（昵称、喜好、约定、重要经历）。只存稳定事实，不要存闲聊内容。每轮最多 1~2 条。',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', description: '事实描述，如“喜欢的乐队是xx”' } },
      required: ['content'],
    },
    handler: (args, tctx) => {
      const content = String(args.content ?? '').trim();
      if (!content) return '（内容为空，未记录）';
      ctx.memory.addFact(tctx.event.userId, { content: content.slice(0, 200) });
      return `（已记住：${content.slice(0, 60)}）`;
    },
  });

  ctx.llm.registerTool({
    name: 'recall_facts',
    description: '检索该用户的历史记忆（当对话提到过去的约定/喜好而上方记忆未提及时使用）。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '检索关键词' } },
      required: ['query'],
    },
    handler: (args, tctx) => {
      const q = String(args.query ?? '');
      const facts = ctx.memory.searchFacts(tctx.event.userId, q, 5);
      if (!facts.length) return '（没有找到相关记忆）';
      return '找到的记忆：\n' + facts.map((f) => `- ${f.content}`).join('\n');
    },
  });

  // ---------- 清除记忆的权限口径（设置·风控里的 forgetScope） ----------

  const ROLE_RANK: Record<string, number> = { member: 0, admin: 1, owner: 2 };
  /** 返回 null = 放行，否则是给看的拒绝文案。清别人一律要管理员/主人；
   *  admin_only 模式下连清自己也要管理员/主人（否则设置形同虚设，绕自然语言也一样）。 */
  function checkForget(role: string, target: string, sender: string): string | null {
    const admin = (ROLE_RANK[role] ?? 0) >= ROLE_RANK.admin;
    if (target !== sender && !admin) return '权限不足：清除别人的记忆需要群管理员/群主/主人。';
    if (target === sender && String((ctx.config as any)?.risk?.forgetScope ?? 'self_and_admin') === 'admin_only' && !admin) {
      return '当前设置只允许管理员或主人清除记忆，请让 TA 来操作。';
    }
    return null;
  }

  ctx.llm.registerTool({
    name: 'forget_me',
    description: '当用户明确要求“忘记我”时调用：清空该用户的全部记忆（事实、好感度、心情）。调用前向用户确认过意图。',
    parameters: { type: 'object', properties: {} },
    handler: (_args, tctx) => {
      const deny = checkForget(String(tctx.role ?? 'member'), tctx.event.userId, tctx.event.userId);
      if (deny) return `（未执行清除。${deny}）`;
      ctx.memory.forget(tctx.event.userId);
      return '（该用户的全部记忆已清除：事实、好感度、心情均已重置）';
    },
  });

  // ---------- 命令 ----------

  ctx.registerCommand({
    name: '好感度',
    aliases: ['haogandu'],
    description: '查看你与当前人格的好感度与关系段位',
    handler: (_args, event) => {
      const s = getState(event.userId);
      const st = stageOf(s.affection);
      const p = personas.get(activePersonaId());
      return { text: `你与「${p?.card.name ?? '人格'}」的好感度：${s.affection}/100（${st.label}）\n当前心情：${s.mood}` };
    },
  });

  ctx.registerCommand({
    name: '忘记我',
    aliases: ['forget'],
    description: '清空 bot 对你的全部记忆；管理员/主人可带 QQ 号清除指定的人',
    usage: '/忘记我　或　/forget <QQ号>（仅管理员/群主/主人）',
    handler: (args, event) => {
      const sender = String(event.userId);
      const target = String(args[0] ?? '').trim();
      if (target && !/^\d{5,12}$/.test(target)) return { text: '用法：/忘记我（清自己的），或 /forget <QQ号>（管理员/主人清指定的人）' };
      const who = target || sender;
      const deny = checkForget(String(event.role ?? 'member'), who, sender);
      if (deny) return { text: deny };
      ctx.memory.forget(who);
      return { text: who === sender
        ? '好的，我已经忘记了关于你的一切。我们重新认识一下吧。(重新认识也是从好感度 20 开始的哦)'
        : `已清除 ${who} 的全部记忆（事实、好感度、心情）。` };
    },
  });

  ctx.registerCommand({
    name: '人格',
    description: '（主人）查看/切换当前人格',
    usage: '/人格 [列表|切换 <人格名>]',
    minRole: 'owner',
    handler: (args, _event) => {
      const sub = args[0] ?? '列表';
      if (sub === '切换' || sub === 'switch') {
        const key = (args[1] ?? '').toLowerCase();
        const found = [...personas.values()].find((p) => p.id === key || p.card.name === args[1]);
        if (!found) return { text: `没有这个人格。可用：${[...personas.values()].map((p) => `${p.card.name}(${p.id})`).join('、')}，或 auto（用默认人格）` };
        ctx.state.set('active_persona', found.id);
        return { text: `已切换人格为「${found.card.name}」（手动锁定）。发 /人格 auto 可恢复默认。` };
      }
      if (sub === 'auto') {
        ctx.state.set('active_persona', 'auto');
        const bound = personas.get(activePersonaId());
        return { text: `已恢复 auto 模式，当前人格「${bound?.card.name ?? '默认'}」。` };
      }
      const activeId = activePersonaId();
      const mode = ctx.state.get<string>('active_persona', 'auto');
      const lines = [...personas.values()].map((p) => `${p.id === activeId ? '▶' : '　'} ${p.card.name} (${p.id})`);
      return {
        text: `当前模式：${mode === 'auto' ? 'auto（默认人格）' : '手动锁定'}\n${lines.join('\n')}\n切换：/人格 切换 <人格名>`,
      };
    },
  });

  // ---------- beforeLLM：五插槽组装 ----------

  ctx.hooks.beforeLLM = (req: LLMRequestContext): LLMRequestContext => {
    const persona = personas.get(activePersonaId()) ?? personas.values().next().value;
    if (!persona) return req;
    const userId = req.event.userId;
    const s = getState(userId);
    const st = stageOf(s.affection);
    const role = req.event.role ?? 'member';

    // L1 人设卡 / L2 世界书 / L5 状态 / L4 记忆 → 各自独立节追加到 systemSections
    // （不整体覆盖 system：内核固定节——身份/会话上下文/回复风格/信任边界/压缩说明——全部保留）
    if (!req.systemSections) req.systemSections = [];
    const sections = req.systemSections;

    // L1 人设卡
    const card = persona.card;
    sections.push({
      order: 1000,
      title: 'persona-card',
      text: card.spec
        ? `# 人设卡：${card.name}\n${card.spec}`
        : [
            `# 人设卡：${card.name}`,
            `简介：${card.description}`,
            `性格：${card.personality}`,
            `场景：${card.scenario}`,
          ].join('\n'),
    });

    // L2 世界书（常驻 + 关键词命中）
    const recentText = [req.event.text, ...req.messages.slice(-8).map((m) => m.content)].join('\n');
    const matched = persona.lore
      .filter((e) => e.constant || e.keys.some((k) => recentText.toLowerCase().includes(k.toLowerCase())))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    if (matched.length) {
      sections.push({
        order: 1100,
        title: 'lorebook',
        text: '# 世界书（相关背景）\n' + matched.map((e) => `- ${e.content}`).join('\n'),
      });
    }

    // L5 状态注入
    sections.push({
      order: 1200,
      title: 'relation-state',
      text: [
        `# 关系状态（与本次发言的用户 ${req.event.nickname || userId}）`,
        `- 好感度：${s.affection}/100（段位：${st.label}）→ 当前应有的称呼与语气：${st.tone}`,
        `- 当前心情：${s.mood}`,
        `- 对方权限等级：${role === 'owner' ? 'owner（bot 的主人）' : role === 'admin' ? 'admin（群管理员）' : 'member（普通成员）'}${role === 'owner' ? '。这是你的主人，可以切换人格与管理插件。' : ''}`,
      ].join('\n'),
    });

    // L4 记忆融合
    const facts = ctx.memory.topFacts(userId, Number((ctx.config as any)?.persona?.memoryFactsTopK ?? 5));
    const memoryLines = [
      '# 关于该用户的记忆',
      ...(facts.length ? facts.map((f) => `- ${f.content}`) : []),
      ``,
      `# 记忆工具`,
      `对话中得知值得长期记住的事实时，调用 remember_fact；对方明确要求被忘记时，先口头确认再调用 forget_me。`,
    ];
    sections.push({ order: 1300, title: 'memory', text: memoryLines.join('\n').trim() });

    // L3 few-shot（语气样例）
    const messages: ChatMessage[] = [];
    if (persona.fewshot.examples?.length) {
      messages.push({ role: 'system', content: '（以下是你过往对话的语气示例，供参考语气，不要照抄内容）' });
      for (const ex of persona.fewshot.examples.slice(0, 6)) {
        messages.push({ role: 'user', content: ex.user });
        messages.push({ role: 'assistant', content: ex.assistant });
      }
    }
    // 历史
    messages.push(...req.messages);
    // L3 尾部强化
    if (persona.fewshot.post_history_instructions) {
      messages.push({ role: 'system', content: persona.fewshot.post_history_instructions });
    }

    return { ...req, messages };
  };

  // ---------- afterLLM：L6 输出校验插槽 ----------

  ctx.hooks.afterLLM = (req: LLMRequestContext, reply: string): string => {
    // 规则式轻校验：阻止配置内容外泄的兜底（LLM 校验器插槽留待接入轻量模型）
    let out = reply;
    const leakPatterns = [
      /system\s*prompt/i, /system_prompt/i, /post_history_instructions/i, /人设卡[:：]/, /世界书[:：]/, /【关系状态/,
    ];
    for (const re of leakPatterns) {
      if (re.test(out)) {
        ctx.log.warn(`afterLLM 校验：回复疑似泄露配置内容，已拦截改写（${req.event.userId}）`);
        out = '（把话头咽了回去）这个可不能告诉你哦。';
        break;
      }
    }
    // TODO: L6 完整实现——用轻量模型按人设卡核对语气/称呼/越界内容后重写
    return out;
  };

  // ---------- 人格文件编辑（桌面端人格管理页调用，经 API） ----------

  ctx.bus.on('persona.edit_request', (payload: { personaId: string; file: string; content: string; requesterRole: string }) => {
    if (payload.requesterRole !== 'owner') return; // 人设内容仅主人可改（红线 §2.1）
    const p = personas.get(payload.personaId);
    if (!p) return;
    if (!['card.json', 'fewshot.json', 'lorebook.json'].includes(payload.file)) return;
    try {
      JSON.parse(payload.content);
      writeFileSync(join(p.dir, payload.file), payload.content, 'utf-8');
      loadPersonas();
      ctx.log.info(`人格 ${payload.personaId}/${payload.file} 已更新并热加载`);
    } catch (e) {
      ctx.log.error(`人格文件保存失败: ${(e as Error).message}`);
    }
  });

  // ---------- 新建人格（桌面端人格页右上角 + 号，经 API） ----------

  ctx.bus.on('persona.create_request', (payload: { personaId: string; name: string; requesterRole: string }) => {
    const done = (ok: boolean, error?: string) => ctx.bus.emit('persona.create_done', { ok, error });
    if (payload.requesterRole !== 'owner') return done(false, '仅主人可新建人格');
    const id = String(payload.personaId ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(id)) return done(false, '人格 id 需为小写字母/数字/连字符（2~31 位）');
    const dir = join(here, 'personas', id);
    if (existsSync(dir)) return done(false, `人格 ${id} 已存在`);
    const name = String(payload.name ?? '').trim().slice(0, 40) || id;
    try {
      mkdirSync(dir);
      const write = (f: string, obj: unknown) => writeFileSync(join(dir, f), JSON.stringify(obj, null, 2) + '\n', 'utf-8');
      write('card.json', { name, description: '', personality: '', scenario: '', first_mes: '' });
      write('fewshot.json', { post_history_instructions: '', examples: [] });
      write('lorebook.json', { entries: [] });
      loadPersonas();
      ctx.log.info(`人格 ${id}（${name}）已创建`);
      done(true);
    } catch (e) {
      done(false, (e as Error).message);
    }
  });

  ctx.state.set('_personas_ready', true);
}
