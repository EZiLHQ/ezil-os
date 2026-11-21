# Unattended Code on staging

On an eligible Cloudflare computer, the owner can enable both `ezil.chatBridge.enabled` and `ezil.chatBridge.unattended` in the Code user settings. Both default to false. The desktop watches the restored machine preferences and starts the private workbench when both are true and the Worker issued the computer an editor credential for this boot. Switching either preference off closes the private workbench. The user's Code app and terminal keep running.

The private workbench uses the packaged browser, a separate ephemeral profile, and Code's existing loopback port 8443. Its browser process runs as an unprivileged user with no display, inherited bearer credentials or debugging port. The ordinary Code extension and EZiL Gateway handle the chat, model choice, quota and tool approvals. This path generates no synthetic user prompt or human presence signal.

A current, signed protocol-2 lease with an owner ID beginning with `unattended.` and a fresh allowed model catalog indicate that the private editor is ready. An ordinary Code window can take over an idle private lease. An ongoing request keeps its existing owner through completion. After a real restart or lease loss, the existing OS rules record an uncertain outcome for any work already delivered and prevent duplicate execution. Saved chat history uses the same workspace store as the Code app.

MCP OAuth authorizes calls to Code. The account's AI credential currently comes from a first-party signed-in desktop or Code open. If that credential expires, the owner must reauthenticate through the normal app link. Starting a computer alone does not renew this credential. The one-time unattended preference can be set through Code settings or the owner's existing OS terminal. The hosted MCP has no preference-write tool.

## Verification

The isolated packaged suite runs with `EZIL_E2E_SUITE=unattended` and takes the desktop image as its only positional argument. It keeps all user Code tabs closed, waits for a private lease, launches two model requests and requires separate exact replies, request IDs and overlap at the model.

With the additional owner preference `ezil.chatBridge.qaReceipts` enabled, the private staging executor writes one local EZiL Models log line per completed foreground Gateway request. The payload contains the operation ID, editor request ID, conversation fingerprint and upstream Gateway request ID. The signed acceptance runner filters by its exact operation IDs. The preference defaults to false.
