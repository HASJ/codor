// Threading helpers for the web client
export function isThreaded(message: { thread_root_id?: number }): boolean {
  return message.thread_root_id !== undefined;
}
