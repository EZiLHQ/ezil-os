/** Submit only after React has attached the login form's event handlers. */
export async function signIn(page, { email, password, destination } = {}) {
  if (!email || !password) throw new Error('Missing hosted sign-in credentials');
  const form = page.locator('#email-sign-in');
  const disclosure = page.locator('.ezil-lock-disclosure');
  // Server-rendered inputs are already editable before hydration. A completed
  // disclosure interaction proves the handler is ready, without a fixed sleep
  // or silently repeating an authentication request.
  const expanded = await disclosure.getAttribute('aria-expanded') === 'true';
  await disclosure.click();
  await form.waitFor({ state: expanded ? 'hidden' : 'visible', timeout: 15000 });
  if (expanded) {
    await disclosure.click();
    await form.waitFor({ state: 'visible', timeout: 15000 });
  }
  await page.fill('#email', email);
  await page.fill('#password', password);
  try {
    await Promise.all([
      page.waitForURL(url => destination ? url.pathname === destination : !url.pathname.startsWith('/login'), { timeout: 60000 }),
      form.locator('button[type=submit]').click(),
    ]);
  } catch {
    // Driver call logs may include entered credentials and session headers.
    throw new Error('Hosted sign-in did not reach its destination');
  }
}
