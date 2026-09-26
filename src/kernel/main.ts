// parallel 入口：解析 CLI 参数并启动内核
import { Kernel } from './kernel.ts';

const args = process.argv.slice(2);
function argOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const kernel = new Kernel({
  dataDir: argOf('--data-dir'),
  port: argOf('--port') ? Number(argOf('--port')) : undefined,
});

process.on('SIGINT', async () => {
  console.log('\n收到退出信号，正在优雅关闭…');
  await kernel.shutdown();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await kernel.shutdown();
  process.exit(0);
});

kernel.boot().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
