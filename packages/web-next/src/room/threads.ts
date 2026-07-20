import type { Member, Message } from '@codor/protocol';

export interface ThreadMessagePage {
  messages: Message[];
  has_more: boolean;
}

/**
 * The socket hydrates a bounded tail of the room, so a thread whose replies
 * fell outside it opens half-empty — and, because the chip counts what the
 * client holds, undercounted too. This reads the thread's own history instead
 * of paging the whole channel back to reach a handful of replies. Mirrors the
 * fetchJson auth shape, kept here so the feature stays in one batch.
 */
export async function fetchThreadMessages(
  room: string,
  rootMessageId: number,
  page: { before?: number; limit?: number },
  token: string,
): Promise<ThreadMessagePage> {
  const query = new URLSearchParams();
  if (page.before !== undefined) query.set('before', String(page.before));
  if (page.limit !== undefined) query.set('limit', String(page.limit));
  const res = await fetch(
    `/api/rooms/${encodeURIComponent(room)}/threads/${String(rootMessageId)}/messages?${query.toString()}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`thread history request failed: ${String(res.status)}`);
  return res.json() as Promise<ThreadMessagePage>;
}

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
