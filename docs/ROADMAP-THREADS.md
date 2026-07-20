# Threads — Discord-style mini-channels inside a channel

## Context

Codor channels are flat. A long-running task, a side investigation, or one agent's
multi-turn debugging all land in the same linear transcript as everything else, so
the channel stops being readable and humans lose the thread of any single task.
`reply_to` exists but is documented as a *display hint only* (`docs/PROTOCOL.md:81`)
— it groups nothing. `docs/ROADMAP.md:132` already names "threading beyond `reply_to`"
as the intended evolution.

Goal: threads that behave like Discord's — a thread is started **from a message**,
holds its own message list, is read and written in a nested view, and is closed
manually when the task is done.

Decided with the user up front (these select the architecture):

| Question | Answer |
|---|---|
| Agent session in a thread | **Shared with the parent channel** — a thread is an organizational construct, not a fresh agent context |
| UI placement | **Nested in the channel** — "N replies" chip on the root message opens a panel; channel rail unchanged |
| How started | **From an existing message only** — no standalone threads |
| Lifecycle | **Manual close only** — no auto-archive sweep, no timers |

Consequence to be explicit about: because sessions are shared, a thread focuses the
*human's* view, not the agent's context. The agent still sees the whole channel
interleaved; the delivery header tells it *where to post*, not what to attend to.
Thread-scoped agent contexts would require threads to be child rooms — explicitly
out of scope.

## Architecture

A thread is **a group of messages inside its room**, keyed by the id of the message
it was started from. It is not a room. Room-scoped invariants (member roster,
`seq` changelog, deliveries, run journals, meters, read cursor) stay exactly as they
are. This mirrors the existing `collaboration_groups` pattern in
`packages/switchboard/src/store.ts:130` — durable state keyed by
`(room, root_message_id)`.

Rules that keep it small:

- **No nesting.** A message that already carries `thread_root_id` cannot be a thread root.
- **The root message stays in the main channel** (its own `thread_root_id` is NULL), same as Discord.
- **Routing is thread-blind.** `packages/switchboard/src/router.ts` is a pure function
  over (message, room state); mentions still choose recipients. A thread never scopes,
  widens, or narrows delivery. A human in the main channel reaches an agent that is
  busy in a thread with a plain `@handle`, and the reply comes back in main because
  replies follow the *delivery's* location, not the agent's.
- **An agent always has a way out to the channel.** Turn output is auto-posted and
  inherits its delivery's thread, so a thread-bound agent needs an explicit escape to
  report to the room: `codor post --main`. Thread create/close also post system markers
  in the main channel, so a thread finishing is visible without the agent doing anything.
- **Threads get their own read cursor.** `room_read_cursors` (`store.ts:429`) is one
  monotonic `through_seq` per room, and thread messages are interleaved in that same
  seq stream — so reading the main channel past seq 100 would silently clear a thread
  whose messages sit at seq 40–50. Discord's independent thread unread needs its own
  cursor: a `thread_read_cursors` table plus a `mark_thread_read` act, mirroring the
  room cursor's durable/monotonic contract.
- **All wire changes are additive** — optional fields with "absent is the default",
  matching `ack` / `pinned` / `deleted` / `attachments`. No `BROWSER_PROTOCOL_EPOCH`
  bump. A stale client simply renders thread messages inline, i.e. today's flat channel.

## Implementation

### Phase 1 — protocol (`packages/protocol/src`)

- `message.ts`: add `thread_root_id: MessageIdSchema.optional()` to `MessageSchema`,
  commented in the house style ("absent is the additive main-channel default").
- New `thread.ts`:
  - `ThreadSchema` — `{ room, root_message_id, title, state: 'open'|'closed', created_by, created_ts, closed_ts? }`
  - `ThreadSummarySchema` — the SHARED facts a frame may broadcast:
    `{ root_message_id, title, state, read_through_seq? }`. Reply count, last
    activity and unread are derived by each client from the thread messages it
    already holds; `read_through_seq` rides only frames addressed to one viewer
    (hydration, and the answer to `mark_thread_read`), because a broadcast cursor
    would hand every subscriber somebody else's read position.
  - export both from `index.ts`.
- `ws.ts`:
  - `PostFrameSchema` gains `thread_root_id: MessageIdSchema.optional()`.
  - `ActSchema` gains `{ act: 'create_thread', root_message_id, title? }`,
    `{ act: 'set_thread_state', root_message_id, state }`, and
    `{ act: 'mark_thread_read', root_message_id, through_seq }` (same durable/monotonic
    contract as `mark_room_read`).
  - `ServerFrameSchema` gains `{ type: 'thread', seq, thread: ThreadSummarySchema, room? }`.
- Tests: extend `schemas.spec.ts` (round-trip, optional-absent, refusals).

### Phase 2 — store (`packages/switchboard/src/store.ts`)

- `SCHEMA`: `messages.thread_root_id INTEGER`; new `threads` table keyed
  `(room, root_message_id)` with the same `FOREIGN KEY (room, root_message_id)
  REFERENCES messages(room, id) ON DELETE CASCADE` shape used by
  `collaboration_groups`.
- Migration `migrateMessageThreads(db)` alongside the existing
  `migrateDeliveryPayloadSnapshot` / `migrateMemberCustody` helpers: `ALTER TABLE
  messages ADD COLUMN thread_root_id`, `CREATE TABLE IF NOT EXISTS threads`,
  `CREATE INDEX messages_thread ON messages (room, thread_root_id, id)`, and
  `thread_read_cursors (room, root_message_id, viewer, through_seq)` modelled on
  `room_read_cursors` (`store.ts:429`) — monotonic, never moves backwards.
- Row plumbing: `MessageRow`, `messageFromRow` (`store.ts:731`), `postMessage`
  insert column list (`store.ts:1452`) — exactly where `reply_to` already appears.
- New methods: `createThread`, `getThread`, `listThreads(room, {state?})`,
  `setThreadState`, `listThreadMessages(room, rootId, {before?, limit?})`,
  `threadSummary(room, rootId, viewer)` (reply count / last activity computed by
  query — never stored, so they cannot drift; unread counts messages above the
  viewer's thread cursor), `markThreadRead`.
- **Agent reply inheritance** in `beginTurn` (`store.ts:2264`, run message posted at
  `store.ts:2350`): the run message inherits the `thread_root_id` of its **last
  admitted delivery** — the same tie-break `router.ts:76-80` already uses to pick a
  batched turn's default reply target (`triggerAuthor` = author of the last delivery).
  A batch mixing a thread delivery and a main-channel one replies wherever the most
  recent thing spoken to the agent lives. This is the one new routing-adjacent
  mechanic; without it every agent reply lands outside the thread that asked.
- Continuation rows inherit the root run's `thread_root_id`
  (`packages/switchboard/src/continuation.ts`, `daemon.ts` `outputPatches`).

### Phase 3 — daemon (`packages/switchboard/src/daemon.ts`)

- `postChatMessage` (`daemon.ts:1821`) takes `threadRootId` and validates: root exists
  in room, root is not deleted, root is not itself threaded, thread exists and is
  `open` (posting into a closed thread is refused with an error frame — closing is
  deliberate). `postHumanMessage` / `postAgentMessage` pass it through.
  **Close race:** an agent turn already in flight when its thread closes still lands
  in that thread — the closed check applies to *new* posts, never to a reply whose
  `thread_root_id` was inherited at `beginTurn`. Dropping such output would lose a
  completed turn.
- New acts `create_thread` / `set_thread_state` / `mark_thread_read` handled next to
  `pin_message` and `mark_room_read`;
  create is allowed to any non-observer member, state change to author/admin/owner
  (reuse `authorization.ts` gates). Both emit a `thread` frame and a changelog row.
- `changes.entity` gains `thread` so delta-sync and reconnect carry threads.
- Hydration emits `thread` frames for the room's threads before `sync_complete`.
- Cards inherit context: the `ask`/`approval` card posted at `daemon.ts:3415` inherits
  the thread of the author's current run message; the audit reply at `daemon.ts:3490`
  inherits from the card.
- **Delivery header**: `composePayload` in `router.ts:242` emits `thread=#N` in the
  `[codor channel=… msg=#… ]` header when the message is threaded, so an agent can
  see which thread it is being spoken to in. Main-channel deliveries are unchanged.
- **Conventions trailer** (`composeDeliveryBriefing`, `router.ts:205`): one added line
  on a threaded delivery — "you are in thread #N; your reply posts there; use
  `codor post --main` to speak to the whole channel." Sent once per member like the
  rest of the trailer.
- Both change byte-pinned goldens in `router.spec.ts` — update them deliberately.
- **System markers**: creating a thread posts a `system` message in the main channel
  ("@dudu started thread «title» on #38"), and closing posts one with a preview of the
  thread's last result. System messages never route (`router.ts:40` eligibility gate),
  so these are visible without waking any agent.

### Phase 4 — REST + CLI

- `packages/switchboard/src/server.ts`: `GET /api/rooms/:room/threads`, and
  `GET /api/rooms/:room/threads/:rootId/messages` (paged) so opening an old thread
  works when its messages fell outside `hydrate_limit`. Same auth wrapper as the
  neighbouring room routes.
- `packages/cli/src/program.ts` (`program.ts:537`):
  - `post --thread <#id>` — post into a thread from outside it;
  - `post --main` — post to the main channel from inside a thread (the agent's escape
    hatch; mutually exclusive with `--thread`);
  - `tail --thread <#id>`;
  - `threads` — list open threads (`--all` includes closed).
  Extend `packages/cli/src/index.spec.ts`.

### Phase 5 — web client (`packages/web-next/src`)

- `app/store.ts`: `RoomSlice.threads: Record<number, ThreadSummary>`; `applyFrame`
  handles `type: 'thread'`.
- `room/Transcript.tsx`: hide messages carrying `thread_root_id` from the main
  transcript; render a "N replies · last active" chip under the root message; add a
  "Create thread" hover action. Transcript.tsx is already 76KB — put everything new
  in a sibling file, not in it.
- New `room/ThreadPanel.tsx`: header (title, close-thread control), thread message
  list, own `Composer` bound to `thread_root_id`; sends `mark_thread_read` on open
  and on new messages while open, like the room's existing read-cursor behaviour.
  Mounted from `RoomPage.tsx`
  alongside `ContextPanel` (`RoomPage.tsx:127/143/160`), following the same mobile
  overlay / desktop column pattern already there.
- `room/Composer.tsx`: accept an optional thread target and set `thread_root_id`
  on the `post` frame.

### Harn assumptions to add (`.harn/assumptions/`)

- `threads-are-in-room-message-groups` — a thread is a message grouping keyed by root
  message id, never a room; members, deliveries, seq, meters stay room-scoped.
- `agent-replies-stay-in-their-thread` — a run message inherits the thread of its
  last admitted delivery, and an agent always retains `codor post --main` to address
  the whole channel.
- `thread-context-travels-in-delivery-header` — a threaded delivery carries `thread=#N`
  in its payload header.
- `thread-unread-is-its-own-durable-cursor` — a thread's unread never clears from
  reading the parent channel; only `mark_thread_read` moves it, monotonically.

Mark the guarded regions with `// harn:assume … / // harn:end …` per `CLAUDE.md`.

### Out of scope (deliberate)

Auto-archive timers; thread-scoped agent sessions or contexts; per-thread member
subsets; per-thread brakes and meters; nested threads; standalone
(rootless) threads; Slack/Telegram bridge thread mapping (`packages/bridges`).

## Worked example: orchestrator + 3 workers in a thread

Channel `#eng`, thread «new-feature» rooted on message #38. Members are channel
members — `spawn` stays room-scoped, there is no thread roster.

1. @dudu creates the thread from #38 and posts in it: `@orchestrator build X`.
   Main channel shows a system marker plus the "N replies" chip on #38.
2. @orchestrator's delivery header reads `thread=#38`; its turn output auto-posts
   **into the thread**. It writes `@worker1 @worker2 take the parser` — a normal
   mention fan-out, deliveries created as usual, both replies inherit `#38`.
3. @orchestrator wants the room to know it shipped: `codor post --main "@dudu
   feature done — details in thread #38"`. That's an interim post with no thread, so
   it lands in the main transcript and in @dudu's inbox. Its own turn conversation
   with the workers continues in the thread.
4. Meanwhile @dudu asks in the main channel: `@worker3 what's the ETA?`. Routing is
   thread-blind, so worker3 gets the delivery in its same session and its reply lands
   in the **main** channel — that's where it was spoken to.
5. If worker3 happens to have both a thread delivery and @dudu's main delivery queued,
   they batch; the reply follows the **last** admitted delivery, the same tie-break the
   router already uses for the default reply target.
6. @dudu closes the thread. A system marker with the last result lands in main;
   further posts into the thread are refused, but any turn already in flight still
   lands there.

## Verification

1. `pnpm --filter @codor/protocol test` — schema round-trips.
2. `pnpm --filter @codor/switchboard test` — store migration on an existing DB
   (open a pre-migration fixture, assert no data loss), the inheritance rule in
   `beginTurn`, refusals (nested thread, closed thread, cross-room root), and the
   updated `router.spec.ts` payload goldens.
3. `pnpm --filter @codor/cli test`, `pnpm --filter @codor/web-next test`.
4. `pnpm -r build && pnpm test`.
5. Live probe (per `MANUAL-VERIFY.md` habit, and the memory note that the daemon
   serves stale `dist` until restarted — rebuild *and restart* first):
   - `codor up`, create a channel with a starting agent;
   - post a message, create a thread from it in the browser, post `@agent` inside
     the thread;
   - confirm the agent's reply appears **in the thread**, not the main channel, and
     that the main transcript shows only the root chip;
   - confirm the agent's delivery payload carried `thread=#N` (`codor tail --once`
     / run journal);
   - from the main channel, `@`-mention the same agent and confirm its reply comes
     back in main, not the thread;
   - run `codor post --main` as that agent and confirm the message lands in the main
     transcript;
   - read the main channel to the bottom and confirm the thread still shows unread
     until the panel is opened (independent cursor);
   - close the thread, confirm posting into it is refused;
   - reconnect the browser and confirm threads survive delta-sync.
6. `harn check` before calling it done.

## Notes

Phases are separable and each independently testable. Phases 2, 4 and 5 have disjoint
file scopes and are implemented in parallel by agy workers under supervision; only the
supervisor commits, in small single-responsibility commits per `CLAUDE.md`.

## Progress checklist

Live tracker — tick items as they land. Build order: phase 1 unblocks everything;
phases 2, 4, 5 then run in parallel (disjoint file scopes) against the phase-1
contracts; phase 3 lands after phase 2.

| Phase | Scope | Owner |
|---|---|---|
| 1 protocol | `packages/protocol` | Claude (orchestrator) |
| 2 store | `packages/switchboard/src/store.ts` + spec | agy worker A |
| 3 daemon + router | `daemon.ts`, `router.ts` + specs | Claude |
| 4 REST + CLI | `server.ts`, `packages/cli` | agy worker B |
| 5 web client | `packages/web-next` | agy worker C |
| 6 assumptions, docs, gate | `.harn/`, `docs/`, `README.md` | Claude |

### Phase 0 — setup
- [x] Branch `feat/threads` off `main`
- [x] Write `docs/ROADMAP-THREADS.md` (this plan + checklist); commit

### Phase 1 — protocol (`packages/protocol/src`)
- [x] `message.ts`: `thread_root_id?: MessageId` on `MessageSchema`, additive-default comment
- [x] New `thread.ts`: `ThreadSchema`, `ThreadSummarySchema` (`reply_count`, `last_ts`, `last_author_handle`, `unread`)
- [x] `index.ts`: export both
- [x] `ws.ts`: `PostFrameSchema.thread_root_id?`
- [x] `ws.ts`: acts `create_thread`, `set_thread_state`, `mark_thread_read`
- [x] `ws.ts`: server frame `{ type: 'thread', seq, thread, room? }`
- [x] `schemas.spec.ts`: round-trip + absent-optional + refusal cases
- [x] Confirm no `BROWSER_PROTOCOL_EPOCH` bump is needed; note why in the PR
- [x] `pnpm --filter @codor/protocol test` green; commit

### Phase 2 — store (`packages/switchboard/src/store.ts`)
- [x] `SCHEMA`: `messages.thread_root_id INTEGER`
- [x] `SCHEMA`: `threads (room, root_message_id, title, state, created_by, created_ts, closed_ts)` + FK to `messages(room, id)` ON DELETE CASCADE
- [x] `SCHEMA`: `thread_read_cursors (room, root_message_id, viewer, through_seq)`
- [x] `migrateMessageThreads(db)` helper + wire into the migration run
- [x] Index `messages_thread (room, thread_root_id, id)`
- [x] `MessageRow` / `messageFromRow` / `postMessage` insert list carry `thread_root_id`
- [x] `createThread`, `getThread`, `listThreads`, `setThreadState`
- [x] `listThreadMessages(room, rootId, { before?, limit? })`
- [x] `threadSummary(room, rootId, viewer)` — derived counts, cursor-based unread
- [x] `markThreadRead` — monotonic, never moves backwards
- [x] `beginTurn`: run message inherits `thread_root_id` of the **last admitted delivery**
- [x] Continuation rows inherit the root run's thread (`createRunContinuation`)
- [x] `store.spec.ts`: migration over a pre-migration fixture, no data loss
- [x] `store.spec.ts`: inheritance (single thread, mixed batch, none)
- [x] `store.spec.ts`: cursor monotonicity + unread unaffected by `mark_room_read`
- [x] `pnpm --filter @codor/switchboard test` green; commit

### Phase 3 — daemon + router (`packages/switchboard/src`)
- [x] `postChatMessage` takes `threadRootId`; `postHumanMessage` / `postAgentMessage` pass through
- [x] Validation: root exists, not deleted, not itself threaded, thread open
- [x] Close race: in-flight turn whose thread closed still lands in the thread
- [x] Acts `create_thread` / `set_thread_state` / `mark_thread_read` handled, authorized via `authorization.ts`
- [x] `changes.entity` gains `thread`; emit `thread` frames on change
- [x] Hydration emits thread frames before `sync_complete`
- [x] Ask/approval card inherits author's current run thread; audit reply inherits card
- [x] `router.ts` `composePayload`: `thread=#N` header field
- [x] `router.ts` `composeDeliveryBriefing`: thread conventions line incl. `codor post --main`
- [x] `router.spec.ts` payload goldens updated deliberately
- [x] System marker in main on thread create
- [x] System marker in main on thread close, with last-result preview
- [x] `daemon.spec.ts`: post-to-thread routes normally; agent reply lands in thread
- [x] `daemon.spec.ts`: main-channel mention of a thread-busy agent replies in main
- [x] `daemon.spec.ts`: closed-thread post refused; in-flight reply still lands
- [x] `pnpm --filter @codor/switchboard test` green; commit

### Phase 4 — REST + CLI
- [x] `server.ts`: `GET /api/rooms/:room/threads`
- [x] `server.ts`: `GET /api/rooms/:room/threads/:rootId/messages` (paged)
- [x] Same auth wrapper as neighbouring room routes; `server.spec.ts` coverage
- [x] `program.ts`: `post --thread <#id>`
- [x] `program.ts`: `post --main` (mutually exclusive with `--thread`)
- [x] `program.ts`: `tail --thread <#id>`
- [x] `program.ts`: `threads` command (`--all` includes closed)
- [x] `cli/src/index.spec.ts` coverage for each
- [x] `pnpm --filter @codor/cli test` green; commit

### Phase 5 — web client (`packages/web-next/src`)
- [x] `app/store.ts`: `RoomSlice.threads`; `applyFrame` handles `type: 'thread'`
- [x] `room/Transcript.tsx`: hide threaded messages from the main transcript
- [x] `room/Transcript.tsx`: "N replies · last active" chip on root messages
- [x] `room/Transcript.tsx`: "Create thread" hover action (new code in a sibling file, not in the 76KB file)
- [x] New `room/ThreadPanel.tsx`: header, title, close control, message list
- [x] `ThreadPanel` sends `mark_thread_read` on open and on new messages while open
- [x] `room/Composer.tsx`: optional thread target sets `thread_root_id` on post
- [x] `RoomPage.tsx`: mount panel desktop-column + mobile-overlay like `ContextPanel`
- [x] Unread badge on the chip, independent of the channel cursor
- [x] `store.spec.ts` + a `ThreadPanel` render test
- [x] `pnpm --filter @codor/web-next test` green; commit

### Phase 6 — assumptions, docs, release gate
- [x] `.harn/assumptions/threads-are-in-room-message-groups.yaml`
- [x] `.harn/assumptions/agent-replies-stay-in-their-thread.yaml`
- [x] `.harn/assumptions/thread-context-travels-in-delivery-header.yaml`
- [x] `.harn/assumptions/thread-unread-is-its-own-durable-cursor.yaml`
- [x] `harn:assume` / `harn:end` markers on every guarded region
- [x] `docs/PROTOCOL.md`: threads section; correct the `reply_to` "hint only" note
- [x] `docs/ARCHITECTURE.md`: thread grouping in the store section
- [x] `README.md` CLI reference: `threads`, `post --thread`, `post --main`
- [x] `pnpm -r build && pnpm test`
- [ ] `harn check` — the `harn` CLI is not installed on this host; markers and the
      four assumption files are in place, the gate itself has not been run
- [ ] Live probe: full verification walkthrough below, on a restarted daemon
- [ ] PR

### Known gaps (deliberate, not done)
- [ ] `ThreadPanel` reads only the thread messages already hydrated on the socket;
      the paged REST endpoint (`GET /api/rooms/:room/threads/:rootId/messages`)
      exists and is tested but the panel does not call it yet, so a thread whose
      replies fell outside `hydrate_limit` opens partially filled.
- [ ] Bridges (Slack/Telegram) have no thread mapping.

