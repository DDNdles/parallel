import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { newId, nowMs } from '../util/misc.ts';

/**
 * 极简 stdio MCP 客户端（newline-delimited JSON-RPC 2.0）：
 * 供插件 manifest 的 mcpServers 声明使用（受 network 权限门控）。
 * 支持 initialize → tools/list → tools/call。
 */
export class McpStdioClient {
  private child?: ChildProcess;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private buffer = '';
  tools: { name: string; description: string; inputSchema: unknown }[] = [];
  ready = false;

  constructor(
    readonly serverId: string,
    private command: string,
    private args: string[],
    private env: Record<string, string>,
    private log: { info(msg: string, extra?: any): void; error(msg: string, extra?: any): void },
  ) {}

  async start(): Promise<void> {
    this.child = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout!.setEncoding('utf-8');
    const rl = createInterface({ input: this.child.stdout! });
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      let msg: any;
      try { msg = JSON.parse(t); } catch { return; }
      if (msg.id !== undefined && this.pending.has(String(msg.id))) {
        const p = this.pending.get(String(msg.id))!;
        this.pending.delete(String(msg.id));
        if (msg.error) p.reject(new Error(`MCP ${this.serverId}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    });
    this.child.stderr!.on('data', (d: Buffer) => this.log.error(`MCP ${this.serverId} stderr: ${d.toString().slice(0, 200)}`));
    this.child.on('exit', (code) => {
      this.ready = false;
      this.log.error(`MCP ${this.serverId} 进程退出 code=${code}`);
      for (const [, p] of this.pending) p.reject(new Error(`MCP ${this.serverId} 进程已退出`));
      this.pending.clear();
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'parallel', version: '0.1.0' },
    }, 15000);
    this.notify('notifications/initialized', {});
    const res = await this.request('tools/list', {}, 15000);
    this.tools = (res?.tools ?? []).map((t: any) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object' } }));
    this.ready = true;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args }, 60000);
    const content = res?.content ?? [];
    const text = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    if (res?.isError) throw new Error(text || `MCP 工具 ${name} 返回错误`);
    return text || JSON.stringify(res ?? {});
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error(`MCP ${this.serverId} 未启动`));
    const id = String(this.nextId++);
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.serverId}.${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child!.stdin!.write(msg);
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  dispose(): void {
    try { this.child?.kill(); } catch { /* ignore */ }
    for (const [, p] of this.pending) p.reject(new Error('MCP client disposed'));
    this.pending.clear();
  }
}

export function newMcpRequestId(): string {
  return newId('mcp_') + nowMs();
}
