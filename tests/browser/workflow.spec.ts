import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import type { Snapshot } from '../../src/lib/types';
test('upload, duplicate preview, rule review, bulk finalize, repayment, date filter, correction and undo', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/empty-overview.png', fullPage: true });
  await page.getByRole('button', { name: 'Add your first person' }).click();
  const personDialog = page.getByRole('dialog');
  await personDialog.getByLabel('Name', { exact: true }).fill('Alex');
  await personDialog.getByLabel('@handle').fill('alex');
  await personDialog.getByLabel('Relationship').fill('Friend');
  await personDialog.getByRole('button', { name: 'Add person', exact: true }).click();
  await expect(personDialog).not.toBeVisible();
  async function upload() {
    await page.getByRole('button', { name: 'Import statements', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Statement CSV').setInputFiles(resolve('tests/fixtures/chase.csv'));
    await dialog.getByRole('button', { name: 'Preview import' }).click();
    await expect(dialog.getByRole('heading', { name: 'Review your import' })).toBeVisible();
    return dialog;
  }
  let dialog = await upload();
  await expect(dialog.getByText('2026-01-10 → 2026-03-05', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm import' }).click();
  await expect(dialog.getByText('4 new transactions', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Finish for now' }).click();
  let state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.dashboard.inboxCount).toBe(4);
  expect(state.dashboard.totalOutstandingCents).toBe(0);
  dialog = await upload();
  await expect(dialog.getByRole('button', { name: 'Confirm import' })).toBeDisabled();
  await expect(dialog.getByText(/Matches:/)).toHaveCount(5);
  await dialog.getByRole('checkbox', { name: /I reviewed/ }).check();
  await dialog.getByRole('button', { name: 'Confirm import' }).click();
  await dialog.getByRole('button', { name: 'Finish for now' }).click();
  await page.getByRole('button', { name: 'Rules & context' }).click();
  await page.getByRole('button', { name: 'Propose rule', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Rule name').fill('Coffee with Alex');
  await dialog.getByLabel('Merchant description contains').fill('COFFEE');
  await dialog.getByRole('checkbox', { name: 'Alex', exact: true }).check();
  await dialog.getByRole('button', { name: 'Save rule proposal' }).click();
  await expect(page.getByText('Needs your approval', { exact: true })).toBeVisible();
  state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.rules).toHaveLength(0);
  await page.getByRole('button', { name: 'Approve rule', exact: true }).click();
  await page.getByRole('button', { name: 'Review workspace', exact: false }).click();
  await page.getByRole('button', { name: 'Process Inbox', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve 2', exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.screenshot({ path: 'test-results/review-board.png', fullPage: true });
  await page.getByRole('button', { name: 'Approve 2', exact: true }).click();
  state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.dashboard.finalizedCount).toBe(2);
  const owed = state.dashboard.totalOutstandingCents;
  expect(owed).toBeGreaterThan(1900);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Record repayment', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Repayment amount').fill('5.00');
  await dialog.getByLabel('Date', { exact: true }).fill('2026-04-01');
  await dialog.getByRole('button', { name: 'Save repayment' }).click();
  await page.getByLabel('Start date', { exact: true }).fill('2026-01-01');
  await page.getByLabel('End date', { exact: true }).fill('2026-01-31');
  await expect(page.getByText('Unpaid from selected dates', { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const d = (await (
        await request.get('/api/state?from=2026-01-01&to=2026-01-31')
      ).json()) as Snapshot;
      return d.dashboard.filteredOutstandingCents;
    })
    .toBe(owed - 500);
  await page.screenshot({ path: 'test-results/populated-overview.png', fullPage: true });
  await page.getByRole('button', { name: 'View Alex transactions' }).click();
  await expect(page.getByRole('dialog').getByText('2026-04-01 · Received')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('button', { name: 'Review workspace', exact: false }).click();
  const grocery = page
    .locator('.transaction-card')
    .filter({ has: page.getByRole('heading', { name: 'GROCERY STORE', exact: true }) });
  await grocery.getByRole('button', { name: 'Edit split', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Give an instruction' }).click();
  await dialog.getByLabel('Correction instruction').fill('Split equally with @al');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await dialog.getByRole('option').click();
  await dialog.getByRole('button', { name: 'Save instruction' }).click();
  await page.getByRole('button', { name: 'Generate revised splits' }).click();
  const revised = page
    .locator('.transaction-card')
    .filter({ has: page.getByRole('heading', { name: 'GROCERY STORE', exact: true }) });
  await expect(revised.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({
    timeout: 20000,
  });
  await revised.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.transactions.find((t) => t.description === 'GROCERY STORE')?.state).toBe('ready');
  expect(state.dashboard.finalizedCount).toBe(2);
  const origin = await request.post('/api/people', {
    headers: { Origin: 'https://untrusted.example' },
    data: { name: 'No', handle: 'no', relation: '' },
  });
  expect(origin.status()).toBe(403);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.screenshot({ path: 'test-results/mobile-overview.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});

test('quick Enter instructions, mention selection, saved context, chat formatting and finalized lookup', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const person = await request.post('/api/people', {
    data: { name: 'Riley', handle: 'riley', relation: 'Friend' },
  });
  expect(person.ok()).toBe(true);
  const content =
    'Date,Description,Amount\n06/01/2026,QUICK DINNER,40.00\n06/02/2026,QUICK MARKET,12.50';
  const preview = await (
    await request.post('/api/imports/preview', {
      multipart: {
        accountId: 'amex',
        file: { name: 'quick-synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from(content) },
      },
    })
  ).json();
  const imported = await (
    await request.post('/api/imports/confirm', {
      data: { id: preview.id, acknowledgeSkips: false, keepRows: [], skipInvalid: false },
    })
  ).json();
  expect(imported.ids).toHaveLength(2);
  const baseline = (await (await request.get('/api/state')).json()) as Snapshot;
  await page.goto('/');
  await page.getByRole('button', { name: 'Review workspace', exact: false }).click();
  await page.getByLabel('Search transactions').fill('QUICK DINNER');
  const card = page
    .locator('.transaction-card')
    .filter({ has: page.getByRole('heading', { name: 'QUICK DINNER', exact: true }) });
  const input = card.getByLabel('Instructions for QUICK DINNER');
  await input.fill('Dinner after our hiking trip. Split equally with @ri');
  await expect(card.getByRole('option')).toHaveCount(1);
  await input.press('Enter');
  await expect(input).toHaveValue('Dinner after our hiking trip. Split equally with @riley ');
  expect(((await (await request.get('/api/state')).json()) as Snapshot).jobs).toHaveLength(
    baseline.jobs.length,
  );
  await input.press('Enter');
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({
    timeout: 20000,
  });
  let state = (await (await request.get('/api/state')).json()) as Snapshot;
  let dinner = state.transactions.find((t) => t.description === 'QUICK DINNER')!;
  expect(dinner.state).toBe('ready');
  expect(dinner.notes[0].text).toContain('hiking trip');
  expect(state.dashboard.totalOutstandingCents).toBe(baseline.dashboard.totalOutstandingCents);
  await card.locator('.transaction-context summary').click();
  await expect(
    card.getByText('Dinner after our hiking trip. Split equally with @riley', { exact: true }),
  ).toBeVisible();
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('button', { name: 'Finalized', exact: true }).click();
  await page.getByLabel('Search transactions').fill('hiking trip');
  await page.getByRole('button', { name: 'View saved context', exact: true }).click();
  await expect(
    page
      .getByRole('dialog')
      .getByText('Dinner after our hiking trip. Split equally with @riley', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('button', { name: 'Review workspace', exact: false }).click();
  await page.getByLabel('Search transactions').fill('QUICK MARKET');
  await page.getByLabel('Select QUICK MARKET', { exact: true }).check();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Split assistant' });
  await expect(panel.getByText('1 selected expense', { exact: true })).toBeVisible();
  const chat = panel.getByLabel('Message the agent');
  await chat.fill('This was for my balcony garden.');
  await chat.press('Shift+Enter');
  await expect(chat).toHaveValue('This was for my balcony garden.\n');
  await chat.pressSequentially('Personal expense.');
  await chat.press('Enter');
  await expect(chat).toHaveValue('');
  await expect(panel.locator('.chat-markdown strong').last()).toHaveText('1 split', {
    timeout: 20000,
  });
  await expect
    .poll(
      async () => {
        const snapshot = (await (await request.get('/api/state')).json()) as Snapshot;
        return snapshot.transactions.find((t) => t.description === 'QUICK MARKET')?.state;
      },
      { timeout: 20000 },
    )
    .toBe('ready');
  state = (await (await request.get('/api/state')).json()) as Snapshot;
  const market = state.transactions.find((t) => t.description === 'QUICK MARKET')!;
  expect(market.state).toBe('ready');
  expect(market.notes[0].text).toContain('balcony garden');
  expect(market.proposal?.splits).toHaveLength(1);
  await panel.getByRole('button', { name: 'QUICK MARKET', exact: true }).last().click();
  await expect(page.getByRole('dialog').getByText(/This was for my balcony garden/)).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Close chat' }).click();
  await page.reload();
  state = (await (await request.get('/api/state')).json()) as Snapshot;
  dinner = state.transactions.find((t) => t.description === 'QUICK DINNER')!;
  expect(dinner.state).toBe('finalized');
  expect(dinner.notes[0].text).toContain('hiking trip');
  expect(errors).toEqual([]);
});

test('approve a chat rule and process matching Inbox expenses without leaving review', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  expect(
    (
      await request.post('/api/people', {
        data: { name: 'Casey', handle: 'casey', relation: 'Friend' },
      })
    ).ok(),
  ).toBe(true);
  const preview = await (
    await request.post('/api/imports/preview', {
      multipart: {
        accountId: 'amex',
        file: {
          name: 'chat-rule-synthetic.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(
            'Date,Description,Amount\n07/01/2026,CHAT RULE LUNCH,20.00\n07/02/2026,CHAT RULE LUNCH,30.00',
          ),
        },
      },
    })
  ).json();
  const imported = await (
    await request.post('/api/imports/confirm', {
      data: {
        id: preview.id,
        acknowledgeSkips: false,
        keepRows: [],
        skipInvalid: false,
      },
    })
  ).json();
  const before = (await (await request.get('/api/state')).json()) as Snapshot;
  await page.goto('/');
  await page.getByRole('button', { name: 'Review workspace', exact: false }).click();
  await page.getByLabel('Search transactions').fill('CHAT RULE LUNCH');
  await page.getByLabel('Select CHAT RULE LUNCH', { exact: true }).first().check();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Split assistant' });
  await panel
    .getByLabel('Message the agent')
    .fill('Propose a reusable rule: split CHAT RULE LUNCH equally with @casey.');
  await panel.getByLabel('Message the agent').press('Enter');
  const card = panel
    .locator('.chat-rule-card.proposed')
    .filter({ hasText: 'CHAT RULE LUNCH split rule' });
  await expect(card.getByRole('button', { name: 'Approve rule', exact: true })).toBeVisible({
    timeout: 20000,
  });
  await expect(
    card.getByText('Equal split: Me, Casey · Food & Drink', { exact: true }),
  ).toBeVisible();
  let state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.rules).toHaveLength(before.rules.length);
  const change = state.ruleChanges.find((c) => c.title === 'CHAT RULE LUNCH split rule')!;
  expect(change.jobId).toBe(state.messages.findLast((m) => m.role === 'user')!.jobId);
  await card.getByRole('checkbox', { name: 'Also process 2 matching Inbox expenses' }).check();
  await card.getByRole('button', { name: 'Approve rule', exact: true }).click();
  await expect(panel.getByText('Rule approved', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review workspace', exact: true })).toBeVisible();
  await expect
    .poll(
      async () => {
        const snapshot = (await (await request.get('/api/state')).json()) as Snapshot;
        return snapshot.transactions.filter(
          (tx) => imported.ids.includes(tx.id) && tx.state === 'ready',
        ).length;
      },
      { timeout: 20000 },
    )
    .toBe(2);
  state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.dashboard.finalizedCount).toBe(before.dashboard.finalizedCount);
  expect(state.rules).toHaveLength(before.rules.length + 1);
  await panel
    .getByLabel('Message the agent')
    .fill('Propose a reusable rule: make the selected expenses my personal expense.');
  await panel.getByLabel('Message the agent').press('Enter');
  const rejectedCard = panel.locator('.chat-rule-card.proposed').last();
  await expect(rejectedCard.getByRole('button', { name: 'Reject', exact: true })).toBeVisible({
    timeout: 20000,
  });
  await rejectedCard.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(panel.getByText('Rule rejected', { exact: true })).toBeVisible();
  state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.rules).toHaveLength(before.rules.length + 1);
  await page.reload();
  await page.getByRole('button', { name: 'Review workspace', exact: false }).click();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await expect(panel.getByText('Rule approved', { exact: true }).last()).toBeVisible();
  await expect(panel.getByText('Rule rejected', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('preview rule cleanup, merge merchant alternatives, delete and undo from the rulebook', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const definition = {
    merchant: 'RULE OPT COFFEE',
    accountId: 'prime',
    from: '2026-01-01',
    to: '2026-12-31',
    outputCategory: 'Personal',
    split: { mode: 'personal', participants: ['self'] },
  };
  for (const [title, merchant] of [
    ['Cleanup coffee A', 'RULE OPT COFFEE'],
    ['Cleanup coffee B', 'rule opt coffee'],
    ['Cleanup tea', 'RULE OPT TEA'],
  ]) {
    const response = await request.post('/api/rules/propose', {
      data: { title, definition: { ...definition, merchant } },
    });
    expect(response.ok()).toBe(true);
    const change = await response.json();
    expect(
      (await request.post('/api/rules/review', { data: { id: change.id, approve: true } })).ok(),
    ).toBe(true);
  }
  const before = (await (await request.get('/api/state')).json()) as Snapshot;
  const cohortIds = before.rules
    .filter((rule) => rule.title.startsWith('Cleanup '))
    .map((rule) => rule.id);
  const finalized = before.transactions.filter((tx) => tx.state === 'finalized');
  await page.goto('/');
  await page.getByRole('button', { name: 'Rules & context', exact: false }).click();
  await page.getByRole('button', { name: 'Optimize rules', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Cleanup coffee A', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Cleanup tea', { exact: true })).toBeVisible();
  let state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.rules.filter((rule) => rule.active && cohortIds.includes(rule.id))).toHaveLength(3);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Optimize rules', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Cleanup coffee A', { exact: true })).toBeVisible();
  const group = dialog.locator('.optimization-group').filter({ hasText: 'Cleanup coffee A' });
  await expect(
    group.getByText('3 rules → 1 rule · 1 exact duplicate', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply 1 selected group', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  state = (await (await request.get('/api/state')).json()) as Snapshot;
  const merged = state.rules.find((rule) => rule.active && cohortIds.includes(rule.id))!;
  expect(state.rules.filter((rule) => rule.active && cohortIds.includes(rule.id))).toHaveLength(1);
  expect([merged.definition.merchant, ...(merged.definition.merchantAliases || [])].sort()).toEqual(
    ['RULE OPT COFFEE', 'RULE OPT TEA'],
  );
  expect(state.transactions.filter((tx) => tx.state === 'finalized')).toEqual(finalized);
  expect(state.dashboard.totalOutstandingCents).toBe(before.dashboard.totalOutstandingCents);
  const mergedCard = page
    .locator('.rule-card')
    .filter({ has: page.getByRole('heading', { name: merged.title, exact: true }) });
  await mergedCard.getByRole('button', { name: 'Propose edit', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Merchant description contains')).toHaveValue(
    'RULE OPT COFFEE\nRULE OPT TEA',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await mergedCard.getByRole('button', { name: 'Delete ' + merged.title, exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Delete this rule?', exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete rule', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.rules.filter((rule) => rule.active && cohortIds.includes(rule.id))).toHaveLength(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.rules.filter((rule) => rule.active && cohortIds.includes(rule.id))).toHaveLength(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.rules.filter((rule) => rule.active && cohortIds.includes(rule.id))).toHaveLength(3);
  expect(errors).toEqual([]);
});
