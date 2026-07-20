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
import { ThreadPanel } from './ThreadPanel.js';

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
