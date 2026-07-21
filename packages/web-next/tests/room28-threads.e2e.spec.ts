import { expect, test, type Page } from '@playwright/test';

const ROOM = '/?room=threads&token=next-e2e-token';

async function openThreadsRoom(page: Page): Promise<void> {
  await page.goto(ROOM);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

/** The chip carries the root message id, and the fixture's roots are the only
 *  two messages in the room that have one. */
async function chipFor(page: Page, body: string) {
  const article = page.locator('article', { hasText: body }).first();
  return article.locator('[data-testid^="thread-chip-"]');
}

test.describe('threads in the browser', () => {
  test('an old thread opens complete, from its own history rather than the channel', async ({ page }) => {
    const threadReads: string[] = [];
    await page.route('**/threads/*/messages*', async (route) => {
      threadReads.push(new URL(route.request().url()).pathname);
      await route.continue();
    });
    await openThreadsRoom(page);

    // «parser» sits ~50 messages back, so its root is not in the socket's
    // hydration tail at all — search and jump to it the way an operator would.
    await expect(page.getByTestId('msg-1')).toHaveCount(0);
    await page.getByTestId('toggle-message-search').click();
    await page.getByTestId('search-input').fill('parser rewrite');
    await page.getByTestId('search-hit-1').click();
    await expect(page.getByTestId('msg-1')).toBeInViewport({ timeout: 15_000 });

    const chip = await chipFor(page, 'ship the parser rewrite');
    await expect(chip).toBeVisible();
    await chip.click();

    // The panel does not depend on how much channel history happens to be
    // loaded — it reads the thread's own, so it opens whole.
    const panel = page.getByTestId('thread-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('ship the parser rewrite');
    await expect(panel.getByText('parser reply 25')).toBeVisible();
    await expect(panel.getByText('parser reply 1', { exact: true })).toBeVisible();
    await expect(chip).toContainText('25 replies');
    expect(threadReads.some((path) => /\/threads\/\d+\/messages$/.test(path))).toBe(true);
  });

  test('the unread badge counts peer replies the viewer has not opened', async ({ page }) => {
    await openThreadsRoom(page);
    const chip = await chipFor(page, 'the ledger spec is flaky again');
    await expect(chip).toContainText('2 replies');
    await expect(chip.locator('[data-testid^="thread-unread-"]')).toHaveText('2');

    // Opening the thread is what clears it — reading the channel never does.
    await chip.click();
    await expect(page.getByTestId('thread-panel')).toBeVisible();
    await expect(chip.locator('[data-testid^="thread-unread-"]')).toHaveCount(0);
  });

  test('a reply posts into the thread, not the channel, and closing seals it', async ({ page }) => {
    await openThreadsRoom(page);
    const chip = await chipFor(page, 'the ledger spec is flaky again');
    await chip.click();

    const panel = page.getByTestId('thread-panel');
    await panel.getByTestId('composer-input').fill('reproduced under full-suite load');
    await panel.getByTestId('composer-input').press('Enter');
    await expect(panel).toContainText('reproduced under full-suite load');
    // The main transcript hides threaded messages — that is the whole point of
    // the thread, and the reply must not leak into the channel.
    await expect(page.getByTestId('timeline')).not.toContainText('reproduced under full-suite load');

    await panel.getByTestId('close-thread').click();
    await expect(panel.getByTestId('thread-closed-note')).toBeVisible();
    await expect(panel.getByTestId('composer-input')).toHaveCount(0);
    await expect(page.getByTestId('timeline')).toContainText('closed thread');
  });
});
