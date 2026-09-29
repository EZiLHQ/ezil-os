'use strict';
const { exact } = require('./policy.cjs');
const { safeAlias, CLIENT_CAPS, failure } = require('./works-session.cjs');

function responsesRequest(body, model) {
  try {
    exact(body, ['model', 'messages', 'maxTokens']);
    if (!model || !safeAlias(body.model) || body.model !== model.id || !Number.isInteger(body.maxTokens) || body.maxTokens < (model.minOutputTokens ?? 1) || body.maxTokens > Math.min(model.maxOutputTokens, CLIENT_CAPS.maxOutputTokens)
      || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 100) throw failure('request_invalid');
    const input = body.messages.map(message => {
      exact(message, ['role', 'content']);
      if (!['user', 'assistant', 'system'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 32000) throw failure('request_invalid');
      return { role: message.role, content: message.content };
    });
    // Same conservative byte/framing bound used by the gateway validator.
    if (Buffer.byteLength(JSON.stringify({ input })) + 1024 + 32 * input.length > model.maxInputTokens) throw failure('input_too_large');
    return { model: model.id, input, max_output_tokens: body.maxTokens, stream: true, store: false };
  } catch (error) { throw error?.code === 'input_too_large' ? error : failure('request_invalid'); }
}
const frame = value => `data: ${JSON.stringify(value)}\n\n`;

// Translate only text. Provider errors, IDs, accounting data and payloads never
// leave main. Completion is accepted only after a valid terminal event AND EOF.
async function translateResponses(body, write, { signal, maxBytes = 8 * 1024 * 1024, maxFrameBytes = 1024 * 1024, onBytes = () => {} } = {}) {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', total = 0, terminal = false, emittedText = '';
  async function event(raw) {
    if (Buffer.byteLength(raw) > maxFrameBytes) throw failure('stream_invalid');
    let name = ''; const data = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    // Responses terminal events are mandatory; [DONE] cannot substitute for one.
    if (terminal) throw failure('stream_invalid');
    let value; try { value = JSON.parse(data.join('\n')); } catch { throw failure('stream_invalid'); }
    if (!value || typeof value.type !== 'string' || (name && name !== value.type)) throw failure('stream_invalid');
    const type = value.type;
    if (type === 'error' || type === 'response.failed' || type === 'response.cancelled') throw failure('incomplete');
    if (type === 'response.incomplete') throw failure(value.response?.incomplete_details?.reason === 'content_filter' ? 'refused' : 'incomplete');
    if (type.startsWith('response.refusal.')) throw failure('refused');
    if (type === 'response.output_text.delta') {
      if (typeof value.delta !== 'string') throw failure('stream_invalid');
      emittedText += value.delta;
      if (value.delta) await write(frame({ choices: [{ delta: { content: value.delta } }] }));
    } else if (type === 'response.completed') {
      const response = value.response;
      if (!response || response.status !== 'completed' || response.error || !Array.isArray(response.output)) throw failure('stream_invalid');
      let completedText = '';
      for (const item of response.output) {
        if (item?.type === 'reasoning') continue;
        if (item?.type !== 'message' || !Array.isArray(item.content)) throw failure('stream_invalid');
        for (const part of item.content) {
          if (part?.type === 'refusal') throw failure('refused');
          if (part?.type !== 'output_text' || typeof part.text !== 'string') throw failure('stream_invalid');
          completedText += part.text;
        }
      }
      if (completedText !== emittedText) throw failure('stream_invalid');
      terminal = true;
    } else if (!['response.created', 'response.in_progress', 'response.queued', 'response.output_item.added', 'response.output_item.done', 'response.content_part.added', 'response.content_part.done', 'response.output_text.done',
      'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_text.delta', 'response.reasoning_text.done'].includes(type)) throw failure('stream_invalid');
  }
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (value) { total += value.byteLength; if (total > maxBytes) throw failure('stream_invalid'); onBytes(value.byteLength); }
      buffer += decoder.decode(value, { stream: !done });
      // Normalize CRLF and lone CR, preserving a CR split across network chunks.
      buffer = buffer.replace(/\r\n/g, '\n').replace(done ? /\r/g : /\r(?!$)/g, '\n');
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) { await event(buffer.slice(0, split)); buffer = buffer.slice(split + 2); }
      if (Buffer.byteLength(buffer) > maxFrameBytes) throw failure('stream_invalid');
      if (done) break;
    }
    if (buffer.trim() || !terminal) throw failure('stream_invalid');
    await write('data: [DONE]\n\n');
  } catch (error) { if (['incomplete', 'refused', 'stream_invalid'].includes(error?.code)) throw error; throw failure('stream_invalid'); }
  finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
module.exports = { responsesRequest, translateResponses, frame };
