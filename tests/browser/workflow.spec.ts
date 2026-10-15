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
