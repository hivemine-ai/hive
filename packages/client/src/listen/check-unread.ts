// One-shot query of the caller's unread summary through `check_unread_messages`.
// Stateless: it opens a short-lived client, makes one call and closes. It never
// reads message bodies.

import { ListenError } from './errors.js';
import { parseUnreadSummary } from './event.js';
import type { UnreadSummary } from './event.js';
import { closeClient, connectClient, toListenError } from './sdk-client.js';
import type { SdkClientOptions } from './sdk-client.js';

export type CheckUnreadOptions = Omit<SdkClientOptions, 'onBytes'>;

export async function checkUnread(options: CheckUnreadOptions): Promise<UnreadSummary> {
  const client = await connectClient(options);
  try {
    const result = await client.callTool({ name: 'check_unread_messages', arguments: {} });
    if (result.isError === true) {
      throw new ListenError('transport', 'check_unread_messages reported an error');
    }
    const structured: unknown = result.structuredContent;
    let raw: unknown = structured;
    if (raw === undefined) {
      const first = (result.content as { type: string; text?: string }[] | undefined)?.[0];
      if (first?.type === 'text' && typeof first.text === 'string') {
        try {
          raw = JSON.parse(first.text);
        } catch {
          raw = undefined;
        }
      }
    }
    const summary = parseUnreadSummary(raw);
    if (summary === null) {
      throw new ListenError('transport', 'check_unread_messages returned an invalid summary');
    }
    return summary;
  } catch (err) {
    throw toListenError(err);
  } finally {
    await closeClient(client);
  }
}
