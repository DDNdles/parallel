import { EventEmitter } from 'node:events';

/** 轻量类型化事件总线 */
export class Bus {
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(200);
  }

  emit(event: string, ...args: any[]): void {
    this.ee.emit(event, ...args);
  }

  on(event: string, handler: (...args: any[]) => void): () => void {
    this.ee.on(event, handler);
    return () => this.ee.off(event, handler);
  }

  once(event: string, handler: (...args: any[]) => void): () => void {
    this.ee.once(event, handler);
    return () => this.ee.off(event, handler);
  }
}

export const busEvents = {
  chatEvent: 'chat.event',            // 入站消息（归一化后）
  chatOut: 'chat.out',                // 出站消息
  toolCall: 'agent.tool_call',
  toolResult: 'agent.tool_result',
  llmDelta: 'agent.llm_delta',
  llmStart: 'agent.llm_start',
  llmEnd: 'agent.llm_end',
  agentStart: 'agent.start',
  agentEnd: 'agent.end',
  pluginLoaded: 'plugin.loaded',
  pluginUnloaded: 'plugin.unloaded',
  pluginStateChanged: 'plugin.state_changed',
  errorRecorded: 'error.recorded',
  providerChanged: 'provider.changed',
  /** 模型优先级链上的降级切换（连续掉线达到阈值时发出） */
  modelFailover: 'model.failover',
  configChanged: 'config.changed',
  adapterStatus: 'adapter.status',
  memoryChanged: 'memory.changed',
  scheduleFire: 'schedule.fire',
  // work 子代理（chat 模型 → work 模型）运行进度：桌面端「工作」页/会话页侧栏实时展示
  workStart: 'work.start',
  workStep: 'work.step',
  workDone: 'work.done',
  workError: 'work.error',
  /** 结构化 loop 事件（轮次/思考/工具调用/结果/用量），会话页右侧「工作」抽屉画 loop 用 */
  workEvent: 'work.event',
} as const;
