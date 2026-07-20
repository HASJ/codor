import type { Member, Message } from '@codor/protocol';

/** Threading helpers for the web client. */
export function isThreaded(message: { thread_root_id?: number }): boolean {
  return message.thread_root_id !== undefined;
}

export interface ThreadActivity {
  replyCount: number;
  lastTs?: string;
  lastAuthorHandle?: string;
  unread: number;
}

// harn:assume threads-are-in-room-message-groups ref=client-derived-thread-activity
/**
 * Reply count, last activity and unread are DERIVED here rather than pushed by
 * the server. The client already holds every message in the thread — it just
 * hides them from the main transcript — so deriving keeps the chip true after
 * every reply. A server-pushed count would freeze until the next summary frame,
 * and a count computed for one viewer is wrong for all the others.
 */
export function threadActivity(
  messages: Record<number, Message>,
  members: Record<string, Member>,
  rootMessageId: number,
  viewer: { id?: string; readThroughSeq: number },
): ThreadActivity {
  const replies = Object.values(messages)
    .filter((message) => message.thread_root_id === rootMessageId && message.deleted !== true)
    .sort((left, right) => left.id - right.id);
  const last = replies.at(-1);
  // Your own message is never unread to you, exactly as the daemon counts it.
  const unread = replies.filter((message) =>
    message.seq > viewer.readThroughSeq && message.author !== viewer.id).length;
  return {
    replyCount: replies.length,
    ...(last !== undefined && {
      lastTs: last.ts,
      lastAuthorHandle: members[last.author]?.handle,
    }),
    unread,
  };
}
// harn:end threads-are-in-room-message-groups
