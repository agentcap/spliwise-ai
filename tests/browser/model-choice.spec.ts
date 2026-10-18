import { test, expect } from '@playwright/test';

test('fine-tuned AI model selection is saved and can be switched back', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const choice = dialog.getByRole('combobox', { name: 'AI model', exact: true });
  await choice.selectOption('gemma-v2');
  await expect(
    dialog.getByText(/This experimental model can misinterpret ambiguous requests/),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Preferences saved.' })).toBeVisible();
  expect((await (await page.request.get('/api/settings')).json()).aiModel).toBe('gemma-v2');
  await choice.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/fine-tuned-model-choice.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'AI model', exact: true })).toHaveValue(
    'gemma-v2',
  );
  await page.getByRole('combobox', { name: 'AI model', exact: true }).selectOption('hosted');
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByText('Preferences saved.', { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/settings')).json()).aiModel).toBe('hosted');
});
