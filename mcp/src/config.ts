/**
 * Configuration, resolved once at startup and fail-closed.
 *
 * A stdio MCP server has nowhere good to report a misconfiguration once it is
 * running — a tool error is seen by the model, not the person who wrote the
 * config file. So everything is checked before the transport connects, and a
 * bad config exits non-zero with a message on stderr, where the host will
 * actually surface it.
 */
export interface Config {
    baseUrl: string;
    token: string;
    timeoutMs: number;
}

export class ConfigError extends Error {}

const DEFAULT_TIMEOUT_MS = 300_000;

export const readConfig = (env: Record<string, string | undefined>): Config => {
    const baseUrl = env.EZIL_API_URL?.trim();
    const token = env.EZIL_TOKEN?.trim();

    if (!baseUrl) {
        throw new ConfigError(
            'EZIL_API_URL is not set. Point it at your EZiL-OS deployment, e.g. https://ezil-os.example.',
        );
    }
    try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
            throw new ConfigError(
                `EZIL_API_URL must be https (got ${parsed.protocol}//). A bearer token over plaintext is a leaked token.`,
            );
        }
    } catch (err) {
        if (err instanceof ConfigError) throw err;
        throw new ConfigError(`EZIL_API_URL is not a valid URL: ${baseUrl}`);
    }

    if (!token) {
        throw new ConfigError(
            'EZIL_TOKEN is not set. It must be a Supabase access token for the user this server acts as. '
                + 'It is NOT the Worker\'s SANDBOX_HMAC_SECRET, which must never be used here.',
        );
    }

    const raw = env.EZIL_TIMEOUT_MS?.trim();
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (raw) {
        const n = Number(raw);
        // A cold container boot is ~22s and can be much worse. A too-short
        // timeout turns a slow boot into a phantom failure the model then
        // retries, booting it again.
        if (!Number.isFinite(n) || n < 1000) {
            throw new ConfigError(`EZIL_TIMEOUT_MS must be a number of milliseconds >= 1000 (got ${raw}).`);
        }
        timeoutMs = n;
    }

    return { baseUrl, token, timeoutMs };
};
