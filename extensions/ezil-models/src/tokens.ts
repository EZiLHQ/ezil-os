// Local token estimate. Deliberately cheap: VS Code calls provideTokenCount for every prompt part while
// budgeting against maxInputTokens, and a network round trip (Anthropic count_tokens) per call would be
// far too slow. The estimate is calibrated to over-count slightly (chars / 3.4 instead of the usual
// chars / 4) because the Opus 4.7+ tokenizer used by current Claude models produces ~1.0-1.35x the tokens
// of older Claude models; under-counting would let prompts overflow the context window.

import type { Message, Part } from './types';

const CHARS_PER_TOKEN = 3.4;
const IMAGE_TOKENS = 1600; // ~1.15 MP image at (w*h)/750
const MESSAGE_OVERHEAD = 4;

export function estimateTextTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimatePartTokens(part: Part): number {
    switch (part.type) {
        case 'text': return estimateTextTokens(part.value);
        case 'thinking': return estimateTextTokens(part.value) + estimateTextTokens(String(part.metadata?._completeThinking ?? ''));
        case 'tool_call': return estimateTextTokens(part.name) + estimateTextTokens(JSON.stringify(part.input ?? {})) + 8;
        case 'tool_result': return part.content.reduce((sum, inner) => sum + estimatePartTokens(inner), 8);
        case 'data':
            if (part.mimeType.startsWith('image/')) return IMAGE_TOKENS;
            if (part.mimeType.startsWith('text/')) return estimateTextTokens(Buffer.from(part.data).toString('utf8'));
            if (part.mimeType === 'application/pdf') return Math.ceil(part.data.byteLength / 3);
            return 0; // cache_control / stateful markers
    }
}

export function estimateMessageTokens(message: Message): number {
    return message.parts.reduce((sum, part) => sum + estimatePartTokens(part), MESSAGE_OVERHEAD);
}
