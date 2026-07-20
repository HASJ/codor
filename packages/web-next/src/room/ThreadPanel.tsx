import type { Message, ThreadSummary } from '@codor/protocol';
import { X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

import type { Connection } from '@legacy/ws.js';

import { roomSlice, useClientStore } from '../app/store.js';
import { relativeTime } from '../primitives/identity.js';
import { Composer } from './Composer.js';

export function ThreadChip(props: { summary: ThreadSummary; onClick: () => void }) {
  const { summary, onClick } = props;
  const lastActiveStr = summary.last_ts ? ` · last active ${relativeTime(summary.last_ts)}` : '';
  const text = `${summary.reply_count} ${summary.reply_count === 1 ? 'reply' : 'replies'}${lastActiveStr}`;
  return (
    <button
      className="nx-thread-chip"
      onClick={onClick}
      data-testid={`thread-chip-${summary.root_message_id}`}
    >
      <span className="nx-thread-chip-text">{text}</span>
      {summary.unread > 0 && (
        <span className="nx-thread-unread-badge" data-testid={`thread-unread-${summary.root_message_id}`}>
          {summary.unread}
        </span>
      )}
    </button>
  );
}

function SimpleMessageRow(props: { message: Message; handle: string; isRoot?: boolean }) {
  const { message, handle, isRoot } = props;
  return (
    <div
      className={`nx-thread-message ${isRoot ? 'is-root' : ''}`}
      data-testid={isRoot ? `thread-root-msg-${message.id}` : `thread-msg-${message.id}`}
    >
      <div className="nx-thread-message-meta">
        <strong className="nx-thread-message-author">@{handle}</strong>
        <time className="nx-thread-message-time" dateTime={message.ts}>
          {new Date(message.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
        </time>
      </div>
      <div className="nx-thread-message-body">{message.body}</div>
    </div>
  );
}

export function ThreadPanel(props: {
  room: string;
  rootMessageId: number;
  token: () => string;
  connection: Connection;
  onClose: () => void;
}) {
  const slice = useClientStore((state) => roomSlice(state, props.room));
  const summary = slice.threads[props.rootMessageId];
  const rootMsg = slice.messages[props.rootMessageId];

  const threadMessages = useMemo(() => {
    return Object.values(slice.messages)
      .filter((msg) => msg.thread_root_id === props.rootMessageId)
      .sort((a, b) => a.id - b.id);
  }, [slice.messages, props.rootMessageId]);

  const highestSeq = useMemo(() => {
    if (threadMessages.length === 0) return 0;
    return Math.max(...threadMessages.map((m) => m.seq));
  }, [threadMessages]);

  const lastMarkedSeqRef = useRef(0);
  const readTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    // harn:assume thread-unread-is-its-own-durable-cursor ref=thread-panel-read-cursor
    if (highestSeq === 0 || highestSeq <= lastMarkedSeqRef.current) return;

    if (readTimerRef.current !== undefined) {
      clearTimeout(readTimerRef.current);
    }

    readTimerRef.current = setTimeout(() => {
      readTimerRef.current = undefined;
      if (highestSeq <= lastMarkedSeqRef.current) return;

      lastMarkedSeqRef.current = highestSeq;
      props.connection.act({
        act: 'mark_thread_read',
        root_message_id: props.rootMessageId,
        through_seq: highestSeq,
      });
    }, 300);

    return () => {
      if (readTimerRef.current !== undefined) {
        clearTimeout(readTimerRef.current);
      }
    };
    // harn:end thread-unread-is-its-own-durable-cursor
  }, [highestSeq, props.rootMessageId, props.connection]);

  // Members are the only place a handle lives; a message carries the stable id
  // precisely so a rename does not rewrite history.
  const handleOf = (memberId: string): string => slice.members[memberId]?.handle ?? 'unknown';

  const title = summary?.title ?? 'Thread';
  const rootAuthor = rootMsg === undefined ? '…' : handleOf(rootMsg.author);
  const rootPreview = rootMsg?.body ? rootMsg.body.split('\n')[0] : '';

  return (
    <div className="nx-thread-panel" data-testid="thread-panel">
      <header className="nx-thread-header">
        <div className="nx-thread-meta">
          <h3>{title}</h3>
          <p className="nx-thread-root-preview">
            Started by @{rootAuthor}: {rootPreview}
          </p>
        </div>
        <div className="nx-thread-actions">
          {summary?.state === 'open' && (
            <button
              className="nx-btn is-quiet"
              aria-label="Close thread"
              data-testid="close-thread"
              onClick={() => props.connection.act({
                act: 'set_thread_state',
                root_message_id: props.rootMessageId,
                state: 'closed'
              })}
            >
              Close Thread
            </button>
          )}
          <button
            className="nx-iconbtn is-quiet"
            aria-label="Dismiss panel"
            data-testid="dismiss-thread"
            onClick={props.onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="nx-thread-body" data-testid="thread-body">
        {rootMsg && <SimpleMessageRow message={rootMsg} handle={handleOf(rootMsg.author)} isRoot={true} />}
        {threadMessages.map((msg) => (
          <SimpleMessageRow key={msg.id} message={msg} handle={handleOf(msg.author)} />
        ))}
      </div>

      <footer className="nx-thread-footer">
        {summary?.state === 'open' ? (
          <Composer
            room={props.room}
            token={props.token}
            connection={props.connection}
            threadRootId={props.rootMessageId}
          />
        ) : (
          <div className="nx-thread-closed-note" data-testid="thread-closed-note">
            Thread closed
          </div>
        )}
      </footer>
    </div>
  );
}
