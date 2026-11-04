// Automatic context compaction for EZiL Gateway requests. Copilot keeps the whole conversation in its saved chat session
// and resends all of it on every turn. When that no longer fits the model's input limit, this shapes a COPY of the request
// that does, and the same chat continues. The saved conversation is never changed, so a model with a larger limit still
// gets everything. Local and deterministic: no model call, nothing sent, and the same conversation always compacts the
// same way. Every shortening is marked in the text the model reads.
//
// Kept verbatim, in order of priority:
// - every system message, the current user message (the last one with typed text) and the latest assistant step with its
//   tool results; only one oversized tool output there may be shortened, and then as head and tail with a marker;
// - complete tool call/result groups: no cut ever separates a call from its result.
// Folded into a marked note, oldest first: earlier user messages (long ones shortened, the <userRequest> text first) and a
// one-line record of each earlier reply and tool call.
import { LocalRequestError, type LocalRequestCode } from './gateway-messages';
import { isCacheMarker, isStatefulMarker, type ChatRequest, type Message, type Part } from './types';

/** A compacted request is shaped to this share of the input limit, so the next turns do not refuse at once. */
export const COMPACT_TARGET = 0.8;

/** Sizes and counts only, never content. */
export type CompactionInfo = {
    /** What the request as Copilot sent it hit: a local bound, or a Gateway or OS refusal of its size (`remote`). */
    cause: LocalRequestCode | 'remote';
    /** Size as the protocol's bound counted it and that bound; then the compacted wire body. */
    fromBytes: number; limitBytes: number; toBytes: number;
    /** Earlier messages folded into the note, and tool outputs or replies shortened in place. */
    folded: number; shortened: number;
};

type NoteDetail = { user: number; line: number; lines: boolean } | 'minimal';
type Plan = { histResult?: number; histReply?: number; stepResult?: number; lastResult?: number; fold?: 'search' | 'all'; note?: NoteDetail };

// Cheapest first: shorten old tool output, then old replies, then fold the oldest messages, and only then cut the latest
// tool output below 32 KB. The last plans keep little more than the instructions and the current request.
const PLANS: readonly Plan[] = [
    { histResult: 4096 },
    { histResult: 1024, histReply: 4096, stepResult: 4096 },
    { histResult: 1024, histReply: 4096, stepResult: 4096, lastResult: 32_768 },
    { histResult: 1024, histReply: 4096, stepResult: 4096, lastResult: 32_768, fold: 'search', note: { user: 4096, line: 300, lines: true } },
    { histResult: 1024, histReply: 4096, stepResult: 4096, lastResult: 8192, fold: 'search', note: { user: 2048, line: 200, lines: true } },
    { lastResult: 2048, fold: 'all', note: { user: 1024, line: 120, lines: true } },
    { lastResult: 1024, fold: 'all', note: { user: 256, line: 0, lines: false } },
    { lastResult: 512, fold: 'all', note: 'minimal' },
];

const LIMIT_NOTE = "to fit the model's input limit";

/** Head and tail of `text` within `cap` characters, with a marker saying how much was left out. */
export function shorten(text: string, cap: number): string {
    if (text.length <= cap) return text;
    let head = text.slice(0, Math.ceil(cap * 0.7));
    let tail = text.slice(text.length - (cap - head.length));
    if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
    if (/^[\udc00-\udfff]/.test(tail)) tail = tail.slice(1);
    return `${head}\n[… ${text.length - head.length - tail.length} characters left out by EZiL ${LIMIT_NOTE} …]\n${tail}`;
}

/** A user message keeps what the user asked (Copilot's <userRequest>) before its attached context. */
function shortenUser(text: string, cap: number): string {
    if (text.length <= cap) return text;
    const asked = [...text.matchAll(/<userRequest>([\s\S]*?)<\/userRequest>/g)].map(match => match[1]!.trim()).filter(Boolean).join('\n');
    if (asked && asked.length <= cap) return `${asked}\n[… ${text.length - asked.length} characters of attached context left out by EZiL ${LIMIT_NOTE} …]`;
    return shorten(text, cap);
}

const isMarker = (part: Part) => isCacheMarker(part) || isStatefulMarker(part);

function dataText(part: Extract<Part, { type: 'data' }>): string {
    if (part.mimeType.startsWith('text/')) return Buffer.from(part.data).toString('utf8');
    return part.mimeType.startsWith('image/') ? '[image]' : '[file]';
}

function partText(part: Part): string {
    if (part.type === 'text') return part.value;
    if (part.type === 'data') return isMarker(part) ? '' : dataText(part);
    if (part.type === 'tool_result') return part.content.map(partText).filter(Boolean).join('\n');
    return '';
}

/** A user message with something the user typed or attached, not only tool results. */
function typed(message: Message): boolean {
    return message.role === 'user' && message.parts.some(part => (part.type === 'text' && part.value.trim() !== '') || (part.type === 'data' && !isMarker(part)));
}

/**
 * Each tool result with the call it answers: the nearest earlier call with its id that has no result yet, so an id used
 * again later pairs with its own call, not the first one (Copilot ids are not guaranteed unique).
 */
function pairCalls(messages: readonly Message[]): { result: Map<Part, { part: Extract<Part, { type: 'tool_result' }>; at: number }>; spans: [number, number][] } {
    const waiting = new Map<string, { part: Part; at: number }[]>();
    const result = new Map<Part, { part: Extract<Part, { type: 'tool_result' }>; at: number }>();
    const spans: [number, number][] = [];
    messages.forEach((message, index) => {
        for (const part of message.parts) {
            if (part.type === 'tool_call') waiting.set(part.callId, [...waiting.get(part.callId) ?? [], { part, at: index }]);
            else if (part.type === 'tool_result') {
                const call = waiting.get(part.callId)?.pop();
                if (!call) continue;
                result.set(call.part, { part, at: index });
                if (call.at < index) spans.push([call.at, index]);
            }
        }
    });
    return { result, spans };
}

/** `open[i]` is true when a tool call before message i has its result at i or later: no cut may go there. */
function openCalls(messages: readonly Message[]): boolean[] {
    const delta = new Array<number>(messages.length + 2).fill(0);
    for (const [call, answer] of pairCalls(messages).spans) { delta[call + 1]!++; delta[answer + 1]!--; }
    let depth = 0;
    return Array.from({ length: messages.length + 1 }, (_, index) => (depth += delta[index]!) > 0);
}

type Shape = {
    /** Messages before the protected part, as units (each starts at a safe cut). */
    history: Message[][];
    /** The current user message and anything before or after it that a cut may not separate from it. */
    current: Message[];
    /** Assistant steps after the current user message; the last one is always kept. */
    steps: Message[][];
};

function splitUnits(messages: readonly Message[], from: number, to: number, open: boolean[], startsUnit: (message: Message) => boolean): Message[][] {
    const units: Message[][] = [];
    for (let index = from; index < to; index++) {
        const message = messages[index]!;
        if (!units.length || (!open[index] && message.role !== 'system' && startsUnit(message))) units.push([]);
        units.at(-1)!.push(message);
    }
    return units;
}

function shape(messages: readonly Message[]): Shape {
    const open = openCalls(messages);
    const lastIndex = (test: (message: Message) => boolean) => { for (let index = messages.length - 1; index >= 0; index--) if (test(messages[index]!)) return index; return -1; };
    let current = lastIndex(typed);
    if (current < 0) current = lastIndex(message => message.role === 'user');
    if (current < 0) return { history: [], current: [], steps: messages.length ? [messages.slice()] : [] };
    // Widen the current message both ways until no call/result pair crosses either edge.
    let start = current;
    while (start > 0 && open[start]) start--;
    let end = current + 1;
    while (end < messages.length && open[end]) end++;
    return {
        history: splitUnits(messages, 0, start, open, message => message.role === 'assistant' || typed(message)),
        current: messages.slice(start, end),
        // The current request's own tool steps: a new unit at each assistant message that no pair crosses.
        steps: splitUnits(messages, end, messages.length, open, message => message.role === 'assistant'),
    };
}

function capResults(message: Message, cap: number | undefined, count: () => void): Message {
    if (cap === undefined || !message.parts.some(part => part.type === 'tool_result')) return message;
    return { ...message, parts: message.parts.map(part => {
        if (part.type !== 'tool_result') return part;
        const text = partText(part);
        if (text.length <= cap) return part;
        count();
        return { ...part, content: [{ type: 'text', value: shorten(text, cap) }] };
    }) };
}

function capReplies(message: Message, cap: number | undefined, count: () => void): Message {
    if (cap === undefined || message.role !== 'assistant') return message;
    return { ...message, parts: message.parts.map(part => {
        if (part.type !== 'text' || part.value.length <= cap) return part;
        count();
        return { ...part, value: shorten(part.value, cap) };
    }) };
}

function argumentsText(input: unknown): string {
    try { return JSON.stringify(input ?? {}) ?? '{}'; } catch { return '{…}'; }
}

function noteFor(messages: readonly Message[], detail: NoteDetail, steps: boolean): Message {
    const lines: string[] = [];
    const counted = messages.filter(message => message.role !== 'system').length;
    const what = steps ? `${counted} earlier messages of this task` : `${counted} earlier messages`;
    if (detail === 'minimal') {
        lines.push(`[EZiL left out ${what} ${LIMIT_NOTE}. The full conversation is still saved in this chat.]`);
    } else {
        lines.push(`[EZiL compacted ${what} ${LIMIT_NOTE}. The full conversation is still saved in this chat. `
            + `Earlier user messages are kept below (long ones shortened)${detail.lines ? ', with a short record of the replies and tool calls' : ''}.]`);
        const results = pairCalls(messages).result;
        let left = 0;
        for (const message of messages) {
            if (message.role === 'user') {
                const value = message.parts.filter(part => part.type !== 'tool_result').map(partText).filter(Boolean).join('\n');
                if (value.trim()) lines.push(`User: ${shortenUser(value, detail.user)}`);
            } else if (message.role === 'assistant') {
                for (const part of message.parts) {
                    if (!detail.lines) { if (part.type === 'text' || part.type === 'tool_call') left++; continue; }
                    if (part.type === 'text' && part.value.trim()) lines.push(`Assistant: ${shorten(part.value.trim(), detail.line * 2)}`);
                    else if (part.type === 'tool_call') {
                        const result = results.get(part)?.part;
                        const input = shorten(argumentsText(part.input), Math.max(40, detail.line / 2));
                        lines.push(`Tool ${part.name} ${input} → ${result ? `${result.isError === true ? '(error) ' : ''}${shorten(partText(result).trim() || '(no output)', detail.line)}` : '(no result recorded)'}`);
                    }
                }
            }
        }
        if (left) lines.push(`(${left} earlier replies and tool calls left out.)`);
        lines.push('[End of the compacted part.]');
    }
    return { role: 'user', parts: [{ type: 'text', value: lines.join('\n') }] };
}

/** One candidate: the plan applied with the first `fold` foldable units (history first, then the current task's steps). */
function assemble(parts: Shape, plan: Plan, fold: number, counts: { folded: number; shortened: number }): Message[] {
    const count = () => { counts.shortened++; };
    const out: Message[] = [];
    const foldedHistory = Math.min(fold, parts.history.length);
    const foldedSteps = Math.max(0, Math.min(fold - parts.history.length, parts.steps.length - 1));
    // System messages stay (before the note); a note only stands for messages it replaces.
    const replace = (units: Message[][], steps: boolean) => {
        const messages = units.flat();
        out.push(...messages.filter(message => message.role === 'system'));
        const replaced = messages.filter(message => message.role !== 'system').length;
        counts.folded += replaced;
        if (replaced) out.push(noteFor(messages, plan.note ?? 'minimal', steps));
    };
    if (foldedHistory) replace(parts.history.slice(0, foldedHistory), false);
    for (const message of parts.history.slice(foldedHistory).flat()) out.push(capReplies(capResults(message, plan.histResult, count), plan.histReply, count));
    for (const message of parts.current) out.push(capResults(message, plan.histResult, count));
    if (foldedSteps) replace(parts.steps.slice(0, foldedSteps), true);
    parts.steps.slice(foldedSteps).forEach((unit, index, kept) => {
        const cap = index === kept.length - 1 ? plan.lastResult : plan.stepResult ?? plan.lastResult;
        for (const message of unit) out.push(capResults(message, cap, count));
    });
    return out;
}

type Built = { bytes: Uint8Array };

/**
 * Compacts `request`, which `first` says does not fit, into a copy that `build` accepts at COMPACT_TARGET of the limit
 * (else at the full limit). `build(request, scale)` is the protocol's own builder with the input limit scaled, so every
 * bound it checks (bytes, messages, blocks, items) is measured exactly as for sending. Throws a LocalRequestError marked
 * `afterCompaction` when even the last plan does not fit; any other builder error is passed on.
 */
export function compactRequest<B extends Built>(request: ChatRequest, first: LocalRequestError, build: (request: ChatRequest, scale: number) => B,
    cause: CompactionInfo['cause'] = first.code): { request: ChatRequest; built: B; info: CompactionInfo } {
    const parts = shape(request.messages);
    const foldable = parts.history.length + Math.max(0, parts.steps.length - 1);
    let last: LocalRequestError = first;
    const attempt = (plan: Plan, fold: number, scale: number) => {
        const counts = { folded: 0, shortened: 0 };
        const candidate: ChatRequest = { ...request, messages: assemble(parts, plan, fold, counts) };
        try {
            const built = build(candidate, scale);
            return { request: candidate, built: scale === 1 ? built : build(candidate, 1), counts };
        } catch (error) {
            if (!(error instanceof LocalRequestError)) throw error;
            last = error;
            return undefined;
        }
    };
    for (const scale of [COMPACT_TARGET, 1]) {
        for (const plan of PLANS) {
            let found: ReturnType<typeof attempt>;
            if (!plan.fold || !foldable) found = attempt(plan, 0, scale);
            else {
                const all = attempt(plan, foldable, scale);
                if (all && plan.fold === 'search') {
                    // The fewest folded units that fit; folding more makes the request smaller, so a binary search works.
                    let low = 1, high = foldable, best = all;
                    while (low < high) {
                        const middle = Math.floor((low + high) / 2);
                        const fits = attempt(plan, middle, scale);
                        if (fits) { best = fits; high = middle; } else low = middle + 1;
                    }
                    found = best;
                } else found = all;
            }
            if (found) {
                const fromBytes = first.counts.bodyBytes;
                return { request: found.request, built: found.built, info: { cause, fromBytes, toBytes: found.built.bytes.byteLength,
                    limitBytes: first.counts.limitBytes, folded: found.counts.folded, shortened: found.counts.shortened } };
            }
        }
    }
    throw new LocalRequestError(last.code, last.counts, true);
}
