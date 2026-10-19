// ============================================================
// mock 引擎（测试用）：把「脚本化回复」实现成 pi-ai 的一个 ProviderStreams
//
// 为什么这么写：模型层统一到 pi-ai 之后，所有引擎（含测试用的假引擎）对上层都必须是
// 同一个形状 —— `stream(model, context, options) => AssistantMessageEventStream`。
// 于是 AgentLoop（pi-agent-core）、插件直连、测试三方走的是同一条路，
// 不会出现"只有测试走得通"的分支。
//
// 语义与改造前一致（测试按这些语义写的）：
//  - `script` 队列：每来一次请求弹一步，给 content 与/或 toolCalls；
//  - 队列空了走默认回声，并保留"算幂"这类消息触发 run_python / python_session 的演示链路；
//  - usage 固定给一组带缓存命中的数，让缓存账与工作抽屉的占比有数可算。
// ============================================================

import type { AssistantMessage, AssistantMessageEvent, Model, SimpleStreamOptions, TextContent, ToolCall, TranscriptContext } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream, getCurrentTools } from '@earendil-works/pi-ai';

export interface MockScriptStep {
  content?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  /** 延迟这么久才吐字（毫秒）：给"生成期间群里又来了新消息"这类时序用例留窗口 */
  delayMs?: number;
}

/** 固定的 usage：命中 80 / 未命中 20。测试只断言"有数且 prompt ≥ 命中"，不锁死具体值 */
function mockUsage(completion: number): AssistantMessage['usage'] {
  return {
    input: 20, output: completion, cacheRead: 80, cacheWrite: 0, totalTokens: 100 + completion,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantMessage(o: {
  model: Model<any>;
  content: (TextContent | ToolCall)[];
  stopReason: AssistantMessage['stopReason'];
  usage?: AssistantMessage['usage'];
}): AssistantMessage {
  return {
    role: 'assistant',
    content: o.content,
    api: o.model.api,
    provider: o.model.provider,
    model: o.model.id,
    usage: o.usage ?? mockUsage(20),
    stopReason: o.stopReason,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 从 pi-ai 的 context 里读"最后一条 user 消息"（工具结果在它之后就不算新的用户输入） */
function lastUserText(context: TranscriptContext): string {
  const msgs = context.messages as any[];
  let lastUser = -1;
  let lastTool = -1;
  msgs.forEach((m, i) => { if (m.role === 'user') lastUser = i; if (m.role === 'toolResult') lastTool = i; });
  if (lastUser < 0 || lastUser < lastTool) return '';
  const c = msgs[lastUser].content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('');
  return '';
}

/** 工具清单：pi-ai 会把 tools 折进 transcript 的首条 system 消息，所以要用它的取法读回来 */
/** 系统提示词：pi-ai 把它折进 transcript 的首条 system 消息 */
function systemTextOf(context: TranscriptContext): string {
  const msgs = (context.messages as any[]) ?? [];
  const sys = msgs.find((m) => m?.role === 'system');
  if (!sys) return '';
  const c = sys.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('');
  return '';
}

/** 所有 user 消息的文本拼起来（用于断言"摘要真的进了请求"） */
function allUserText(context: TranscriptContext): string {
  const msgs = (context.messages as any[]) ?? [];
  return msgs.filter((m) => m?.role === 'user').map((m) => {
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('');
    return '';
  }).join(' | ');
}

function availableToolNames(context: TranscriptContext): string[] {
  const direct = ((context as any).tools ?? []) as any[];
  const fromTranscript = (() => {
    try { return (getCurrentTools((context as any).messages) ?? []) as any[]; } catch { return []; }
  })();
  const list = direct.length ? direct : fromTranscript;
  return list.map((t) => String(t?.name ?? ''));
}

/** 最后一条 user 消息里的非文本块类型（图片=pi-ai 原生块；据此断言"附件真进了这一发请求"） */
function lastUserMedia(context: TranscriptContext): string[] {
  const msgs = context.messages as any[];
  let lastUser = -1;
  let lastTool = -1;
  msgs.forEach((m, i) => { if (m.role === 'user') lastUser = i; if (m.role === 'toolResult') lastTool = i; });
  if (lastUser < 0 || lastUser < lastTool) return [];
  const c = msgs[lastUser].content;
  if (!Array.isArray(c)) return [];
  return c.filter((b: any) => b?.type && b.type !== 'text').map((b: any) => String(b.type));
}

export class MockEngine {
  /** 脚本队列（测试往里 push） */
  script: MockScriptStep[] = [];
  /** 后台「记忆整理」那一发的答复（一行一条事实，NONE = 不记）。默认什么都不写，免得无关用例被污染 */
  memoryReply = 'NONE';
  /** 后台「表达学习」的答复（JSON；默认空数组，免得无关用例被污染） */
  expressionReply = '{"expressions":[]}';
  /** 后台「用户画像」的答复（纯文本；NONE = 不生成） */
  profileReply = 'NONE';
  /** 后台「聊天回想」的答复（JSON；空摘要 = 不落库） */
  midtermReply = '{"summary":"","cues":[]}';
  /** 后台「黑话候选」的答复（JSON；默认空数组） */
  jargonMineReply = '{"terms":[]}';
  /** 每次请求记一笔：条数、工具名、以及"最后一条 user + system 的摘要"（测试据此断言压缩是否真的生效） */
  calls: { messages: number; tools?: string[]; system?: string; lastUser?: string; usersJoined?: string; media?: string[] }[] = [];
  id = 'mock';
  label = 'Mock（测试用）';
  /** 注册表元数据：mock 是"已接入"的进程内引擎，预检不能把它当占位供应商拦掉 */
  implemented = true;
  streaming = true;

  /** 注册表要求实现 LLMProvider；请求一律走 pi-ai（streamFn），这里不该被调用 */
  async chat(): Promise<never> {
    throw new Error('内部错误：mock 的请求应当走 pi-ai 引擎');
  }

  /** pi-ai 的 StreamFn：与真实引擎同形 */
  streamFn = (model: Model<any>, context: TranscriptContext, _options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const tools = availableToolNames(context);
    const sysText = systemTextOf(context);
    this.calls.push({
      messages: (context.messages as any[]).length, tools,
      system: sysText.slice(0, 8000), lastUser: lastUserText(context).slice(0, 200),
      // 所有 user 消息拼起来（压缩摘要会插在工具结果之前，"最后一条 user"看不到它）
      usersJoined: allUserText(context).slice(0, 600),
      media: lastUserMedia(context),
    });

    // 内核/插件自己发出去的那一发旁路请求（上下文压缩摘要、自动记忆提炼）：特征是**没有工具**
    // 且系统提示词里带各自的自认标记。这类请求不消耗 script 队列——否则测试没法把脚本对齐到"第几轮"。
    const oneShot = (text: string) => {
      const message = assistantMessage({ model, content: [{ type: 'text', text }], stopReason: 'stop', usage: mockUsage(12) });
      const partial: any = { ...message, content: [] };
      stream.push({ type: 'start', partial } as AssistantMessageEvent);
      stream.push({ type: 'text_start', contentIndex: 0, partial } as AssistantMessageEvent);
      stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message } as AssistantMessageEvent);
      stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message } as AssistantMessageEvent);
      stream.push({ type: 'done', reason: 'stop', message } as AssistantMessageEvent);
      stream.end(message);
      return stream;
    };
    if (!tools.length && sysText.includes('压缩助手')) {
      return oneShot('## 目标\n（mock 摘要）把之前的事记成一段话');
    }
    if (!tools.length && sysText.includes('记忆整理助手')) return oneShot(this.memoryReply);
    // 2026-10-18 起的后台学习通道：各自认一句自认标记，不消耗主脚本队列
    if (!tools.length && sysText.includes('表达方式整理助手')) return oneShot(this.expressionReply);
    if (!tools.length && sysText.includes('用户画像整理助手')) return oneShot(this.profileReply);
    if (!tools.length && sysText.includes('聊天回想整理助手')) return oneShot(this.midtermReply);
    if (!tools.length && sysText.includes('黑话候选整理助手')) return oneShot(this.jargonMineReply);

    // 先把这一步的结果算出来（同步逻辑），再按事件顺序推出去
    const step = this.script.shift();
    let content: (TextContent | ToolCall)[] = [];
    let stopReason: AssistantMessage['stopReason'] = 'stop';
    let text = '';
    let usage: AssistantMessage['usage'] | undefined;

    if (step) {
      text = step.content ?? '';
      const toolCalls: ToolCall[] = (step.toolCalls ?? []).map((t, i) => ({
        type: 'toolCall' as const, id: `mock_${Date.now()}_${i}`, name: t.name, arguments: t.args as any,
      }));
      content = [...(text ? [{ type: 'text' as const, text }] : []), ...toolCalls];
      stopReason = toolCalls.length ? 'toolUse' : 'stop';
      usage = mockUsage(20 + text.length);
    } else {
      const user = lastUserText(context);
      const pow = user.match(/(\d+)\s*(?:\^|\*\*|的)\s*(\d+)\s*(?:次方|幂)?/);
      // 同一个演示意图在 chat 档叫 run_python、work 档（常驻会话）叫 python_session
      const pyTool = tools.includes('run_python') ? 'run_python' : tools.includes('python_session') ? 'python_session' : '';
      if (user && /算|计算|幂|次方|\^|\*\*/.test(user) && pow && pyTool) {
        content = [{
          type: 'toolCall' as const, id: `mock_tool_${Date.now()}`, name: pyTool,
          arguments: { code: `print(${pow[1]} ** ${pow[2]})` } as any,
        }];
        stopReason = 'toolUse';
        usage = mockUsage(30);
      } else {
        const userCount = (context.messages as any[]).filter((m) => m.role === 'user').length;
        text = `（mock）收到 ${userCount} 条消息`;
        content = [{ type: 'text' as const, text }];
        usage = mockUsage(20);
      }
    }

    const message = assistantMessage({ model, content, stopReason, usage });
    const partial: any = { ...message, content: [] };

    const emit = () => {
      stream.push({ type: 'start', partial } as AssistantMessageEvent);
      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (block.type === 'text') {
          stream.push({ type: 'text_start', contentIndex: i, partial: { ...partial, content: [...partial.content, { type: 'text', text: '' }] } } as AssistantMessageEvent);
          // 一次性吐出整段（这里不模拟逐字；打字机效果由 UI 的 onDelta 收到一段文本渲染）
          stream.push({ type: 'text_delta', contentIndex: i, delta: block.text, partial: message } as AssistantMessageEvent);
          stream.push({ type: 'text_end', contentIndex: i, content: block.text, partial: message } as AssistantMessageEvent);
        } else {
          stream.push({ type: 'toolcall_start', contentIndex: i, partial: message } as AssistantMessageEvent);
          stream.push({ type: 'toolcall_end', contentIndex: i, toolCall: block, partial: message } as AssistantMessageEvent);
        }
      }
      stream.push({
        type: 'done',
        reason: stopReason === 'toolUse' ? 'toolUse' : stopReason === 'length' ? 'length' : 'stop',
        message,
      } as AssistantMessageEvent);
      stream.end(message);
    };
    // 时序用例可以要求"想一会儿再答"：延迟期内事件流空转，内核那一轮还在跑
    const wait = Math.max(0, Math.round(step?.delayMs ?? 0));
    if (wait > 0) setTimeout(emit, wait);
    else emit();
    return stream;
  };
}

/** 作为 pi-ai 供应商的 api 实现（stream 与 streamSimple 同形） */
export function mockStreams(): { stream: MockEngine['streamFn']; streamSimple: MockEngine['streamFn'] } {
  const engine = mockEngine;
  return { stream: engine.streamFn, streamSimple: engine.streamFn };
}

/** 进程内单例：测试通过 kernel.llm 拿到它来 push 脚本 */
export const mockEngine = new MockEngine();
