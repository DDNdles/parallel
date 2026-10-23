// ============================================================
// work 产物的路径判定（投递、补扫、交付清单共用）
//
// 模型通过 work_finish 上报的 artifacts 不经过补扫，过去会把 `.skills/` 里的
// SKILL.md、inbox 镜像、进度笔记一起当成交付物发出去（2026-10-23 实测）。
// 这里给出一条统一的「这是不是能给用户的东西」口径：
//  - 隐藏目录/文件（.skills、.git、.cache、.venv…）不是；
//  - inbox（聊天收件镜像）、node_modules、__pycache__、deliver（内核打包目录）不是；
//  - 日志/临时文件、下划线开头的内部预览页不是；
//  - 绝对路径、盘符、`..` 越界路径不是。
// ============================================================

/** 补扫与投递共用的跳过目录 */
export const ARTIFACT_SKIP_DIRS = new Set([
  'inbox', '.skills', '.git', 'node_modules', '__pycache__', '.cache', '.venv', 'venv', 'deliver',
]);

/** 补扫与投递共用的跳过文件（字节码/日志/临时件） */
export const ARTIFACT_SKIP_FILE = /\.(pyc|pyo|log|tmp|bak|swp)$/i;

/**
 * 这个沙箱相对路径能不能作为交付物发出去。
 * 只做路径层面的判断，不碰文件系统（存在性由调用方各自校验）。
 */
export function isDeliverableArtifact(raw: unknown): boolean {
  let p = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!p) return false;
  if (/^[A-Za-z]:\//.test(p) || p.startsWith('/')) return false; // 绝对路径/盘符不是沙箱相对路径
  p = p.replace(/^\.\//, '');
  const parts = p.split('/');
  if (!parts.length || parts.some((s) => !s || s === '.' || s === '..')) return false;
  // 隐藏目录/文件一律不是交付物；deliver 是内核自己生成的合集包，避免下一轮再被扫进来
  if (parts.some((s) => s.startsWith('.') || ARTIFACT_SKIP_DIRS.has(s))) return false;
  const name = parts[parts.length - 1];
  if (ARTIFACT_SKIP_FILE.test(name) || name.startsWith('_')) return false;
  return true;
}

/** 路径归一化成沙箱相对路径（正斜杠、去 ./ 前缀）；不合法返回空串 */
export function normalizeArtifactPath(raw: unknown): string {
  const p = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return isDeliverableArtifact(p) ? p : '';
}
