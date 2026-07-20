import type { Message, ThreadSummary } from '@codor/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    useEffect: (effect: any) => {
      effect();
    },
  };
});

vi.mock('../app/store.js', async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    useClientStore: Object.assign(
      (selector: any) => selector(original.useClientStore.getState()),
      original.useClientStore
    ),
  };
});

vi.mock('./Composer.js', () => ({
  Composer: () => <div data-testid="mock-composer">Composer</div>,
}));

import { resetClientStoreForTest, useClientStore } from '../app/store.js';
import { ThreadChip, ThreadPanel } from './ThreadPanel.js';

const mockConnection = {
  post: vi.fn(),
  act: vi.fn(),
  disconnect: vi.fn(),
  reconnect: vi.fn(),
};

function mockRoomState(messages: Record<number, Message>, threads: Record<number, ThreadSummary>) {
  useClientStore.setState({
    connected: true,
    rooms: {
      eng: {
        hydrated: true,
        selfMemberId: 'me',
        room: { id: 'eng', name: 'ENG', created_ts: '', config: {} as any },
        seq: 10,
        members: {},
        memberHistory: {},
        messages,
        inbox: {},
        threads,
        meter: undefined,
        runEvents: {},
        support: undefined,
        historyCursor: 1,
        errors: [],
      },
    },
  });
}

describe('ThreadPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClientStoreForTest();
  });

  afterEach(() => {
    resetClientStoreForTest();
  });

  it('renders the thread root message and replies, but not other room messages', () => {
    mockRoomState(
      {
        1: { id: 1, room: 'eng', author: 'user1', kind: 'chat', body: 'root message', seq: 1 } as any,
        2: { id: 2, room: 'eng', author: 'user2', kind: 'chat', body: 'reply message', seq: 2, thread_root_id: 1 } as any,
        3: { id: 3, room: 'eng', author: 'user3', kind: 'chat', body: 'unrelated message', seq: 3 } as any,
      },
      {
        1: { root_message_id: 1, title: 'My Thread', state: 'open', reply_count: 1, unread: 0 } as any,
      }
    );

    const markup = renderToStaticMarkup(
      <ThreadPanel
        room="eng"
        rootMessageId={1}
        token={() => 'token'}
        connection={mockConnection}
        onClose={vi.fn()}
      />
    );

    expect(markup).toContain('My Thread');
    expect(markup).toContain('root message');
    expect(markup).toContain('reply message');
    expect(markup).not.toContain('unrelated message');
  });

  it('sends mark_thread_read on mount with highest seq in thread', () => {
    vi.useFakeTimers();
    mockRoomState(
      {
        1: { id: 1, room: 'eng', author: 'user1', kind: 'chat', body: 'root message', seq: 1 } as any,
        2: { id: 2, room: 'eng', author: 'user2', kind: 'chat', body: 'reply message 1', seq: 4, thread_root_id: 1 } as any,
        3: { id: 3, room: 'eng', author: 'user3', kind: 'chat', body: 'reply message 2', seq: 8, thread_root_id: 1 } as any,
      },
      {
        1: { root_message_id: 1, title: 'My Thread', state: 'open', reply_count: 2, unread: 1 } as any,
      }
    );

    renderToStaticMarkup(
      <ThreadPanel
        room="eng"
        rootMessageId={1}
        token={() => 'token'}
        connection={mockConnection}
        onClose={vi.fn()}
      />
    );

    vi.runAllTimers();
    expect(mockConnection.act).toHaveBeenCalledWith({
      act: 'mark_thread_read',
      root_message_id: 1,
      through_seq: 8,
    });
    vi.useRealTimers();
  });

  it('renders read-only (no composer, closed note) when closed', () => {
    mockRoomState(
      {
        1: { id: 1, room: 'eng', author: 'user1', kind: 'chat', body: 'root message', seq: 1 } as any,
      },
      {
        1: { root_message_id: 1, title: 'My Closed Thread', state: 'closed', reply_count: 0, unread: 0 } as any,
      }
    );

    const markup = renderToStaticMarkup(
      <ThreadPanel
        room="eng"
        rootMessageId={1}
        token={() => 'token'}
        connection={mockConnection}
        onClose={vi.fn()}
      />
    );

    expect(markup).toContain('Thread closed');
    expect(markup).not.toContain('mock-composer');
  });

  it('close control sends set_thread_state to closed', () => {
    mockRoomState(
      {
        1: { id: 1, room: 'eng', author: 'user1', kind: 'chat', body: 'root message', seq: 1 } as any,
      },
      {
        1: { root_message_id: 1, title: 'My Thread', state: 'open', reply_count: 0, unread: 0 } as any,
      }
    );

    const markup = renderToStaticMarkup(
      <ThreadPanel
        room="eng"
        rootMessageId={1}
        token={() => 'token'}
        connection={mockConnection}
        onClose={vi.fn()}
      />
    );

    expect(markup).toContain('Close Thread');
  });
});

// harn:assume threads-are-in-room-message-groups ref=chip-derives-from-messages-regression
describe('ThreadChip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClientStoreForTest();
  });

  afterEach(() => {
    resetClientStoreForTest();
  });

  const summary = { root_message_id: 1, title: 'My Thread', state: 'open' } as ThreadSummary;

  const chip = (rendered: ThreadSummary = summary) => renderToStaticMarkup(
    <ThreadChip room="eng" summary={rendered} onClick={vi.fn()} />,
  );

  it('counts the replies it can see rather than a number the server pushed', () => {
    // The server broadcasts no counts, so a chip that waited for one would sit
    // frozen at hydration while the thread filled up.
    mockRoomState(
      {
        1: { id: 1, room: 'eng', author: 'user1', kind: 'chat', body: 'root', seq: 1 } as any,
        2: { id: 2, room: 'eng', author: 'user2', kind: 'chat', body: 'a', seq: 2, thread_root_id: 1 } as any,
        3: { id: 3, room: 'eng', author: 'user2', kind: 'chat', body: 'b', seq: 3, thread_root_id: 1 } as any,
        4: { id: 4, room: 'eng', author: 'user2', kind: 'chat', body: 'elsewhere', seq: 4 } as any,
      },
      { 1: summary },
    );
    expect(chip()).toContain('2 replies');
  });

  it('counts everything above the viewer cursor as unread, except their own', () => {
    mockRoomState(
      {
        1: { id: 1, room: 'eng', author: 'user1', kind: 'chat', body: 'root', seq: 1 } as any,
        2: { id: 2, room: 'eng', author: 'user2', kind: 'chat', body: 'read', seq: 2, thread_root_id: 1 } as any,
        3: { id: 3, room: 'eng', author: 'user2', kind: 'chat', body: 'new', seq: 5, thread_root_id: 1 } as any,
        4: { id: 4, room: 'eng', author: 'me', kind: 'chat', body: 'mine', seq: 6, thread_root_id: 1 } as any,
      },
      { 1: { ...summary, read_through_seq: 3 } as ThreadSummary },
    );
    const markup = chip({ ...summary, read_through_seq: 3 });
    expect(markup).toContain('thread-unread-1');
    expect(markup).toContain('>1<'); // one peer message above the cursor; the viewer's own never counts
  });

  it('shows no badge when the cursor covers the thread', () => {
    mockRoomState(
      {
        1: { id: 1, room: 'eng', author: 'user1', kind: 'chat', body: 'root', seq: 1 } as any,
        2: { id: 2, room: 'eng', author: 'user2', kind: 'chat', body: 'read', seq: 2, thread_root_id: 1 } as any,
      },
      { 1: { ...summary, read_through_seq: 9 } as ThreadSummary },
    );
    expect(chip({ ...summary, read_through_seq: 9 })).not.toContain('thread-unread-1');
  });
});
// harn:end threads-are-in-room-message-groups
