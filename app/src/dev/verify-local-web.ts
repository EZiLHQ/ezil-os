import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { checkDevelopmentEnvironment, ENV_HEADER } from './environment';
import { localAccounts, LocalWebError, readPrivateFile, writePrivateFileOnce } from './local-supabase';

/** Real local HTTP acceptance after both accounts have signed in through the UI. */
export async function verifyLocalWeb(appDirectory: string): Promise<void> {
    if (!(await readPrivateFile(path.join(appDirectory, '.env.local')))?.startsWith(ENV_HEADER)
        || checkDevelopmentEnvironment(process.env, true).length) {
        throw new LocalWebError('local_verify: requires the dedicated local setup');
    }
    const accountsFile = path.join(appDirectory, '.local-web', 'accounts.json');
    if (await readPrivateFile(accountsFile) === null) throw new LocalWebError('accounts.json: run dev:setup first');
    const accounts = await localAccounts(accountsFile);
    const require = (condition: unknown, code: string): void => {
        if (!condition) throw new LocalWebError(`local_verify: ${code}`);
    };
    const request = (route: string, token?: string, method = 'GET') => fetch(`http://127.0.0.1:3000${route}`, {
        method, headers: token ? { authorization: `Bearer ${token}` } : {},
        redirect: 'manual', signal: AbortSignal.timeout(30_000),
    });
    const signedOut = await request('/os');
    require(signedOut.status === 307 && signedOut.headers.get('location')?.includes('/login'), 'anonymous_os_not_redirected');
    await signedOut.body?.cancel();
    const anonymous = await request('/api/shell/session');
    require(anonymous.status === 401, 'anonymous_api_not_denied');
    await anonymous.body?.cancel();
    const users = [];
    const clients = [];
    try {
        for (const account of accounts) {
            const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
                auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
                global: { fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }) },
            });
            clients.push(client);
            const login = await client.auth.signInWithPassword(account);
            require(!login.error && login.data.session, 'password_login_failed');
            const token = login.data.session!.access_token;
            const sessionResponse = await request('/api/shell/session', token);
            require(sessionResponse.ok, 'session_query_failed');
            const session = await sessionResponse.json();
            require(session.user?.id === login.data.user?.id, 'session_identity_mismatch');
            require(typeof session.computer?.id === 'string', 'sign_in_both_accounts_through_the_web_form_first');
            require(session.desktopState?.configured === false, 'cloud_provider_must_be_unconfigured');
            const listResponse = await request('/api/trpc/computer.list', token);
            require(listResponse.ok, 'computer_list_failed');
            const list = (await listResponse.json()).result?.data?.json;
            require(Array.isArray(list) && list.length === 1 && list[0].id === session.computer.id, 'expected_one_owned_computer');
            const repeated = await Promise.all([request('/api/shell/session', token, 'POST'), request('/api/shell/session', token, 'POST')]);
            for (const response of repeated) {
                require(response.ok && (await response.json()).computer?.id === session.computer.id, 'repeat_boot_changed_computer');
            }
            users.push({ userId: session.user.id as string, computerId: session.computer.id as string, token });
        }
        require(users[0].userId !== users[1].userId && users[0].computerId !== users[1].computerId, 'two_user_isolation_failed');
        for (const [index, user] of users.entries()) {
            for (const [target, expected] of [[user.computerId, 200], [users[1 - index].computerId, 404]] as const) {
                const input = encodeURIComponent(JSON.stringify({ json: { id: target } }));
                const response = await request(`/api/trpc/computer.get?input=${input}`, user.token);
                require(response.status === expected, 'computer_ownership_check_failed');
                await response.body?.cancel();
            }
        }
        // Future runs (including after stop/start) must recover these same computers.
        await writePrivateFileOnce(path.join(appDirectory, '.local-web', 'verified-computers.json'),
            JSON.stringify(users.map(({ userId, computerId }) => ({ userId, computerId })), null, 2) + '\n');
        console.log('Local HTTP acceptance: PASS — real logins, anonymous denial, two owned computers, repeat boot, cross-user denial, stable saved identities.');
    } finally {
        for (const client of clients) await client.auth.signOut({ scope: 'local' });
    }
}
