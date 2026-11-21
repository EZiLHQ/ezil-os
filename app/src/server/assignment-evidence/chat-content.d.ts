export type AssessmentChatContent =
    | { contentStatus: 'captured'; text: string }
    | { contentStatus: 'unavailable' | 'over_limit' | 'withheld' };
export function assessmentChatContent(value: unknown): AssessmentChatContent;
