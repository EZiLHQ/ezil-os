// Only allowlisted main-process state is rendered. Never display an IPC error body.
const errors = {
    signin_required: 'Sign in to Works again using Connect EZiL Works.',
    builder_required: 'Sign in with an onboarded Works builder account.',
    membership_required: 'Ask Works support to enable your AI membership.',
    paused: 'The EZiL AI gateway is paused. Inference is unavailable.',
    model_unavailable: 'No EZiL models are currently enabled for use.',
    auth_unavailable: 'Works sign-in is unavailable. Check the Works service configuration.',
    gateway_unavailable: 'Could not verify EZiL AI access. Refresh status when the service is available.',
    secure_storage_unavailable: 'Unlock macOS Keychain before connecting a provider.',
    rate_limited: 'Too many requests. Wait before refreshing status.'
};
export function providerText(value) {
    if (value.pending) return 'Checking provider access…';
    if (value.keychainAvailable === false) return errors.secure_storage_unavailable;
    if (Object.hasOwn(errors, value.errorCode)) return errors[value.errorCode];
    if (value.error || value.state === 'unavailable') return 'Provider access could not be verified. Refresh status or reconnect.';
    if (value.provider === 'ezil') {
        if (value.state === 'ready') return 'Works builder and AI membership verified. Requests use your Works credits; credit availability is checked per request.';
        return Object.hasOwn(errors, value.state) ? errors[value.state] : 'EZiL Works is selected. Sign in to verify AI access.';
    }
    if (value.state === 'stored' && ['azure', 'bedrock'].includes(value.provider)) return `${value.provider === 'azure' ? 'Azure' : 'Bedrock'} is selected. Credentials are stored in macOS Keychain; access has not been tested.`;
    return value.configured ? 'Provider state is unknown. Refresh status.' : 'No provider is connected. The desktop and editor work without one.';
}
