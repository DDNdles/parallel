// 一次性诊断：用插件现成凭据探 cover 服务 health 与 /jobs 队列
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(new URL('../../data/parallel.db', import.meta.url).pathname.slice(1));
const conf = {};
for (const r of db.prepare("SELECT key,value FROM plugin_user_config WHERE plugin_id='cover'").all()) {
  conf[r.key] = JSON.parse(r.value);
}
const secrets = JSON.parse(readFileSync(new URL('../../data/secrets.json', import.meta.url), 'utf8'));
const ps = secrets.pluginSecrets?.cover || {};
const apiKey = String(ps.apiKey || '');
const cookie = String(ps.cookie || '');
console.log('baseUrl =', conf.baseUrl, '| apiKey set =', !!apiKey, '| cookie set =', !!cookie);

const headers = {
  ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}),
  ...(cookie ? { cookie } : {}),
};
const base = String(conf.baseUrl || '').replace(/\/+$/, '');
if (base) {
  for (const p of ['/health', '/jobs']) {
    try {
      const r = await fetch(base + p, { headers, signal: AbortSignal.timeout(25000) });
      console.log(p, 'HTTP', r.status, (await r.text()).slice(0, 420));
    } catch (e) { console.log(p, 'ERR', e.message); }
  }
}
