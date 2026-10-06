/** Keep both ends alive across the Durable Object HTTP boundary. */
export function pipeCodeSockets(client: WebSocket, upstream: WebSocket, activity: () => void): void {
  upstream.accept();
  client.accept();
  for (const [from, to] of [[client, upstream], [upstream, client]]) {
    from.addEventListener('message', async event => {
      activity();
      try { to.send(event.data instanceof Blob ? await event.data.arrayBuffer() : event.data); }
      catch { from.close(1011, 'Code connection failed'); }
    });
    from.addEventListener('close', event => {
      const code = event.code === 1005 || event.code === 1006 ? 1000 : event.code;
      try { to.close(code, event.reason); } catch { /* already closed */ }
    });
    from.addEventListener('error', () => {
      try { to.close(1011, 'Code connection failed'); } catch { /* already closed */ }
    });
  }
}

export function bridgeCodeSocket(response: Response, activity: () => void): Response {
  if (!response.webSocket) return response;
  const pair = new WebSocketPair();
  pipeCodeSockets(pair[1], response.webSocket, activity);
  return new Response(null, { status: response.status, headers: response.headers, webSocket: pair[0] });
}
