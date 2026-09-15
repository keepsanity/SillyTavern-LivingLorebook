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
        const reason = person ? '이름 직접 언급 · 인물 정보' : continuity ? '현재 관계 / 미해결 약속'
            : v && b ? '의미 + 단어 검색' : v ? '의미 검색' : keyword ? '키워드 일치' : '벡터 장애 · 단어 검색';
        ranked.push({ ...c, priority, score, reason: reason + (recent && (person || continuity) ? ' · 최근 대화' : ''), vectorRank: v, bm25Rank: b });
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
            omitted.push({ title: entry.title, reason: 'LL 토큰 예산 초과' });
            continue;
        }
        used += tokens;
        selected.push({ ...entry, tokens });
    }
    return { entries: selected, omitted, tokens: used };
}
