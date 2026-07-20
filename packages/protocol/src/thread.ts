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
 * What surfaces render. Reply count and last activity are DERIVED by query at
 * projection time rather than stored on the thread row, so they cannot drift
 * from the messages they describe.
 */
export const ThreadSummarySchema = z.object({
  root_message_id: MessageIdSchema,
  title: z.string().min(1),
  state: ThreadStateSchema,
  reply_count: z.number().int().nonnegative(),
  last_ts: TimestampSchema.optional(), // absent until the thread has a reply
  last_author_handle: z.string().optional(),
  // harn:assume thread-unread-is-its-own-durable-cursor ref=thread-summary-unread
  /**
   * Counted against the viewer's own THREAD cursor, never the room cursor:
   * thread messages are interleaved in the room's seq stream, so reading the
   * main channel past them would otherwise silently clear the thread.
   */
  unread: z.number().int().nonnegative(),
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
