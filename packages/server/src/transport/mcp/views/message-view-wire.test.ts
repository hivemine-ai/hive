import { describe, expect, it } from 'vitest';

import type { MessageView } from '#domain/cells/index.js';

import { adaptMailbox } from './message-view-wire.js';

const HIVE_ID = '01900000-0000-7000-8000-0000000000ff';
const AGENT_ID = '01900000-0000-7000-8000-000000000001';

function message(from: string): MessageView {
  return {
    id: '01900000-0000-7000-8000-0000000000a1',
    from,
    to: AGENT_ID,
    type: 'notification',
    body: 'hello',
    action: null,
    replyTo: null,
    ttl: null,
    sentAt: new Date('2026-11-06T12:00:00.000Z'),
    storedAt: new Date('2026-11-06T12:00:00.000Z'),
    readAt: null,
    state: 'stored',
  };
}

describe('adaptMailbox — system sender (ADR-026)', () => {
  it('renders hives.id as the fixed label system, with from_kind system', () => {
    const { messages } = adaptMailbox([message(HIVE_ID)], 50, HIVE_ID);

    expect(messages[0]).toMatchObject({ from: 'system', from_kind: 'system' });
  });

  it('leaves a participant sender as its opaque id, without from_kind', () => {
    const { messages } = adaptMailbox([message(AGENT_ID)], 50, HIVE_ID);

    expect(messages[0]?.from).toBe(AGENT_ID);
    expect(messages[0]).not.toHaveProperty('from_kind');
  });
});
