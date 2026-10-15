import { test, expect, type Page } from '@playwright/test';
async function confirmSplits(page: Page, close = true) {
  const panel = page.getByRole('complementary', { name: 'Split assistant' });
  await expect(panel).toBeVisible({ timeout: 20000 });
  await expect
    .poll(
      async () => {
        const s = (await (await page.request.get('/api/state')).json()) as Snapshot;
        return s.jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
      },
      { timeout: 20000 },
    )
    .toBe(0);
  await expect(
    panel.getByRole('button', { name: 'Confirm split changes', exact: true }).first(),
  ).toBeVisible({ timeout: 20000 });
  while (await panel.getByRole('button', { name: 'Confirm split changes', exact: true }).count()) {
    const button = panel
      .getByRole('button', { name: 'Confirm split changes', exact: true })
      .first();
    const count = await panel
      .getByRole('button', { name: 'Confirm split changes', exact: true })
      .count();
    await button.click();
    await expect
      .poll(() => panel.getByRole('button', { name: 'Confirm split changes', exact: true }).count())
      .toBeLessThan(count);
  }
  if (close) await page.getByRole('button', { name: 'Close chat', exact: true }).click();
}

import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { TransferBundle } from '../../src/lib/data-transfer';
import type { Snapshot } from '../../src/lib/types';
test('upload, duplicate preview, rule review, bulk finalize, repayment, date filter, correction and undo', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?view=overview');
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
  await confirmSplits(page);
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
  await confirmSplits(page);
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
  await page.goto('/?view=overview');
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
  await confirmSplits(page);
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
  await confirmSplits(page, false);
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

test('chat manages rules automatically while transaction moves wait for confirmation', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await request.post('/api/people', {
    data: { name: 'Casey', handle: 'casey', relation: 'Friend' },
  });
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
      data: { id: preview.id, acknowledgeSkips: false, keepRows: [], skipInvalid: false },
    })
  ).json();
  const before = (await (await request.get('/api/state')).json()) as Snapshot;
  await page.goto('/?view=review');
  await page.getByLabel('Search transactions').fill('CHAT RULE LUNCH');
  await page.getByLabel('Select CHAT RULE LUNCH', { exact: true }).first().check();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Split assistant' });
  await panel
    .getByLabel('Message the agent')
    .fill('Propose a reusable rule: split CHAT RULE LUNCH equally with @casey.');
  await panel.getByLabel('Message the agent').press('Enter');
  await expect(
    panel
      .locator('.assistant-change-card')
      .filter({ hasText: 'Remembered rule: CHAT RULE LUNCH split rule' }),
  ).toBeVisible({ timeout: 20000 });
  expect(await panel.getByRole('button', { name: 'Approve rule', exact: true }).count()).toBe(0);
  let state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.rules.filter((r) => r.active)).toHaveLength(
    before.rules.filter((r) => r.active).length + 1,
  );
  expect(
    state.transactions.filter((t) => imported.ids.includes(t.id)).every((t) => t.state === 'inbox'),
  ).toBe(true);
  await page.getByRole('button', { name: 'Close chat' }).click();
  await page.getByRole('button', { name: 'Process selected', exact: true }).click();
  await confirmSplits(page);
  await expect
    .poll(async () => {
      const s = (await (await request.get('/api/state')).json()) as Snapshot;
      return s.transactions.filter((t) => imported.ids.includes(t.id) && t.state === 'ready')
        .length;
    })
    .toBe(2);
  state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.dashboard.finalizedCount).toBe(before.dashboard.finalizedCount);
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
  await page.goto('/?view=overview');
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

test('download transactions and rules, preview duplicate skips, and import saved splits and rule proposals', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const personResponse = await request.post('/api/people', {
    data: { name: 'Transfer Alex', handle: 'transfer_alex', relation: 'Friend' },
  });
  expect(personResponse.ok()).toBe(true);
  const person = await personResponse.json();
  const importResponse = await request.post('/api/imports/preview', {
    multipart: {
      accountId: 'amex',
      file: {
        name: 'synthetic-transfer.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('Date,Description,Amount\n01/10/2026,TRANSFER SEED MEAL,11.51'),
      },
    },
  });
  const importPreview = await importResponse.json();
  const confirmation = await request.post('/api/imports/confirm', {
    data: { id: importPreview.id, acknowledgeSkips: true, keepRows: [], skipInvalid: false },
  });
  expect(confirmation.ok()).toBe(true);
  const imported = await confirmation.json();
  expect(
    (
      await request.post('/api/transactions/proposal', {
        data: {
          id: imported.ids[0],
          version: 1,
          category: 'Food & Drink',
          mode: 'equal',
          participants: ['self', person.id],
        },
      })
    ).ok(),
  ).toBe(true);
  const seedRuleResponse = await request.post('/api/rules/propose', {
    data: {
      title: 'Transfer seed rule',
      definition: {
        merchant: 'TRANSFER SEED RULE',
        outputCategory: 'Food & Drink',
        split: { mode: 'equal', participants: ['self', person.id] },
      },
    },
  });
  const seedRule = await seedRuleResponse.json();
  expect(
    (await request.post('/api/rules/review', { data: { id: seedRule.id, approve: true } })).ok(),
  ).toBe(true);
  await page.goto('/?view=overview');
  await page.getByRole('button', { name: 'Import / export', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Export transactions', exact: true }),
  ).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download JSON', exact: true }).click();
  const download = await downloadEvent;
  const bundle = JSON.parse(await readFile((await download.path())!, 'utf8')) as Extract<
    TransferBundle,
    { kind: 'transactions' }
  >;
  expect(bundle.format).toBe('splitwise-ai');
  expect(bundle.transactions.length).toBeGreaterThan(0);
  const csvDownload = page.waitForEvent('download');
  await dialog.getByLabel('Export format').selectOption('csv');
  await dialog.getByRole('button', { name: 'Download CSV', exact: true }).click();
  expect((await csvDownload).suggestedFilename()).toMatch(/\.csv$/);

  await dialog.getByLabel('Splitwise AI JSON file').setInputFiles({
    name: 'transactions.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bundle)),
  });
  await dialog.getByRole('button', { name: 'Preview transactions import', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: 'Review your import', exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Import 0 transactions', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /I reviewed the .*duplicate/ }).check();
  if (bundle.people.length > 1)
    await dialog.getByRole('checkbox', { name: /I reviewed these person matches/ }).check();
  await dialog.getByRole('button', { name: 'Import 0 transactions', exact: true }).click();
  await expect(dialog).not.toBeVisible();

  const before = (await (await request.get('/api/state')).json()) as Snapshot;
  const saved = bundle.transactions.find((tx) => tx.proposal && !tx.proposal.refundOf)!;
  expect(saved).toBeTruthy();
  bundle.transactions = [
    {
      ...saved,
      id: 'transfer-browser-expense',
      description: 'TRANSFER BROWSER LUNCH',
      instruction: 'A synthetic imported lunch.',
      notes: [
        {
          id: 'transfer-note',
          text: 'Imported hiking trip context.',
          source: 'instruction',
          createdAt: '2026-01-10T12:00:00.000Z',
        },
      ],
    },
  ];
  await page.getByRole('button', { name: 'Import / export', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Splitwise AI JSON file').setInputFiles({
    name: 'new-transaction.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bundle)),
  });
  await dialog.getByRole('button', { name: 'Preview transactions import', exact: true }).click();
  await expect(dialog.getByText('TRANSFER BROWSER LUNCH', { exact: true })).toBeVisible();
  if (bundle.people.length > 1)
    await dialog.getByRole('checkbox', { name: /I reviewed these person matches/ }).check();
  await dialog.getByRole('button', { name: 'Import 1 transaction', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  let state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.transactions.find((t) => t.id === 'transfer-browser-expense')).toMatchObject({
    state: 'ready',
    notes: [{ text: 'Imported hiking trip context.' }],
  });
  expect(state.dashboard.totalOutstandingCents).toBe(before.dashboard.totalOutstandingCents);

  await page.getByRole('button', { name: 'Rules & context', exact: false }).click();
  await page.getByRole('button', { name: 'Import / export rules', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('tab', { name: 'Rules', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const rulesEvent = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download rules JSON', exact: true }).click();
  const rulesDownload = await rulesEvent;
  const rules = JSON.parse(await readFile((await rulesDownload.path())!, 'utf8')) as Extract<
    TransferBundle,
    { kind: 'rules' }
  >;
  expect(rules.rules.length).toBeGreaterThan(0);
  rules.rules = [
    {
      ...rules.rules[0],
      id: 'transfer-browser-rule',
      title: 'Imported browser merchant rule',
      definition: {
        ...rules.rules[0].definition,
        merchant: 'TRANSFER RULE MERCHANT',
        merchantAliases: ['TRANSFER ALT MERCHANT'],
      },
    },
  ];
  const activeBefore = state.rules.filter((r) => r.active);
  await dialog.getByLabel('Splitwise AI JSON file').setInputFiles({
    name: 'rules.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(rules)),
  });
  await dialog.getByRole('button', { name: 'Preview rules import', exact: true }).click();
  await expect(dialog.getByText('Imported browser merchant rule', { exact: true })).toBeVisible();
  if (rules.people.length > 1)
    await dialog.getByRole('checkbox', { name: /I reviewed these person matches/ }).check();
  await dialog.getByRole('button', { name: 'Import 1 rule proposal', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.rules.filter((r) => r.active)).toEqual(activeBefore);
  expect(state.ruleChanges.find((r) => r.title === 'Imported browser merchant rule')).toMatchObject(
    { status: 'proposed', definition: { merchantAliases: ['TRANSFER ALT MERCHANT'] } },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Import / export', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Transactions', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: 'Export transactions', exact: true }),
  ).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  expect(errors).toEqual([]);
});

test('ask for date-scoped CSV context, save with mentions, process later, skip duplicates, and process a second import immediately', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const personResponse = await request.post('/api/people', {
    data: { name: 'Import Context Friend', handle: 'import_context_friend', relation: 'Friend' },
  });
  expect(personResponse.ok()).toBe(true);
  const person = await personResponse.json();
  const body =
    'Date,Description,Amount\n01/01/2026,AUTOPAY PAYMENT,-100.00\n01/10/2026,CSV CONTEXT MEAL,20.01\n01/11/2026,CSV CONTEXT COFFEE,11.50\n02/01/2026,CSV CONTEXT OTHER,8.00';
  await page.goto('/?view=overview');
  async function upload(content: string) {
    await page.getByRole('button', { name: 'Import statements', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox').selectOption('amex');
    await dialog.getByLabel('Statement CSV').setInputFiles({
      name: 'synthetic-context.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(content),
    });
    await dialog.getByRole('button', { name: 'Preview import', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Review your import' })).toBeVisible();
    return dialog;
  }
  let dialog = await upload(body);
  await dialog.getByRole('button', { name: 'Confirm import', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: 'Anything to know about this period?' }),
  ).toBeVisible();
  await expect(
    dialog.getByText('American Express · 2026-01-10 → 2026-02-01', { exact: true }),
  ).toBeVisible();
  const contextBox = dialog.getByLabel('Context for this import (optional)');
  await contextBox.fill('On a hiking trip; split equally with @import_context_');
  await dialog.getByRole('option', { name: /Import Context Friend/ }).click();
  await dialog.getByText('Use a narrower date range', { exact: true }).click();
  await dialog.getByLabel('Context start date').fill('2026-01-10');
  await dialog.getByLabel('Context end date').fill('2026-01-11');
  await expect(dialog.getByText(/Applies to 2 newly imported transactions/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1200, height: 1100 });
  await page.screenshot({ path: 'test-results/import-context-prompt.png', fullPage: false });
  await dialog.getByRole('button', { name: 'Save context & finish', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  let state = (await (await request.get('/api/state')).json()) as Snapshot;
  const imported = state.transactions.filter((tx) => tx.description.startsWith('CSV CONTEXT '));
  expect(imported).toHaveLength(3);
  expect(imported.filter((tx) => tx.notes.some((note) => note.source === 'import'))).toHaveLength(
    2,
  );
  const other = imported.find((tx) => tx.description === 'CSV CONTEXT OTHER')!;
  expect(other.notes).toHaveLength(0);
  expect(
    state.jobs.some((job) => job.payload.ids?.some((id) => imported.some((tx) => tx.id === id))),
  ).toBe(false);
  const balance = state.dashboard.totalOutstandingCents;
  await page.reload();
  await page.getByRole('button', { name: 'Review workspace', exact: false }).click();
  for (const description of ['CSV CONTEXT MEAL', 'CSV CONTEXT COFFEE'])
    await page.getByRole('checkbox', { name: 'Select ' + description, exact: true }).check();
  await page.getByRole('button', { name: 'Process selected', exact: true }).click();
  await confirmSplits(page);
  await expect
    .poll(async () => {
      const current = (await (await request.get('/api/state')).json()) as Snapshot;
      return current.transactions
        .filter(
          (tx) => tx.description === 'CSV CONTEXT MEAL' || tx.description === 'CSV CONTEXT COFFEE',
        )
        .every(
          (tx) =>
            tx.state === 'ready' &&
            tx.proposal!.splits.some((share) => share.personId === person.id),
        );
    })
    .toBe(true);
  const contextCard = page
    .locator('.transaction-card')
    .filter({ has: page.getByRole('heading', { name: 'CSV CONTEXT MEAL', exact: true }) });
  await contextCard.getByText('Saved context', { exact: false }).click();
  await expect(contextCard.getByText(/From statement import/)).toBeVisible();

  dialog = await upload(body);
  await dialog.getByRole('checkbox', { name: /I reviewed/ }).check();
  await dialog.getByRole('button', { name: 'Confirm import', exact: true }).click();
  await expect(dialog.getByText('0 new transactions', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Context for this import (optional)')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Finish for now', exact: true }).click();
  const beforeNow = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(beforeNow.transactions.find((tx) => tx.id === other.id)!.notes).toHaveLength(0);

  dialog = await upload('Date,Description,Amount\n02/10/2026,CSV CONTEXT NOW,12.00');
  await dialog.getByRole('button', { name: 'Confirm import', exact: true }).click();
  await dialog
    .getByLabel('Context for this import (optional)')
    .fill('Personal expense. A souvenir from the trip.');
  await dialog.getByRole('button', { name: 'Save context & process', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await confirmSplits(page);
  await expect
    .poll(async () => {
      state = (await (await request.get('/api/state')).json()) as Snapshot;
      return state.transactions.find((tx) => tx.description === 'CSV CONTEXT NOW')?.state;
    })
    .toBe('ready');
  expect(state.transactions.find((tx) => tx.description === 'CSV CONTEXT NOW')).toMatchObject({
    notes: [{ source: 'import', text: 'Personal expense. A souvenir from the trip.' }],
    proposal: { splits: [{ personId: 'self', amountCents: 1200 }] },
  });
  expect(state.dashboard.totalOutstandingCents).toBe(balance);
  expect(errors).toEqual([]);
});

test('settings persist privacy and time zone, add card accounts, download full data, and protect repayment retries', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?view=overview');
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Workspace settings', exact: true });
  await expect(dialog.getByRole('heading', { name: 'Privacy & AI', exact: true })).toBeVisible();
  await dialog.getByLabel('Time zone', { exact: true }).fill('UTC');
  await dialog.getByLabel('Allow AI processing of my workspace data').check();
  await dialog.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Preferences saved.');
  await dialog.getByLabel('Account name', { exact: true }).fill('Synthetic extra Amex');
  await dialog.getByLabel('CSV format', { exact: true }).selectOption('amex');
  await dialog.getByRole('button', { name: 'Add card account', exact: true }).click();
  await expect(dialog.getByText('Synthetic extra Amex', { exact: true })).toBeVisible();
  const settings = await (await request.get('/api/settings')).json();
  expect(settings.timezone).toBe('UTC');
  expect(settings.consentAt).toBeTruthy();
  const download = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Download full workspace' }).click();
  const copy = await download;
  expect(copy.suggestedFilename()).toBe('splitwise-ai-workspace.sqlite');
  const copyPath = await copy.path();
  expect((await readFile(copyPath!)).subarray(0, 15).toString()).toBe('SQLite format 3');
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole('heading', { name: 'Privacy & AI', exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/production-settings-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByLabel('Close dialog').click();
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await expect(dialog.getByLabel('Time zone', { exact: true })).toHaveValue('UTC');
  await page.screenshot({ path: 'test-results/production-settings.png', fullPage: true });
  await dialog.getByLabel('Close dialog').click();
  const person = await (
    await request.post('/api/people', {
      data: { name: 'Retry Person', handle: 'retry_person', relation: 'Synthetic' },
    })
  ).json();
  const body = {
    personId: person.id,
    date: '2026-01-01',
    amountCents: 500,
    direction: 'received',
    note: 'Synthetic retry test',
    requestId: crypto.randomUUID(),
  };
  expect((await request.post('/api/repayments', { data: body })).ok()).toBe(true);
  expect((await request.post('/api/repayments', { data: body })).ok()).toBe(true);
  const state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(state.repayments.filter((r) => r.personId === person.id)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('trips and modern review support suggested assignments, manual cash, receipts, settlement and archive', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const person = await (
    await request.post('/api/people', {
      data: { name: 'Jordan Trip', handle: 'jordan_trip', relation: 'Friend' },
    })
  ).json();
  const preview = await (
    await request.post('/api/imports/preview', {
      multipart: {
        accountId: 'amex',
        file: {
          name: 'trip-synthetic.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(
            'Date,Description,Amount\n04/01/2028,TRIP HOTEL,100.00\n04/02/2028,TRIP DINNER,60.00\n03/01/2028,EARLY FLIGHT,90.00',
          ),
        },
      },
    })
  ).json();
  await request.post('/api/imports/confirm', {
    data: { id: preview.id, acknowledgeSkips: false, keepRows: [], skipInvalid: false },
  });
  await page.goto('/?view=trips');
  await page.getByRole('button', { name: 'New trip', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Trip name', { exact: true }).fill('Yosemite 2028');
  await dialog.getByLabel('Destination', { exact: true }).fill('Yosemite');
  await dialog.getByLabel('Trip start').fill('2028-04-01');
  await dialog.getByLabel('Trip end').fill('2028-04-03');
  await dialog.getByRole('checkbox', { name: 'Jordan Trip', exact: true }).check();
  await dialog.getByRole('button', { name: 'Create trip', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Yosemite 2028', exact: true })).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Assign EARLY FLIGHT', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Select all trip suggestions' }).check();
  await page.getByRole('button', { name: 'Assign 2 selected', exact: true }).click();
  await expect(page.getByText('2 assigned expenses · 2 unfinished', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add manual expense', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Description', { exact: true }).fill('CASH MUSEUM');
  await dialog.getByLabel('Expense amount (USD)').fill('20.00');
  await dialog.getByLabel('Expense date', { exact: true }).fill('2028-04-02');
  await dialog.getByLabel('Expense notes').fill('Museum tickets I paid in cash.');
  await dialog.getByRole('button', { name: 'Add to Inbox', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review workspace', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Process Inbox', exact: true }).click();
  await confirmSplits(page);
  await expect
    .poll(async () => {
      const s = (await (await request.get('/api/state')).json()) as Snapshot;
      return s.transactions.filter((t) => t.tripId && t.state === 'ready').length;
    })
    .toBe(3);
  await expect(page.locator('.review-column.ready .transaction-card')).toHaveCount(3);
  await page.getByLabel('Select all Ready', { exact: true }).check();
  await page.getByRole('button', { name: 'Approve 3', exact: true }).click();
  let snapshot = (await (await request.get('/api/state')).json()) as Snapshot;
  const trip = snapshot.trips!.find((t) => t.name === 'Yosemite 2028')!;
  expect(trip.totalCents).toBe(18000);
  expect(snapshot.transactions.find((t) => t.description === 'EARLY FLIGHT')?.tripId).toBeNull();
  await page.getByRole('button', { name: 'Finalized', exact: true }).click();
  await page.getByLabel('Search transactions').fill('CASH MUSEUM');
  await page.getByRole('button', { name: 'View saved context', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Attach receipt').setInputFiles({
    name: 'museum.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\nSynthetic museum receipt\n%%EOF'),
  });
  await expect(dialog.getByRole('link', { name: /museum.pdf/ })).toBeVisible();
  const tx = snapshot.transactions.find((t) => t.description === 'CASH MUSEUM')!;
  let files = await (await request.get('/api/transaction-files/' + tx.id)).json();
  expect((await request.get('/api/attachments/' + files[0].id)).headers()['content-type']).toBe(
    'application/pdf',
  );
  await dialog.getByRole('button', { name: 'Remove receipt museum.pdf', exact: true }).click();
  await expect(dialog.getByRole('link', { name: /museum.pdf/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'View saved context', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('link', { name: /museum.pdf/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/modern-receipt-drawer.png', fullPage: false });
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await request.post('/api/repayments', {
    data: {
      personId: person.id,
      date: '2028-05-01',
      amountCents: 2500,
      direction: 'received',
      note: 'Synthetic',
      requestId: crypto.randomUUID(),
    },
  });
  const settlement = await request.get('/api/settlements/' + person.id + '?trip=' + trip.id);
  expect(await settlement.text()).toContain('$65.00');
  await page.goto('/?view=trips&trip=' + trip.id);
  await expect(page.getByRole('heading', { name: 'Yosemite 2028', exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export trip JSON', exact: true }).click();
  const bundle = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(bundle.transactions).toHaveLength(3);
  await page.getByRole('button', { name: 'Archive trip', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reopen trip', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/modern-trip.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/modern-trip-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('templates and saved views work with merchant aliases, refresh, Back, grouped instructions and new themes', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await request.post('/api/people', {
    data: { name: 'Morgan Template', handle: 'morgan_template', relation: 'Roommate' },
  });
  await page.goto('/?view=rules');
  await page.getByRole('button', { name: 'New template', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Template name').fill('Dinner with Morgan');
  await dialog.getByRole('checkbox', { name: 'Morgan Template', exact: true }).check();
  await dialog.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(page.getByText('Dinner with Morgan', { exact: true })).toBeVisible();
  await page.getByLabel('Statement contains', { exact: true }).fill('TST* MODERN CAFE');
  await page.getByLabel('Display as', { exact: true }).fill('Modern Cafe');
  await page.getByRole('button', { name: 'Save merchant name', exact: true }).click();
  const preview = await (
    await request.post('/api/imports/preview', {
      multipart: {
        accountId: 'amex',
        file: {
          name: 'template-synthetic.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(
            'Date,Description,Amount\n05/01/2028,TST* MODERN CAFE 003,20.00\n05/02/2028,TST* MODERN CAFE 003,40.00',
          ),
        },
      },
    })
  ).json();
  await request.post('/api/imports/confirm', {
    data: { id: preview.id, acknowledgeSkips: false, keepRows: [], skipInvalid: false },
  });
  await page.getByRole('button', { name: 'Review workspace', exact: true }).click();
  await page.getByLabel('Search transactions').fill('Modern Cafe');
  const card = page
    .locator('.transaction-card')
    .filter({ has: page.getByRole('heading', { name: 'Modern Cafe', exact: true }) });
  await expect(card).toHaveCount(1);
  await expect(card.getByText('See all 2 expenses', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('View name').fill('Cafe review');
  await dialog.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('Search transactions')).toHaveValue('Modern Cafe');
  await expect(page.getByRole('button', { name: 'Cafe review', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Split equally', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Use a template').selectOption({ label: 'Dinner with Morgan' });
  await dialog.getByRole('button', { name: 'Prepare 2 splits', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Approve 2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Review workspace', exact: true })).toBeVisible();
  await expect(page.getByLabel('Search transactions')).toHaveValue('Modern Cafe');
  await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: 'test-results/modern-review-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /Ready for review ·/ }).click();
  await expect(card.getByRole('button', { name: 'Approve 2', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/modern-review-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('assistant home creates trips and remembers scoped user facts directly from chat', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await request.post('/api/people', {
    data: { name: 'Sam Chat', handle: 'sam_chat', relation: 'Friend' },
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your AI workspace', exact: true })).toBeVisible();
  const panel = page.getByRole('complementary', { name: 'Split assistant' });
  await page.screenshot({ path: 'test-results/assistant-home-desktop.png', fullPage: true });
  await panel
    .getByLabel('Message the agent')
    .fill(
      'We went on a trip to Tahoe from 2029-01-01 to 2029-01-04 with @sam_chat. Split food equally.',
    );
  await panel.getByLabel('Message the agent').press('Enter');
  const tripCard = panel
    .locator('.assistant-change-card')
    .filter({ hasText: 'Created trip: Tahoe trip' });
  await expect(tripCard).toBeVisible({ timeout: 20000 });
  let state = (await (await request.get('/api/state')).json()) as Snapshot;
  const trip = state.trips!.find((t) => t.name === 'Tahoe trip')!;
  expect(trip.participants).toHaveLength(2);
  await tripCard.getByRole('button', { name: 'Open Created trip: Tahoe trip' }).click();
  await expect(page.getByRole('heading', { name: 'Tahoe trip', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await panel.getByLabel('Message the agent').fill('Remember that @sam_chat is my roommate.');
  await panel.getByLabel('Message the agent').press('Enter');
  await expect(
    panel.locator('.assistant-change-card').filter({ hasText: 'Remembered: About @sam_chat' }),
  ).toBeVisible({ timeout: 20000 });
  state = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(
    state.userContext!.find(
      (c) => c.personId === state.people.find((p) => p.handle === 'sam_chat')!.id,
    )?.text,
  ).toContain('roommate');
  await page.reload();
  await expect(
    panel.locator('.assistant-change-card').filter({ hasText: 'Created trip: Tahoe trip' }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/assistant-home-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Rules & context', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Saved user context', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Remember that @sam_chat is my roommate.', { exact: true }).first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('approve a generated split and finalize it directly in chat', async ({ page, request }) => {
  const created = await (
    await request.post('/api/transactions/manual', {
      data: {
        description: 'CHAT APPROVAL TICKETS',
        date: '2029-03-01',
        amountCents: 2000,
        category: 'Travel',
        note: '',
        tripId: null,
        requestId: crypto.randomUUID(),
      },
    })
  ).json();
  await page.goto('/?view=review');
  await page.getByLabel('Search transactions').fill('CHAT APPROVAL TICKETS');
  await page.getByLabel('Select CHAT APPROVAL TICKETS', { exact: true }).check();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Split assistant' });
  await panel.getByLabel('Message the agent').fill('Personal expense. Museum on my solo day.');
  await panel.getByLabel('Message the agent').press('Enter');
  await expect(
    panel.getByRole('button', { name: 'Confirm split changes', exact: true }).last(),
  ).toBeVisible({ timeout: 20000 });
  const before = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(before.transactions.find((t) => t.id === created.id)?.state).toBe('inbox');
  await confirmSplits(page, false);
  const card = panel
    .locator('.assistant-request-card')
    .filter({ hasText: 'CHAT APPROVAL TICKETS' })
    .last();
  await expect(card.getByRole('button', { name: 'Finalize 1 splits', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Finalize 1 splits', exact: true }).click();
  await expect(card.getByText('Finalized', { exact: true })).toBeVisible();
  expect(
    ((await (await request.get('/api/state')).json()) as Snapshot).transactions.find(
      (t) => t.id === created.id,
    )?.state,
  ).toBe('finalized');
  await page.screenshot({ path: 'test-results/chat-approval-card.png', fullPage: true });
});
