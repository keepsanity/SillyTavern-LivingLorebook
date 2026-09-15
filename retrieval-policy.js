import { l } from './i18n.js';
import { normalizeMemory } from './memory-policy.js';

export function matchesName(name, text) {
    const value = String(name || '').trim();
    if (value.length < 2) return false;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(text);
}

export function isDirectSubject(candidate, text) {
    // Canonical names only. Generic event keywords must not turn all past events into mandatory memories.
    const legacyNames = candidate.category === 'character' ? (candidate.rawEntry?.key || []).filter(k => !String(k).startsWith('/')) : [];
    return [...(candidate.aliases || []), ...legacyNames, candidate.title].some(name => matchesName(name, text));
}

export function rankMemories(candidates, { vectorRanks, bm25Results, keywordHits, text, recentText = text, settings, vectorUnavailable }) {
    const bScores = new Map(bm25Results.map(r => [r.entry.compositeKey, r.score]));
    const bRanks = new Map(bm25Results.map((r, i) => [r.entry.compositeKey, i + 1]));
    const topB = bm25Results[0]?.score || 0;
    const floor = topB * Math.max(settings.bm25MinScoreRatio ?? 0.35, settings.vectorCutoffRatio ?? 0.6);
    const ranked = [];
    for (const c of candidates) {
        const key = c.compositeKey;
        const v = vectorRanks.get(key);
        const b = bRanks.get(key);
        const keyword = keywordHits.has(key);
        const direct = settings.keywordMatchEnabled !== false && isDirectSubject(c, text);
        const person = direct && c.category === 'character';
        const continuity = direct && (c.openLoop || (c.live && c.category === 'relationship'));
        // Strong lexical evidence survives fusion; weak general-word overlap does not fill the limit.
        const lexical = b && bScores.get(key) >= floor && (keyword || vectorUnavailable);
        if (!person && !continuity && !v && !lexical && !keyword) continue;
        const score = (v ? (settings.hybridVectorWeight ?? 1) / (60 + v) : 0)
            + (b ? (settings.hybridBm25Weight ?? 1) / (60 + b) : 0);
        const recent = direct && isDirectSubject(c, recentText);
        const priority = person ? (recent ? 5 : 3) : continuity ? (recent ? 4 : 2) : 1;
        const reason = person ? l('ll.c962320ae566a7a3', "Direct name mention · character information") : continuity ? l('ll.9d3e23d879937912', "Current relationship / unresolved commitment")
            : v && b ? l('ll.c165992cc1f0e73a', "Semantic + lexical match") : v ? l('ll.edf52dff4b6242a6', "Semantic match") : keyword ? l('ll.61394fa9caee5477', "Keyword match") : l('ll.0dc3f9b357765b41', "Vector unavailable · lexical match");
        ranked.push({ ...c, priority, score, reason: reason + (recent && (person || continuity) ? l('ll.24bbf6458f4681db', " · recent conversation") : ''), vectorRank: v, bm25Rank: b });
    }
    ranked.sort((a, b) => b.priority - a.priority || b.score - a.score);
    const seen = new Set();
    return ranked.filter(c => {
        const body = normalizeMemory(c.content);
        if (!body || seen.has(body)) return false;
        seen.add(body);
        return true;
    });
}

export async function fitMemoryBudget(entries, budget, countTokens) {
    const selected = [];
    const omitted = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = await countTokens(entry.content || '');
        if (budget > 0 && used + tokens > budget) {
            omitted.push({ title: entry.title, reason: l('ll.9b04ccd8d990fcef', "LL token cap exceeded") });
            continue;
        }
        used += tokens;
        selected.push({ ...entry, tokens });
    }
    return { entries: selected, omitted, tokens: used };
}
