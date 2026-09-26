import type { IconName } from '@/components/Icon';

/** 文件类型图形：按扩展名挑，认不出的给通用文档形 */
const FILE_ICON: [RegExp, IconName][] = [
  [/\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i, 'fImage'],
  [/\.(py|js|mjs|ts|tsx|jsx|java|kt|c|h|cpp|go|rs|sh|ps1|sql)$/i, 'fCode'],
  [/\.(json|ya?ml|toml|ini|csv|env|lock)$/i, 'fData'],
];
export const fileIcon = (p: string): IconName => FILE_ICON.find(([re]) => re.test(p))?.[1] ?? 'fText';
