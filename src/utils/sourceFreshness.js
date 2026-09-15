export function getSourceFreshness(entry, currentPdfCid) {
    if (!entry || !(typeof entry === 'string' || entry.cid || entry.content != null)) return null;
    if (!entry.sourcePdfCid || !currentPdfCid) return 'unknown';
    return entry.sourcePdfCid === currentPdfCid ? null : 'stale';
}
