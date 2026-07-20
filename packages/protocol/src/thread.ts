import { z } from 'zod';

import { MemberIdSchema, MessageIdSchema, RoomIdSchema, SeqSchema, TimestampSchema } from './ids.js';

// harn:assume threads-are-in-room-message-groups ref=thread-schema
/**
 * A thread is a GROUP OF MESSAGES INSIDE its room, keyed by the message it was
 * started from — never a room of its own. Members, deliveries, the `seq`
 * changelog and meters all stay room-scoped; only the display location of a
 * message changes. Mirrors the `collaboration_groups` keying: (room, root).
 */
export const ThreadStateSchema = z.enum(['open', 'closed']);
export type ThreadState = z.infer<typeof ThreadStateSchema>;

export const ThreadSchema = z.object({
  room: RoomIdSchema,
  root_message_id: MessageIdSchema, // the message the thread hangs off; stays in the main channel
  title: z.string().min(1),
  state: ThreadStateSchema,
  created_by: MemberIdSchema,
  created_ts: TimestampSchema,
  closed_ts: TimestampSchema.optional(), // absent while open
});
export type Thread = z.infer<typeof ThreadSchema>;

/**
 * What surfaces render — the SHARED facts only, so this frame is safe to
 * broadcast. Reply count, last activity and unread are all derived by the
 * client from the thread's messages, which it already holds: a server-pushed
 * count would go stale on every reply that did not also push a summary, and a
 * broadcast count computed for one viewer is wrong for all the others.
 */
export const ThreadSummarySchema = z.object({
  root_message_id: MessageIdSchema,
  title: z.string().min(1),
  state: ThreadStateSchema,
  // harn:assume thread-unread-is-its-own-durable-cursor ref=thread-summary-cursor
  /**
   * The viewer's own durable thread cursor, and therefore present ONLY on
   * frames addressed to one viewer (hydration, and the answer to
   * mark_thread_read). Unread is everything in the thread above it — counted
   * against this cursor, never the room's, because thread messages are
   * interleaved in the room seq stream and reading the channel past them would
   * otherwise clear a thread nobody opened.
   */
  read_through_seq: SeqSchema.optional(),
  // harn:end thread-unread-is-its-own-durable-cursor
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
// harn:end threads-are-in-room-message-groups

/** Durable per-viewer thread read cursor — monotonic, exactly like the room cursor. */
export const ThreadReadCursorSchema = z.object({
  room: RoomIdSchema,
  root_message_id: MessageIdSchema,
  viewer: MemberIdSchema,
  through_seq: SeqSchema,
});
export type ThreadReadCursor = z.infer<typeof ThreadReadCursorSchema>;
