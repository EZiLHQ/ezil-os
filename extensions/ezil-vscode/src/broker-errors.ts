const messages: Record<string, string> = {
    signin_required: 'Sign in to Works again in native Settings.',
    builder_required: 'Sign in with an onboarded Works builder account.',
    membership_required: 'Ask Works support to enable your AI membership.',
    credits: 'Not enough Works credits for this request. Check your credit balance in Works.',
    budget: 'The AI budget limit has been reached. Check the budget in Works before submitting again.',
    key_revoked: 'The AI key was revoked. Reconnect your account in Works before submitting again.',
    replay: 'This request was already submitted. Check Works usage before starting another request.',
    pending_usage: 'AI usage needs reconciliation. Contact Works support before sending another request.',
    paused: 'The EZiL AI gateway is paused. Try again after service resumes.',
    model_unavailable: 'This EZiL model is disabled or unavailable. Refresh the model list.',
    request_invalid: 'Use text messages and an output limit within the selected model allowance.',
    input_too_large: 'Shorten the conversation to fit the selected model allowance.',
    rate_limited: 'Too many requests. Wait for current requests to finish.',
    refused: 'The model refused this request. Revise the request before submitting again.',
    incomplete: 'The response is incomplete. Check Works usage before sending another request.',
    stream_invalid: 'The response stream was interrupted or invalid. Check Works usage before sending another request.',
    gateway_unavailable: 'The EZiL gateway is unavailable. No retry was attempted; check Works usage before resubmitting.',
    auth_unavailable: 'Works sign-in is unavailable. Check the Works service configuration.',
    timeout: 'The request timed out. Check Works usage before sending another request.',
};
// Never surface exception text, provider response bodies or reflected tokens.
export function brokerError(code: unknown, retryAfter?: string | null): Error {
    const suffix = retryAfter && (/^[0-9]{1,8}$/.test(retryAfter) || /^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(retryAfter)) ? ` Retry after ${retryAfter}${/^\d+$/.test(retryAfter) ? ' seconds' : ''}.` : '';
    return new Error((typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code] : 'EZiL model broker is unavailable. No retry was attempted.') + suffix);
}
