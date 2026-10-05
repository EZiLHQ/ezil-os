/** Messages belong to one document navigation of one iframe. */
export function isCurrentViewerMessage(event, source, origin, attempt) {
    return !! source && !! origin && origin !== 'null' && !! attempt
        && event?.source === source && event.origin === origin
        && event.data?.attempt === attempt;
}

/** Another viewer's server session cannot prove this viewer decoded pixels. */
export function viewerFramesAdvance(previous, current) {
    const counters = (v) => Number.isFinite(v?.bytesReceived) && v.bytesReceived >= 0
        && Number.isFinite(v?.framesDecoded) && v.framesDecoded >= 0;
    return counters(previous) && counters(current) && current.connectionState === 'connected'
        && current.bytesReceived > previous.bytesReceived
        && current.framesDecoded > previous.framesDecoded
        && Number.isFinite(current.width) && current.width > 0
        && Number.isFinite(current.height) && current.height > 0;
}
