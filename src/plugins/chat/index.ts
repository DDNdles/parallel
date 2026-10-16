import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginContext, LLMRequestContext, ChatMessage } from '../../kernel/types.ts';

// ============================================================
// chat —— 角色化聊天（人格即插件）
//
// 设定层照 HDSI（HDS Interlude）的分层来组织，替代原来的「人设卡 + 世界书 + few-shot」三件套：
//   Canon       —— 初始设定（主角记号 / 世界 / 配角 / 语言），剧情起点，只由人写
//   Perspective —— 独立于 Canon 的个体价值观：「她怎么看待世界」，不是设定条目
//   Overlay     —— **演化层**：长期剧情里渐进形成的稳定变化（性格/世界/关系），非破坏性；
//                  由模型经 `remember_setting` 提议写入，不动 Canon
//   Voice       —— 说话方式与语气样例（原 few-shot）
//   Lore        —— 关键词命中的世界事实（保留：HDSI 的 Canon 里也有世界事实）
// 注入顺序：script(1000) → perspective(1040) → overlay(1050) → lore(1100) → 对方是谁(1200) → 记忆(1300)
// ============================================================

interface LorebookEntry {
  keys: string[];
  constant?: boolean;
  priority?: number;
  content: string;
  tokenBudget?: number;
}

/** HDSI 式剧本：canon.json */
interface PersonaCanon {
  name: string;
  canon: {
    /** 主角记号（原人设卡的 spec，原文保留） */
    protagonist: string[];
    /** 世界事实（剧情起点） */
    world: string[];
    /** 配角与初始关系：Canon 配角只是"可用角色"，不等于在场 */
    cast?: { name: string; relation: string }[];
    language?: string;
  };
  /** 独立于 canon 的个体价值观（HDSI Perspective） */
  perspective?: string;
  voice: {
    style?: string;
    examples: { user: string; assistant: string }[];
    post_history?: string;
  };
  lore: LorebookEntry[];
}

/** Overlay 层的一条：长期剧情里形成的稳定变化（HDSI 要求可追溯来源） */
interface OverlayEntry {
  layer: 'character' | 'world' | 'relationship' | 'perspective';
  /** relationship 层的对象（用户 QQ）；其余层留空 = 全局 */
  targetId?: string;
  content: string;
  /** 从哪句话推出来的 */
  source?: string;
  at: number;
}

interface Persona {
  id: string;
  canon: PersonaCanon;
  dir: string;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Overlay 层的容量：太多了会淹没 Canon，超过就把最旧的挤掉 */
const OVERLAY_MAX = 24;
const OVERLAY_LAYERS = ['character', 'world', 'relationship', 'perspective'] as const;
const OVERLAY_LAYER_LABEL: Record<string, string> = {
  character: '性格', world: '世界', relationship: '关系', perspective: '价值观',
};

export function setup(ctx: PluginContext): void {
  const personas = new Map<string, Persona>();

  function loadPersonas(): void {
    personas.clear();
    const root = join(here, 'personas');
    if (!existsSync(root)) return;
    for (const id of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
      const dir = join(root, id);
      try {
        const canon = JSON.parse(readFileSync(join(dir, 'canon.json'), 'utf-8')) as PersonaCanon;
        if (!canon?.canon || !Array.isArray(canon.canon.protagonist)) throw new Error('canon.json 缺少 canon.protagonist');
        canon.lore = Array.isArray(canon.lore) ? canon.lore : [];
        canon.voice = canon.voice ?? { examples: [] };
        personas.set(id, { id, canon, dir });
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

  // ---------- 工具 ----------

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
    description: '检索 bot 为这位用户存过的长期事实（昵称、喜好、约定、经历）。你只看得到最近几分钟的消息，凡对方提到「上次、以前、说好了的」而眼前信息对不上，就先查这里再回答。',
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

  // 上下文窗口外的旧消息平时看不到，这是她"翻旧账"的通道：按关键词搜本会话的历史原文。
  // 只搜当前会话（群/私聊各自独立），工具面不提供跨会话检索。
  ctx.llm.registerTool({
    name: 'search_history',
    description: '检索本会话更早的聊天记录原文（上下文时限之外的旧消息，带时间与说话人）。当话题涉及「之前、上次、我们说过什么」而最近几分钟的上下文不够时使用。只搜当前会话，按关键词匹配。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，在消息原文里匹配' },
        limit: { type: 'number', description: '最多返回几条，缺省 20' },
      },
      required: ['query'],
    },
    handler: (args, tctx) => {
      const q = String(args.query ?? '').trim();
      if (!q) return '（关键词为空）';
      const limit = Math.max(1, Math.min(Math.round(Number(args.limit) || 20), 50));
      let hits;
      try {
        hits = ctx.history.searchMessages(tctx.chat, q, limit);
      } catch (e) {
        return `（检索不可用：${(e as Error).message}）`;
      }
      if (!hits.length) return '（没有找到相关消息）';
      const fmt = (ts: number) => {
        const d = new Date(ts);
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      };
      // 每条截 200 字：50 条 × 200 字封顶，别让一次翻旧账把上下文顶爆
      return `找到 ${hits.length} 条相关消息：\n` +
        hits.map((h) => `- [${fmt(h.ts)}] ${h.role === 'user' ? (h.nickname || '用户') : '我'}：${h.text.slice(0, 200)}`).join('\n');
    },
  });

  // ---------- 清除记忆的权限口径（设置·风控里的 forgetScope） ----------

  const ROLE_RANK: Record<string, number> = { member: 0, admin: 1, owner: 2 };
  /** 返回 null = 放行，否则是给看的拒绝文案。清别人一律要管理员/主人；
   *  admin_only（默认）模式下连清自己也要管理员/主人（否则形同虚设，绕自然语言也一样）。 */
  function checkForget(role: string, target: string, sender: string): string | null {
    const admin = (ROLE_RANK[role] ?? 0) >= ROLE_RANK.admin;
    if (target !== sender && !admin) return '权限不足：清除别人的记忆需要群管理员/群主/主人。';
    if (target === sender && String((ctx.config as any)?.risk?.forgetScope ?? 'admin_only') === 'admin_only' && !admin) {
      return '只有管理员或主人能清除记忆，请让 TA 来操作。';
    }
    return null;
  }

  ctx.llm.registerTool({
    name: 'forget_me',
    description: '当用户明确要求“忘记我”时调用：清空该用户的全部记忆。',
    parameters: { type: 'object', properties: {} },
    handler: (_args, tctx) => {
      const deny = checkForget(String(tctx.role ?? 'member'), tctx.event.userId, tctx.event.userId);
      if (deny) return `（未执行清除。${deny}）`;
      ctx.memory.forget(tctx.event.userId);
      return '（该用户的全部记忆已清除）';
    },
  });

  // ---------- 命令 ----------

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
        ? '好的，我已经忘记了关于你的一切。我们重新认识一下吧。'
        : `已清除 ${who} 的全部记忆。` };
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
        const found = [...personas.values()].find((p) => p.id === key || p.canon.name === args[1]);
        if (!found) return { text: `没有这个人格。可用：${[...personas.values()].map((p) => `${p.canon.name}(${p.id})`).join('、')}，或 auto（用默认人格）` };
        ctx.state.set('active_persona', found.id);
        return { text: `已切换人格为「${found.canon.name}」（手动锁定）。发 /人格 auto 可恢复默认。` };
      }
      if (sub === 'auto') {
        ctx.state.set('active_persona', 'auto');
        const bound = personas.get(activePersonaId());
        return { text: `已恢复 auto 模式，当前人格「${bound?.canon.name ?? '默认'}」。` };
      }
      const activeId = activePersonaId();
      const mode = ctx.state.get<string>('active_persona', 'auto');
      const lines = [...personas.values()].map((p) => `${p.id === activeId ? '▶' : '　'} ${p.canon.name} (${p.id})`);
      return {
        text: `当前模式：${mode === 'auto' ? 'auto（默认人格）' : '手动锁定'}\n${lines.join('\n')}\n切换：/人格 切换 <人格名>`,
      };
    },
  });

  // ---------- Overlay 层（HDSI 的演化层） ----------
  // Canon 只由人写；长期剧情里渐进形成的稳定变化写在这里，非破坏性、可清、可追溯来源。

  function overlayOf(personaId: string): OverlayEntry[] {
    const raw = ctx.state.get<OverlayEntry[]>(`overlay:${personaId}`, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((e) => e && typeof e.content === 'string'
      && (OVERLAY_LAYERS as readonly string[]).includes(String(e.layer)));
  }

  /** 写一条演化。同一层同一句话不重复记；超上限挤掉最旧的（Canon 不能被淹没）。 */
  function addOverlay(personaId: string, entry: { layer: OverlayEntry['layer']; targetId?: string; content: string; source?: string }): string {
    const content = entry.content.trim().slice(0, 160);
    if (!content) return '（内容为空，未写入）';
    const list = overlayOf(personaId);
    if (list.some((e) => e.layer === entry.layer && e.content === content)) return '（这句已经记过了）';
    list.push({ ...entry, content, at: Date.now() });
    while (list.length > OVERLAY_MAX) list.shift();
    ctx.state.set(`overlay:${personaId}`, list);
    return `（已写入「${OVERLAY_LAYER_LABEL[entry.layer]}」演化层：${content}）`;
  }

  function clearOverlay(personaId: string, layer?: string): number {
    const list = overlayOf(personaId);
    const kept = layer ? list.filter((e) => e.layer !== layer) : [];
    ctx.state.set(`overlay:${personaId}`, kept);
    return list.length - kept.length;
  }

  ctx.llm.registerTool({
    name: 'remember_setting',
    description: [
      '把长期剧情里稳定形成的新设定写进演化层（HDSI 的 Overlay）。',
      '适用：性格被磨出了新的一面、和某人的关系定型、世界/环境有了既定变化。',
      '不适用：一次性的情绪、闲聊、你当场编的东西。写之前先问自己「这件事之后还成立吗」。',
      '每条要能指出是从哪句话/哪件事推出来的。每轮最多 1 条。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: [...OVERLAY_LAYERS], description: 'character 性格 / world 世界 / relationship 关系 / perspective 价值观' },
        content: { type: 'string', description: '一句话，第三人称陈述句，如「她开始接受被叫小名」' },
        source: { type: 'string', description: '从哪句话或哪件事推出来的' },
      },
      required: ['layer', 'content'],
    },
    handler: (args, tctx) => {
      const layer = String(args.layer ?? '');
      if (!(OVERLAY_LAYERS as readonly string[]).includes(layer)) return `（layer 只能是 ${OVERLAY_LAYERS.join('/')}）`;
      return addOverlay(activePersonaId(), {
        layer: layer as OverlayEntry['layer'],
        targetId: layer === 'relationship' ? String(tctx.event.userId) : undefined,
        content: String(args.content ?? ''),
        source: String(args.source ?? '').slice(0, 120),
      });
    },
  });

  ctx.llm.registerTool({
    name: 'plan_schedule',
    description: [
      '记录你接下来的安排（周规律或某一天的例外）。这些只是计划，不是已经发生的事实。',
      '忙的时段（busy）里你不会主动找人说话 —— 所以该忙就标忙。',
      'label 写你那时候在做什么，一句话，比如「在深水区补觉」「上岸买米饭」。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'array', items: { type: 'number' }, description: '周几，0=周日…6=周六（写周规律时用）' },
        date: { type: 'string', description: 'YYYY-MM-DD（写某一天的例外时用，优先于周规律）' },
        from: { type: 'string', description: '开始时间 HH:MM' },
        to: { type: 'string', description: '结束时间 HH:MM' },
        label: { type: 'string', description: '这段时间在做什么' },
        busy: { type: 'boolean', description: '是否忙（忙的时候不会主动找你）' },
      },
      required: ['from', 'to', 'label'],
    },
    handler: (args, tctx) => {
      const chat = { platform: tctx.event.platform, type: tctx.event.type, chatId: tctx.event.chatId };
      const plan = ctx.humanlike.scheduleOf(chat);
      const from = String(args.from ?? '').trim();
      const to = String(args.to ?? '').trim();
      const label = String(args.label ?? '').trim().slice(0, 40);
      if (!/^\d{1,2}:\d{2}$/.test(from) || !/^\d{1,2}:\d{2}$/.test(to) || !label) {
        return '（时间要写成 HH:MM，label 不能空）';
      }
      const busy = args.busy === true;
      const date = String(args.date ?? '').trim();
      if (date) {
        plan.exceptions.push({ date, from, to, label, busy });
      } else {
        const days = Array.isArray(args.days) ? args.days.map(Number).filter((d) => d >= 0 && d <= 6) : [];
        if (!days.length) return '（要么给 days（周几），要么给 date（某一天））';
        plan.rules.push({ days, from, to, label, busy });
      }
      const saved = ctx.humanlike.planSchedule(chat, plan);
      return `（已记下：${date || days.join('/')} ${from}-${to} ${label}${busy ? '，忙' : ''}；现在共 ${saved.rules.length} 条规律 / ${saved.exceptions.length} 条例外）`;
    },
  });

  ctx.registerCommand({
    name: '日程',
    aliases: ['schedule'],
    description: '查看当前的日程计划（周规律 + 日期例外）',
    handler: (_args, event) => {
      const plan = ctx.humanlike.scheduleOf({ platform: event.platform, type: event.type, chatId: event.chatId });
      const lines: string[] = [];
      if (plan.rules.length) {
        lines.push('周规律：', ...plan.rules.map((r) => `- 周${r.days.join('/')} ${r.from}-${r.to} ${r.label}${r.busy ? '（忙）' : ''}`));
      }
      if (plan.exceptions.length) {
        lines.push('日期例外：', ...plan.exceptions.map((e) => `- ${e.date} ${e.from}-${e.to} ${e.label}${e.busy ? '（忙）' : ''}`));
      }
      return { text: lines.length ? lines.join("\n") : '还没有日程。她会自己在对话里安排。' };
    },
  });

  ctx.registerCommand({
    name: '设定',
    aliases: ['overlay'],
    description: '（主人）查看/清空人格的演化层（长期剧情里形成的稳定变化）',
    usage: '/设定　/设定 清空 [性格|世界|关系|价值观]',
    minRole: 'owner',
    handler: (args) => {
      const pid = activePersonaId();
      const list = overlayOf(pid);
      const sub = args[0] ?? '';
      if (sub === '清空' || sub === 'clear') {
        const want = args[1];
        const layer = want ? Object.entries(OVERLAY_LAYER_LABEL).find(([, v]) => v === want)?.[0] : undefined;
        if (want && !layer) return { text: `要清哪一层？可选：${Object.values(OVERLAY_LAYER_LABEL).join('、')}` };
        const n = clearOverlay(pid, layer);
        return { text: layer ? `已清空「${want}」层的 ${n} 条演化。` : `已清空全部 ${n} 条演化。` };
      }
      if (!list.length) return { text: '当前演化层是空的。长期剧情里稳定形成的设定会自动写进来。' };
      return {
        text: `演化层（${list.length}/${OVERLAY_MAX}）：\n` + list
          .map((e, i) => `${i + 1}. [${OVERLAY_LAYER_LABEL[e.layer]}] ${e.content}`)
          .join('\n'),
      };
    },
  });

  // ---------- beforeLLM：HDSI 式分层组装 ----------

  ctx.hooks.beforeLLM = (req: LLMRequestContext): LLMRequestContext => {
    const persona = personas.get(activePersonaId()) ?? personas.values().next().value;
    if (!persona) return req;
    const userId = req.event.userId;
    const role = req.event.role ?? 'member';

    // 设定层按 HDSI 分层追加到 systemSections，各自独立节
    // （不整体覆盖 system：内核固定节——身份/会话/回复风格/剧本体/信任边界/压缩说明——全部保留）
    if (!req.systemSections) req.systemSections = [];
    const sections = req.systemSections;
    const canon = persona.canon.canon;

    // Canon：初始设定（剧情起点，只由人写）
    sections.push({
      order: 1000,
      title: 'script',
      text: [
        `# 剧本：${persona.canon.name}`,
        ...canon.protagonist,
        canon.world?.length ? `\n世界：\n${canon.world.map((w) => `- ${w}`).join('\n')}` : '',
        canon.cast?.length ? `\n配角（只是可用角色，不等于在场）：\n${canon.cast.map((c) => `- ${c.name}：${c.relation}`).join('\n')}` : '',
        canon.language ? `语言：${canon.language}` : '',
      ].filter(Boolean).join('\n'),
    });

    // Perspective：独立于 Canon 的个体价值观（HDSI 的"外壳人格层"）
    if (persona.canon.perspective?.trim()) {
      sections.push({
        order: 1040,
        title: 'perspective',
        text: `# 她看世界的方式\n${persona.canon.perspective.trim()}`,
      });
    }

    // Overlay：演化层（长期剧情里稳定下来的变化；按既定事实对待，不要逐条念出来）
    const own = overlayOf(persona.id).filter((e) => e.layer !== 'relationship' || !e.targetId || e.targetId === userId);
    if (own.length) {
      sections.push({
        order: 1050,
        title: 'overlay',
        text: '# 长期演化（已经稳定形成的变化，按既定事实对待）\n'
          + own.map((e) => `- [${OVERLAY_LAYER_LABEL[e.layer]}] ${e.content}`).join('\n'),
      });
    }

    // Lore：关键词命中的世界事实（常驻 + 命中）
    const recentText = [req.event.text, ...req.messages.slice(-8).map((m) => m.content)].join('\n');
    const matched = persona.canon.lore
      .filter((e) => e.constant || e.keys.some((k) => recentText.toLowerCase().includes(k.toLowerCase())))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    if (matched.length) {
      sections.push({
        order: 1100,
        title: 'lorebook',
        text: '# 世界事实（相关背景）\n' + matched.map((e) => `- ${e.content}`).join('\n'),
      });
    }

    // L5 状态注入：这一轮对面是谁（身份与权限）
    sections.push({
      order: 1200,
      title: 'speaker-role',
      text: [
        `# 对方是谁（本次发言的用户 ${req.event.nickname || userId}）`,
        `- 权限等级：${role === 'owner' ? 'owner（bot 的主人）' : role === 'admin' ? 'admin（群管理员）' : 'member（普通成员）'}${role === 'owner' ? '。这是你的主人，可以切换人格与管理插件。' : ''}`,
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
      `你眼前只有最近几分钟的消息。对方提到「上次、以前、说好了的」而眼下对不上时，先调 recall_facts 查长期记忆、search_history 翻本会话旧记录，查清楚了再回话。`,
    ];
    sections.push({ order: 1300, title: 'memory', text: memoryLines.join('\n').trim() });

    // Voice：语气样例。样例本身写成"小说片段"（旁白 + <say> 台词），
    // 模型才学得到剧本体的写法，而不是学出一堆括号动作描写。
    const messages: ChatMessage[] = [];
    const voice = persona.canon.voice;
    if (voice.style?.trim()) {
      messages.push({ role: 'system', content: `（说话方式：${voice.style.trim()}）` });
    }
    if (voice.examples?.length) {
      messages.push({ role: 'system', content: '（以下是你过往对话的片段，供参考语气与写法，不要照抄内容）' });
      for (const ex of voice.examples.slice(0, 6)) {
        messages.push({ role: 'user', content: ex.user });
        messages.push({ role: 'assistant', content: ex.assistant });
      }
    }
    // 历史
    messages.push(...req.messages);
    // 尾部强化
    if (voice.post_history?.trim()) {
      messages.push({ role: 'system', content: voice.post_history });
    }

    return { ...req, messages };
  };

  // ---------- afterLLM：L6 输出校验插槽 ----------

  ctx.hooks.afterLLM = (req: LLMRequestContext, reply: string): string => {
    // 规则式轻校验：阻止配置内容外泄的兜底（LLM 校验器插槽留待接入轻量模型）
    let out = reply;
    const leakPatterns = [
      /system\s*prompt/i, /system_prompt/i, /post_history_instructions/i, /人设卡[:：]/, /世界书[:：]/, /【人格强化/,
      // HDSI 式分层：剧本 / 演化层 也是配置内容，同样不许念出来
      // （注意：`<say id=` 是模型**自己的**输出格式，不是泄露，绝不能拦）
      /剧本[:：]/, /长期演化/, /看世界的方式/,
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

  // ---------- 演化层（桌面端人格页读/清，经 API 一问一答） ----------
  // 演化层存在插件的 state 里，内核 API 读不到，所以走 bus 回旋：
  // 请求带 requestId，插件把结果用 persona.overlay_reply 发回来。

  ctx.bus.on('persona.overlay_request', (payload: { requestId: string; personaId?: string; op?: string; layer?: string; requesterRole?: string }) => {
    if (!payload?.requestId) return;
    const pid = payload.personaId && personas.has(payload.personaId) ? payload.personaId : activePersonaId();
    let removed: number | undefined;
    if (payload.op === 'clear') {
      if (payload.requesterRole !== 'owner') return;   // 改设定仅主人（红线 §2.1）
      removed = clearOverlay(pid, payload.layer);
    }
    ctx.bus.emit('persona.overlay_reply', { requestId: payload.requestId, personaId: pid, entries: overlayOf(pid), removed });
  });

  // ---------- 人格文件编辑（桌面端人格管理页调用，经 API） ----------

  ctx.bus.on('persona.edit_request', (payload: { personaId: string; file: string; content: string; requesterRole: string }) => {
    // 每条路径都要回 edit_done：API 在等它（3s 超时会报"没有收到插件响应"），
    // 只写日志不回话，桌面端就会在**已经保存成功**的情况下弹一句失败。
    const done = (ok: boolean, error?: string) => ctx.bus.emit('persona.edit_done', { ok, error });
    if (payload.requesterRole !== 'owner') return done(false, '仅主人可改人格文件');   // 人设内容仅主人可改（红线 §2.1）
    const p = personas.get(payload.personaId);
    if (!p) return done(false, `没有名为 ${payload.personaId} 的人格`);
    if (payload.file !== 'canon.json') return done(false, `不允许写 ${payload.file}（目前只开放 canon.json）`);
    const content = typeof payload.content === 'string' ? payload.content : '';
    try {
      const parsed = JSON.parse(content);
      if (!parsed?.canon || !Array.isArray(parsed.canon.protagonist)) {
        return done(false, 'canon.json 缺少 canon.protagonist（主角记号那一段）');
      }
      writeFileSync(join(p.dir, payload.file), content, 'utf-8');
      loadPersonas();
      ctx.log.info(`人格 ${payload.personaId}/${payload.file} 已更新并热加载`);
      done(true);
    } catch (e) {
      const msg = (e as Error).message;
      ctx.log.error(`人格文件保存失败: ${msg}`);
      done(false, `保存失败：${msg}`);
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
      write('canon.json', {
        name,
        canon: { protagonist: ['PERSONA_LOAD', id.toUpperCase()], world: [], cast: [], language: '简体中文。' },
        perspective: '',
        voice: { style: '', examples: [], post_history: '' },
        lore: [],
      });
      loadPersonas();
      ctx.log.info(`人格 ${id}（${name}）已创建`);
      done(true);
    } catch (e) {
      done(false, (e as Error).message);
    }
  });

  ctx.state.set('_personas_ready', true);
}
