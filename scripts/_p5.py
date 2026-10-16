import io

# 1) types.ts：加 GatedHumanlike + PluginContext.humanlike
p='src/kernel/types.ts'
s=io.open(p,encoding='utf-8').read()
a="""  /** work 子代理委派（chat 模型把任务交给 work 模型执行；需 work.delegate 权限） */
  work: GatedWork;"""
b="""  /** work 子代理委派（chat 模型把任务交给 work 模型执行；需 work.delegate 权限） */
  work: GatedWork;
  /** 拟人层（内核自有）：日程读写 + 状态查询（HDSI Schedule/Alter/Rhythm） */
  humanlike: GatedHumanlike;"""
assert a in s; s=s.replace(a,b,1)

a="""export interface GatedWork {"""
b="""export interface GatedHumanlike {
  /** 读某会话的日程计划（周规律 + 日期例外） */
  scheduleOf(chat: ChatRef): { rules: { days: number[]; from: string; to: string; label: string; busy?: boolean }[]; exceptions: { date: string; from: string; to: string; label: string; busy?: boolean }[] };
  /** 写某会话的日程计划（会顺手清过期项并截断容量） */
  planSchedule(chat: ChatRef, plan: { rules?: unknown[]; exceptions?: unknown[] }): { rules: unknown[]; exceptions: unknown[] };
  /** 拟人层当前状态快照（排障：为什么不出声 / 氛围 / 节奏） */
  snapshot(chat: ChatRef): Record<string, unknown>;
}

export interface GatedWork {"""
assert a in s
io.open(p,'w',encoding='utf-8',newline='').write(s.replace(a,b,1))
print('types ok')

# 2) container.ts：deps 加 humanlike + ctx 暴露
p='src/kernel/container.ts'
s=io.open(p,encoding='utf-8').read()
a="""      work: WorkRunner;"""
b="""      work: WorkRunner;
      humanlike: HumanlikeService;"""
assert a in s; s=s.replace(a,b,1)
a="""      work: makeGatedWork(manifest, { work: this.deps.work, plugins: this, groupTitle: this.deps.groupTitle }),"""
b="""      work: makeGatedWork(manifest, { work: this.deps.work, plugins: this, groupTitle: this.deps.groupTitle }),
      humanlike: makeGatedHumanlike(this.deps.humanlike),"""
assert a in s; s=s.replace(a,b,1)
a="""import type { WorkRunner } from './services/work.ts';"""
b="""import type { WorkRunner } from './services/work.ts';
import type { HumanlikeService } from './humanlike/index.ts';"""
assert a in s; s=s.replace(a,b,1)
# 在 makeGatedMemory 前插入实现
a="""function makeGatedMemory("""
b="""/**
 * 拟人层的门面。日程/氛围/节奏都属于"角色状态"，插件读写它就是改角色本身，
 * 所以只开最小面：读快照、读日程、写日程。不开放直接改氛围权重之类的内部量。
 */
function makeGatedHumanlike(humanlike: HumanlikeService): GatedHumanlike {
  return {
    scheduleOf: (chat) => humanlike.scheduleOf(chat),
    planSchedule: (chat, plan) => humanlike.planSchedule(chat, {
      rules: Array.isArray(plan?.rules) ? (plan.rules as never[]) : [],
      exceptions: Array.isArray(plan?.exceptions) ? (plan.exceptions as never[]) : [],
    }),
    snapshot: (chat) => humanlike.snapshot(chat),
  };
}

function makeGatedMemory("""
assert a in s; s=s.replace(a,b,1)
a="""import { PermissionDeniedError"""
if a not in s:
    # 找类型导入行
    idx=s.index("import type { ChatRef")
    s=s[:idx]+"import type { ChatRef"  # 占位，不改
io.open(p,'w',encoding='utf-8',newline='').write(s)
print('container ok')

# 3) kernel.ts：把 humanlike 交给容器
p='src/kernel/kernel.ts'
s=io.open(p,encoding='utf-8').read()
a="""        chat: this.chat, llm: this.llm,"""
b="""        chat: this.chat, llm: this.llm, humanlike: this.humanlike,"""
assert a in s
io.open(p,'w',encoding='utf-8',newline='').write(s.replace(a,b,1))
print('kernel ok')
