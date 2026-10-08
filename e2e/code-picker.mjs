export async function openQuickInput(frame, { attempts = 3, timeout = 10000 } = {}) {
  const input = frame.locator('.quick-input-widget input:visible');
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await input.isVisible()) return input;
    try {
      await frame.locator('.command-center').click({ timeout });
      await input.waitFor({ state: 'visible', timeout });
      return input;
    } catch {
      await frame.locator('body').press('Escape');
    }
  }
  throw new Error('Code quick input did not open');
}
