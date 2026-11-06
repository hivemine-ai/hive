// Another participant of the smoke Hive (default name smoke-sender, override
// with SENDER), registered with the same enrollment credential. It keeps its
// last Worker token next to the credential and renews with it, so repeated runs
// do not claim the name again. Requires `pnpm build` (it uses the proxy's
// Upstream from packages/cli/dist).
//
//   node hivetool.mjs send <agent-ref> <body>
//   node hivetool.mjs status <agent-ref>
//   node hivetool.mjs list

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { Upstream } = await import(
  new URL('../../../packages/cli/dist/session/upstream.js', import.meta.url).href
);

const smoke = process.env.SMOKE;
const url = process.env.HIVE_SMOKE_URL;
if (!smoke || !url) throw new Error('source the env.sh written by setup.sh first');
const enroll = readFileSync(join(smoke, 'hive', 'enroll.jwt'), 'utf8').trim();
const name = process.env.SENDER ?? 'smoke-sender';
const saved = join(smoke, 'hive', `${name}.token`);

const up = new Upstream({ url, clientVersion: 'smoke', probeTimeoutMs: 5000 });
const discovered = await up.discover(enroll);
if (!discovered.ok) throw new Error(discovered.message);
const args = { name, description: 'Sender of the Claude Code smoke' };
let reg = existsSync(saved)
  ? await up.registerSession(readFileSync(saved, 'utf8'), args)
  : { ok: false };
if (!reg.ok) reg = await up.registerSession(enroll, args);
if (!reg.ok) throw new Error(JSON.stringify(reg));
writeFileSync(saved, reg.token, { mode: 0o600 });

const client = await up.connect(() => reg.token);
const [cmd, ...rest] = process.argv.slice(2);
let result;
if (cmd === 'send') {
  result = await client.callTool({
    name: 'send_message',
    arguments: { recipient: rest[0], type: 'notification', body: rest[1] },
  });
} else if (cmd === 'status') {
  result = await client.callTool({ name: 'get_agent_status', arguments: { participant: rest[0] } });
} else if (cmd === 'list') {
  result = await client.callTool({ name: 'list_agents', arguments: {} });
} else {
  throw new Error('usage: hivetool.mjs send <ref> <body> | status <ref> | list');
}
console.log(JSON.stringify(result.structuredContent ?? result.content));
await client.close();
