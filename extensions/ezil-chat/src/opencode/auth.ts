// Basic-auth header shared by the server manager (health checks) and the v2 client. No SDK import.
export function basicAuthHeader(username: string, password: string): string {
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}
