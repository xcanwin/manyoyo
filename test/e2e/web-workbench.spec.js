const { test, expect } = require('playwright/test');

test('authenticated workbench has a responsive three-column layout and persisted theme', async ({ page }) => {
    await page.goto('/auth/login');
    await page.getByRole('textbox', { name: '用户名' }).fill('webadmin');
    await page.getByRole('textbox', { name: '密码' }).fill('topsecret');
    await page.getByRole('button', { name: '登录' }).click();

    await expect(page).toHaveURL('/');
    await expect(page.getByRole('complementary', { name: '会话' })).toBeVisible();
    await expect(page.getByRole('region', { name: '活动流' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: '工作区' })).toBeVisible();
    await page.getByRole('button', { name: 'config' }).click();
    await expect(page.locator('.cm-editor')).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.getByRole('button', { name: '深色' }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('manyoyo-theme'))).toBe('dark');
    await page.getByRole('button', { name: 'EN' }).click();
    await expect(page.getByRole('button', { name: 'New' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Configuration' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('manyoyo-locale'))).toBe('en');
    await page.reload();
    await expect(page.getByRole('button', { name: 'New' })).toBeVisible();
    await page.keyboard.press('Control+N');
    await expect(page.getByRole('dialog', { name: 'New container' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
