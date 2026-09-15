/** Complete the continuity brief before allowing source messages to be hidden. */
export async function finishOrganize(result, settings, { isCurrent, backfill, arc }) {
    const chain = { backfilled: 0, arcUpdated: false, arcCreated: false, errors: [], allowHide: true };
    if (result.cancelled || !isCurrent(result.operation)) return { ...chain, allowHide: false };
    if (!result.added && !result.updated) return chain;
    // The arc is essential continuity; a retrieval-summary failure must not skip it.
    if (settings.autoArcOnOrganize) {
        try {
            const outcome = await arc();
            chain.arcCreated = !!outcome.created;
            chain.arcUpdated = !!outcome.updated;
        } catch (err) {
            chain.errors.push(`줄거리: ${err.message}`);
            chain.allowHide = false;
        }
    }
    if (settings.autoBackfillOnOrganize && result.createdUids?.length && isCurrent(result.operation)) {
        try {
            const outcome = await backfill({ lorebookName: result.operation.book, uids: result.createdUids });
            chain.backfilled = outcome.filled;
        } catch (err) { chain.errors.push(`summary: ${err.message}`); }
    }
    chain.allowHide &&= isCurrent(result.operation);
    return chain;
}
