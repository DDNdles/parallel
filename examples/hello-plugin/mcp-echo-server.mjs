// 最小 stdio MCP server 示例（newline-delimited JSON-RPC 2.0）
// 供 plugin.json 的 mcpServers.demo-echo 使用：node mcp-echo-server.mjs
import * as readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'demo-echo', version: '0.1.0' } } });
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [{
          name: 'echo',
          description: '原样回显输入文本（示例 MCP 工具）',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        }],
      },
    });
  } else if (msg.method === 'tools/call') {
    const text = String(msg.params?.arguments?.text ?? '');
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo: ${text}` }] } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
