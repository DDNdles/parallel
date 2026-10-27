/**
 * 107 翻唱服务的「纯逻辑」：作业挑选、提交报文、启动命令。
 * 不做网络也不读盘，方便单测；真正的轮询在 ustc-watch.mjs。
 */

/** 唱歌下线后作业名改为 cover；过渡期同时认旧的 sing 作业 */
export const JOB_NAMES = new Set(['cover', 'sing']);

/** 平台地址；PARALLEL_COVER_PORTAL 只给测试用的假门户，生产不要设 */
export const PORTAL = (process.env.PARALLEL_COVER_PORTAL || 'https://107.ustc.edu.cn').replace(/\/+$/, '');
export const USER = 'pb25071412';
export const CLUSTER = 'training';
export const PARTITION = 'Students';
export const ACCOUNT = 'stu';
export const QOS = 'qos_stu_default';
/** 服务默认部署根目录（$HOME/cover；作业里跑的是 svc-venv/bin/python server.py） */
export const REMOTE_ROOT = '/home/scc/pb25071412/cover';
export const SERVICE_PORT = 8047;
/** Slurm 作业窗口：03:58:00（平台上限 4 小时） */
export const JOB_MINUTES = 238;
export const JOB_MEMORY_MB = 16384;
export const JOB_CORES = 4;

/** 同一时刻只允许一个作业；失败后至少隔 30 分钟再试，成功提交后 10 分钟内不重复提交 */
export const SUBMIT_COOLDOWN_MS = 10 * 60 * 1000;
export const RETRY_COOLDOWN_MS = 30 * 60 * 1000;

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;

function shellToken(name, value) {
  const s = String(value ?? '');
  if (!SAFE_TOKEN.test(s)) throw new Error(`${name} 含不支持的字符：${JSON.stringify(s)}`);
  return s;
}

function shellPath(name, value) {
  const s = String(value ?? '');
  if (!SAFE_PATH.test(s)) throw new Error(`${name} 含不支持的字符：${JSON.stringify(s)}`);
  return s;
}

/** 作业是否在跑（RUNNING 且已经分到节点） */
export function isRunningJob(job) {
  return !!job
    && JOB_NAMES.has(String(job.name ?? ''))
    && String(job.state ?? '').toUpperCase() === 'RUNNING'
    && !!job.nodes
    && String(job.nodes) !== 'None';
}

/** 排队中（PENDING/CONFIGURING 等都算；有排队的作业就不再重复提交） */
export function isPendingJob(job) {
  if (!job || !JOB_NAMES.has(String(job.name ?? ''))) return false;
  const s = String(job.state ?? '').toUpperCase();
  return s === 'PENDING' || s === 'CONFIGURING' || s === 'REQUEUED' || s === 'RESIZING';
}

export function findRunningJob(list) {
  return (Array.isArray(list) ? list : []).find(isRunningJob) ?? null;
}

export function findPendingJob(list) {
  return (Array.isArray(list) ? list : []).find(isPendingJob) ?? null;
}

/** 作业真实的节点名（nodesOrReason 可能是 "anode16" 或 "anode16,anode17"） */
export function jobNode(job) {
  return String(job?.nodesOrReason ?? '').split(',')[0].trim();
}

/** SCOW 代理地址：/api/proxy/<cluster>/relative/<node>/<port> */
export function proxyBaseUrl(node, cluster = CLUSTER, port = SERVICE_PORT) {
  return `${PORTAL}/api/proxy/${cluster}/relative/${node}/${port}`;
}

/** 只清理由本守护进程接上的 SCOW 代理地址，别动用户手填的自部署地址 */
export function isManagedBaseUrl(baseUrl) {
  return /^https?:\/\/[^/]+\/api\/proxy\/[^/]+\/relative\/[^/]+\/\d+\/?$/.test(String(baseUrl ?? ''));
}

/**
 * 作业里执行的命令：和原来 cover.sbatch 里的启动行一致。
 * API Key 直接内联（只出现在 107 的作业脚本里，不进仓库、不打印日志）。
 */
export function buildLaunchCommand({ root = REMOTE_ROOT, apiKey = '', port = SERVICE_PORT } = {}) {
  const dir = shellPath('root', root);
  const key = apiKey ? shellToken('apiKey', apiKey) : '';
  const env = [
    `COVER_ROOT=${dir}`,
    `COVER_PORT=${Number(port) | 0}`,
    ...(key ? [`COVER_API_KEY=${key}`] : []),
    `PATH=${dir}/bin:$PATH`,
  ].join(' ');
  return `cd ${dir} && ${env} ${dir}/svc-venv/bin/python ${dir}/server.py`;
}

/** POST /api/job/submitJob 的报文（字段取自平台前端表单，资源与旧 sbatch 对齐） */
export function buildSubmitBody({
  root = REMOTE_ROOT,
  apiKey = '',
  partition = PARTITION,
  account = ACCOUNT,
  qos = QOS,
  minutes = JOB_MINUTES,
  memoryMb = JOB_MEMORY_MB,
  cores = JOB_CORES,
} = {}) {
  return {
    cluster: CLUSTER,
    command: buildLaunchCommand({ root, apiKey }),
    jobName: 'cover',
    partition: shellToken('partition', partition),
    account: shellToken('account', account),
    qos: shellToken('qos', qos),
    coreCount: Number(cores) | 0,
    gpuCount: 1,
    nodeCount: 1,
    maxTime: Number(minutes) | 0,
    maxTimeUnit: 0, // 平台枚举：0=分钟 1=小时 2=天
    memory: `${Number(memoryMb) | 0}MB`,
    workingDirectory: shellPath('root', root),
    save: false,
    output: 'cover-%j.out',
    errorOutput: 'cover-%j.err',
    scriptOutput: '',
    comment: 'parallel cover supervisor 自动提交',
  };
}

/**
 * 这一轮要不要自动提交作业。
 * @returns {{ submit: boolean, retryAt?: number, reason: string }}
 */
export function shouldSubmit({
  autoStart = false,
  cookieOk = true,
  jobs = [],
  now = Date.now(),
  lastSubmitAt = 0,
  lastFailedAt = 0,
  cooldownMs = SUBMIT_COOLDOWN_MS,
  retryMs = RETRY_COOLDOWN_MS,
} = {}) {
  if (!autoStart) return { submit: false, reason: '自动接线未开启' };
  if (!cookieOk) return { submit: false, reason: 'Cookie 已失效，先重新登录 107' };
  if (findRunningJob(jobs)) return { submit: false, reason: '已经有作业在跑' };
  if (findPendingJob(jobs)) return { submit: false, reason: '已有作业在排队' };
  const retryAt = Math.max(Number(lastSubmitAt) || 0, Number(lastFailedAt) || 0);
  const wait = retryAt + (lastFailedAt > lastSubmitAt ? retryMs : cooldownMs);
  if (retryAt && now < wait) {
    return { submit: false, reason: `冷却中（${Math.ceil((wait - now) / 1000)} 秒后再试）` };
  }
  return { submit: true, reason: '没有作业在跑' };
}

/** 从任意文本里抹掉 API Key，避免进日志 */
export function maskSecret(text, secret) {
  const s = String(text ?? '');
  const k = String(secret ?? '');
  return k ? s.split(k).join(k.slice(0, 4) + '***') : s;
}
