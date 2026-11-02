import { describe, expect, it } from 'vitest';

import { register } from './register.js';

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
};

function load(options) {
  const handlers = {};
  register((event, handler) => (handlers[event] = handler), options);
  const spawns = [];
  const toasts = [];
  const submits = [];
  const $ = {
    process: {
      spawn: ({ argv }) => {
        spawns.push(argv);
        return {
          next: () => new Promise(() => {}),
          return: () => Promise.resolve({ done: true }),
        };
      },
      run: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    },
    prompt: { submit: (arg) => (submits.push(arg), Promise.resolve({ text: arg.text })) },
    ui: { toast: (text) => toasts.push(text) },
  };
  const pass = (e) => Promise.resolve(e);
  return { handlers, $, spawns, toasts, submits, pass };
}

describe('register', () => {
  it('registers the four hooks', () => {
    const { handlers } = load({ server_url: 'http://h/mcp' });
    expect(Object.keys(handlers).sort()).toEqual([
      'session.end',
      'session.start',
      'turn.complete',
      'turn.start',
    ]);
  });

  it('starts hivectl watch at session.start with the configured options', async () => {
    const t = load({
      server_url: 'http://h/mcp',
      credential_file: '/c',
      hivectl_path: '/bin/hivectl',
    });
    await t.handlers['session.start'](t.$, {}, t.pass);
    await flush();
    expect(t.spawns[0]).toEqual([
      '/bin/hivectl',
      'watch',
      '--server',
      'http://h/mcp',
      '--credential-file',
      '/c',
    ]);
  });

  it('discards the controller at session.end so the next session.start starts a fresh watch', async () => {
    const t = load({ server_url: 'http://h/mcp' });
    await t.handlers['session.start'](t.$, {}, t.pass);
    await flush();
    await t.handlers['session.end'](t.$, {}, t.pass);
    await t.handlers['session.start'](t.$, {}, t.pass);
    await flush();
    expect(t.spawns).toHaveLength(2);
  });

  it('warns and does not start watch without a server URL', async () => {
    const t = load({ server_url: '' });
    await t.handlers['session.start'](t.$, {}, t.pass);
    await flush();
    expect(t.spawns).toHaveLength(0);
    expect(t.toasts[0]).toMatch(/server_url/);
  });

  it('passes events through to the next hook and ignores subagent turns', async () => {
    const t = load({ server_url: 'http://h/mcp' });
    await t.handlers['session.start'](t.$, {}, t.pass);
    const e = { agentId: 'sub-1', turnId: 't' };
    expect(await t.handlers['turn.start'](t.$, e, t.pass)).toBe(e);
    expect(await t.handlers['turn.complete'](t.$, e, t.pass)).toBe(e);
    await flush();
  });
});
