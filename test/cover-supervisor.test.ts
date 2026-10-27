import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planCoverSupervisor } from '../src/kernel/cover-supervisor.ts';

// ============================================================
// 107 翻唱服务守护进程（cover supervisor）
//
//  1. 作业挑选 / 节点解析 / 代理地址（纯逻辑）
//  2. 自动提交报文与启动命令（字段对齐平台表单，资源对齐旧 sbatch）
//  3. 提交冷却与「有作业在跑/排队就不重复提交」
//  4. 内核侧启停判断（noApi、插件未载入、开关、Cookie）
// ============================================================

const coreUrl = new URL('../scripts/cover/supervisor-core.mjs', import.meta.url).href;
// @ts-ignore -- 脚本是 .mjs，没有类型声明；测试只按运行时契约用
const core = await import(coreUrl) as Record<string, any>;

const runningJob = {
  jobId: '116492', name: 'cover', state: 'RUNNING', nodes: '1', nodesOrReason: 'anode16',
};
const pendingJob = {
  jobId: '116500', name: 'cover', state: 'PENDING', nodes: 'None', nodesOrReason: '(Priority)',
};

test('supervisor：RUNNING 且有节点才算跑起来，sing 作业名过渡期也认', () => {
  assert.equal(core.isRunningJob(runningJob), true);
  assert.equal(core.isRunningJob({ ...runningJob, nodes: 'None' }), false);
  assert.equal(core.isRunningJob({ ...runningJob, state: 'PENDING' }), false);
  assert.equal(core.isRunningJob({ ...runningJob, name: 'sing' }), true);
  assert.equal(core.isRunningJob({ ...runningJob, name: 'other' }), false);
  assert.equal(core.findRunningJob([pendingJob, runningJob])?.jobId, '116492');
});

test('supervisor：排队中不重复提交，PENDING/CONFIGURING 都算', () => {
  assert.equal(core.isPendingJob(pendingJob), true);
  assert.equal(core.isPendingJob({ ...pendingJob, state: 'CONFIGURING' }), true);
  assert.equal(core.isPendingJob(runningJob), false);
  assert.equal(core.findPendingJob([runningJob, pendingJob])?.jobId, '116500');
});

test('supervisor：节点名取 nodesOrReason 第一段，代理地址按平台规则拼', () => {
  assert.equal(core.jobNode({ nodesOrReason: 'anode16' }), 'anode16');
  assert.equal(core.jobNode({ nodesOrReason: 'anode16,anode17' }), 'anode16');
  assert.equal(core.jobNode({}), '');
  assert.equal(
    core.proxyBaseUrl('anode16'),
    'https://107.ustc.edu.cn/api/proxy/training/relative/anode16/8047',
  );
});

test('supervisor：只清理由自己接上的 SCOW 代理地址', () => {
  assert.equal(core.isManagedBaseUrl('https://107.ustc.edu.cn/api/proxy/training/relative/anode16/8047'), true);
  assert.equal(core.isManagedBaseUrl('https://107.ustc.edu.cn/api/proxy/training/relative/anode16/8047/'), true);
  assert.equal(core.isManagedBaseUrl('http://127.0.0.1:8047'), false);
  assert.equal(core.isManagedBaseUrl(''), false);
});

test('supervisor：启动命令带齐 ROOT/端口/KEY，路径与 KEY 都做字符校验', () => {
  const cmd = core.buildLaunchCommand({ root: '/home/scc/pb25071412/cover', apiKey: 'abc123' });
  assert.match(cmd, /^cd \/home\/scc\/pb25071412\/cover && /);
  assert.match(cmd, /COVER_ROOT=\/home\/scc\/pb25071412\/cover/);
  assert.match(cmd, /COVER_PORT=8047/);
  assert.match(cmd, /COVER_API_KEY=abc123/);
  assert.match(cmd, /\/home\/scc\/pb25071412\/cover\/svc-venv\/bin\/python \/home\/scc\/pb25071412\/cover\/server.py$/);
  assert.throws(() => core.buildLaunchCommand({ apiKey: 'a b' }), /apiKey/);
  assert.throws(() => core.buildLaunchCommand({ root: '/tmp/x;rm -rf /' }), /root/);
});

test('supervisor：未配置 KEY 时命令里不出现 COVER_API_KEY', () => {
  const cmd = core.buildLaunchCommand({ root: '/srv/cover', apiKey: '' });
  assert.doesNotMatch(cmd, /COVER_API_KEY/);
});

test('supervisor：提交报文与平台表单/旧 sbatch 对齐', () => {
  const body = core.buildSubmitBody({ root: '/home/scc/pb25071412/cover', apiKey: 'k-1' });
  assert.equal(body.cluster, 'training');
  assert.equal(body.jobName, 'cover');
  assert.equal(body.partition, 'Students');
  assert.equal(body.account, 'stu');
  assert.equal(body.qos, 'qos_stu_default');
  assert.equal(body.gpuCount, 1);
  assert.equal(body.coreCount, 4);
  assert.equal(body.nodeCount, 1);
  assert.equal(body.maxTime, 238);
  assert.equal(body.maxTimeUnit, 0); // 平台枚举 0=分钟
  assert.equal(body.memory, '16384MB');
  assert.equal(body.workingDirectory, '/home/scc/pb25071412/cover');
  assert.equal(body.output, 'cover-%j.out');
  assert.equal(body.errorOutput, 'cover-%j.err');
  assert.equal(body.save, false);
  assert.match(body.command, /COVER_PORT=8047/);
  assert.match(body.command, /COVER_API_KEY=k-1/);
});

test('supervisor：自动提交的闸门（开关/Cookie/在跑/排队/冷却）', () => {
  const now = 1_800_000_000_000;
  const base = { autoStart: true, cookieOk: true, jobs: [], now, lastSubmitAt: 0, lastFailedAt: 0 };
  assert.equal(core.shouldSubmit({ ...base, autoStart: false }).submit, false);
  assert.equal(core.shouldSubmit({ ...base, cookieOk: false }).submit, false);
  assert.equal(core.shouldSubmit({ ...base, jobs: [runningJob] }).submit, false);
  assert.equal(core.shouldSubmit({ ...base, jobs: [pendingJob] }).submit, false);
  assert.equal(core.shouldSubmit(base).submit, true);
  // 成功提交后 10 分钟内不重复提交
  assert.equal(core.shouldSubmit({ ...base, lastSubmitAt: now - 60_000 }).submit, false);
  assert.equal(core.shouldSubmit({ ...base, lastSubmitAt: now - 11 * 60_000 }).submit, true);
  // 失败后要等 30 分钟
  assert.equal(core.shouldSubmit({ ...base, lastFailedAt: now - 11 * 60_000 }).submit, false);
  assert.equal(core.shouldSubmit({ ...base, lastFailedAt: now - 31 * 60_000 }).submit, true);
});

test('supervisor：日志里抹掉 API Key', () => {
  assert.equal(core.maskSecret('COVER_API_KEY=abcdef123456 boom', 'abcdef123456'), 'COVER_API_KEY=abcd*** boom');
  assert.equal(core.maskSecret('nothing', ''), 'nothing');
});

test('内核侧：cover supervisor 的启停判断', () => {
  const ok = {
    noApi: false, disabledByEnv: false, pluginLoaded: true,
    autoStart: true, hasCookie: true, childRunning: false,
  };
  assert.equal(planCoverSupervisor(ok).action, 'start');
  assert.equal(planCoverSupervisor({ ...ok, childRunning: true }).action, 'none');
  assert.equal(planCoverSupervisor({ ...ok, noApi: true }).action, 'stop');
  assert.equal(planCoverSupervisor({ ...ok, disabledByEnv: true }).action, 'stop');
  assert.equal(planCoverSupervisor({ ...ok, pluginLoaded: false }).action, 'stop');
  assert.equal(planCoverSupervisor({ ...ok, autoStart: false }).action, 'stop');
  assert.equal(planCoverSupervisor({ ...ok, hasCookie: false }).action, 'stop');
  assert.match(planCoverSupervisor({ ...ok, hasCookie: false }).reason, /Cookie/);
});
