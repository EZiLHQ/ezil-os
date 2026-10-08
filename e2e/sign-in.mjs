/** Submit only after React has attached the login form's event handlers. */
export async function signIn(page, { email, password, destination, now = Date.now } = {}) {
  if (!email || !password) throw new Error('Missing hosted sign-in credentials');
  const form = page.locator('#email-sign-in');
  const disclosure = page.locator('.ezil-lock-disclosure');
  // Server-rendered inputs are already editable before hydration. A completed
  // disclosure interaction proves the handler is ready, without a fixed sleep
  // or silently repeating an authentication request.
  const deadline = now() + 30000;
  const timeout = () => Math.max(1, Math.min(3000, deadline - now()));
  let expanded, toggled = false;
  // Clicks before hydration can be ignored. Retry until one visibly toggles.
  while (now() < deadline) {
    try {
      expanded = await disclosure.getAttribute('aria-expanded', { timeout: timeout() }) === 'true';
      await disclosure.click({ timeout: timeout() });
      await form.waitFor({ state: expanded ? 'hidden' : 'visible', timeout: timeout() });
      toggled = true;
      break;
    } catch {}
  }
  if (!toggled) throw new Error('Hosted sign-in form did not hydrate');
  if (expanded) {
    await disclosure.click();
    await form.waitFor({ state: 'visible', timeout: 15000 });
  }
  // Opening the form focuses Email on the next animation frame. Wait for that
  // focus before filling Password; otherwise a fast mobile driver can insert
  // the password into Email when that deferred focus lands.
  await page.waitForFunction(() => document.activeElement === document.querySelector('#email'), null, { timeout: 15000 });
  await page.fill('#email', email);
  await page.fill('#password', password);
  try {
    await Promise.all([
      // The destination can start cloud requests while its document loads.
      // Each suite checks application readiness after navigation commits.
      page.waitForURL(url => destination ? url.pathname === destination : !url.pathname.startsWith('/login'), { waitUntil: 'commit', timeout: 60000 }),
      form.locator('button[type=submit]').click(),
    ]);
  } catch {
    // Driver call logs may include entered credentials and session headers.
    throw new Error('Hosted sign-in did not reach its destination');
  }
}
