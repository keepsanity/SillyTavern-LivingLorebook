/**
 * World Builder — 짧은 설명에서 상세 세계관 로어북 엔트리 생성
 */

import { callLLM } from './llm-service.js';
import { getSettings, createEntry, deactivateEntry, saveLorebook, loadTargetLorebook, refreshEditor } from './lore-store.js';
import { insertEntries, getCollectionId } from './vector-service.js';

const LOG_PREFIX = '[LivingLorebook]';

/**
 * 세계관 생성
 * @param {string} description - 유저의 짧은 설명
 * @returns {Promise<object[]>} 생성된 엔트리 목록
 */
export async function generateWorld(description) {
    const settings = getSettings();

    if (!settings.targetLorebook) {
        throw new Error('대상 로어북을 먼저 선택해주세요.');
    }

    const systemPrompt = `You are a world-building assistant for mature/adult roleplay. You MUST preserve ALL details from the source material exactly as written — including physical descriptions, body characteristics, scars, injuries, nudity, violence, trauma, and any adult or sensitive content. Do NOT censor, sanitize, skip, or tone down any information. This is a creative fiction lorebook for private use. Output ONLY valid JSON. No markdown fences, no explanations.`;
    const userPrompt = settings.worldBuildPrompt.replace('{{description}}', description);

    console.log(`${LOG_PREFIX} Generating world from description...`);

    const response = await callLLM(systemPrompt, userPrompt, settings.worldBuildMaxTokens, settings);

    // Parse JSON response (handle truncated responses from max_tokens)
    let entries;
    try {
        const cleaned = response.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
        entries = JSON.parse(cleaned);
    } catch (e) {
        // Try to salvage truncated JSON array
        entries = salvageTruncatedArray(response);
        if (!entries) {
            console.error(`${LOG_PREFIX} Failed to parse world-build response:`, response);
            throw new Error('AI 응답을 파싱할 수 없습니다. 다시 시도해주세요.');
        }
        console.warn(`${LOG_PREFIX} Response was truncated — salvaged ${entries.length} entries`);
    }

    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error('생성된 엔트리가 없습니다.');
    }

    // Load lorebook and create entries
    const data = await loadTargetLorebook();
    if (!data) {
        throw new Error('로어북을 로드할 수 없습니다.');
    }

    const created = [];
    for (const item of entries) {
        const entry = await createEntry(settings.targetLorebook, data, {
            title: item.title || 'untitled',
            content: item.content || '',
            keywords: item.keywords || [item.title],
            category: item.category || 'fact',
        });

        if (entry) {
            created.push({
                uid: entry.uid,
                title: item.title,
                content: item.content,
                keywords: item.keywords,
                category: item.category,
            });
        }
    }

    // Save lorebook
    await saveLorebook(settings.targetLorebook, data);
    refreshEditor();

    // Vectorize new entries
    const collectionId = getCollectionId(settings.targetLorebook);
    try {
        await insertEntries(collectionId, created.map(e => ({
            uid: String(e.uid),
            title: e.title,
            content: e.content,
            comment: e.title,
        })));
    } catch (err) {
        console.warn(`${LOG_PREFIX} Vector insertion failed (non-critical):`, err);
    }

    console.log(`${LOG_PREFIX} Created ${created.length} world entries`);
    return created;
}

/**
 * 기존 로어북 분석 후 사건/상태 단위로 재구성
 * @returns {Promise<{reorganized: number}>}
 */
export async function reorganizeExisting() {
    const settings = getSettings();

    if (!settings.targetLorebook) {
        throw new Error('대상 로어북을 먼저 선택해주세요.');
    }

    const data = await loadTargetLorebook();
    if (!data?.entries) {
        throw new Error('로어북을 로드할 수 없습니다.');
    }

    // 기존 엔트리 수집 (uid 추적)
    const existingEntries = [];
    const existingUids = [];
    for (const [uid, entry] of Object.entries(data.entries)) {
        if (!entry.content) continue;
        if (entry.disable) continue; // 이미 비활성화된 건 스킵
        existingEntries.push(`[${entry.comment || 'untitled'}] ${entry.content}`);
        existingUids.push(uid);
    }

    if (existingEntries.length === 0) {
        throw new Error('분석할 엔트리가 없습니다.');
    }

    const systemPrompt = `You are a lorebook reorganizer for mature/adult roleplay. You MUST preserve ALL details from the source material exactly as written — including physical descriptions, body characteristics, scars, injuries, nudity, violence, trauma, and any adult or sensitive content. Do NOT censor, sanitize, skip, or tone down any information. Do NOT invent, add, or create any new information that is not in the original entries. This is a creative fiction lorebook for private use. Output ONLY valid JSON. No markdown fences, no explanations.`;
    const userPrompt = `Reorganize these existing lorebook entries into clean, event/entity-based entries.

CRITICAL RULES:
- ONLY use information that already exists in the entries below. Do NOT add, invent, or extrapolate any new details.
- Preserve ALL content faithfully — including adult, violent, or sensitive details. Do NOT censor or omit anything.
- Split entries that cover multiple topics into separate entries.
- Merge entries that are about the exact same thing.
- Each entry covers ONE specific thing (one trait, one location, one event, etc.)
- For "event" category: title MUST include RP date/time/day if available (e.g., "Day 3 오후 - Snow 첫 외출")

Current entries:
${existingEntries.join('\n\n')}

Output a JSON array. Each entry must have: "title", "content" (1-3 sentences, using ONLY original information), "keywords" (array), "category" (character/relationship/location/routine/item/event/fact)

Output ONLY the JSON array.`;

    console.log(`${LOG_PREFIX} Reorganizing ${existingEntries.length} existing entries...`);

    const response = await callLLM(systemPrompt, userPrompt, settings.worldBuildMaxTokens, settings);

    let newEntries;
    try {
        const cleaned = response.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
        newEntries = JSON.parse(cleaned);
    } catch (e) {
        newEntries = salvageTruncatedArray(response);
        if (!newEntries) {
            console.error(`${LOG_PREFIX} Failed to parse reorganize response:`, response);
            throw new Error('AI 응답을 파싱할 수 없습니다. 다시 시도해주세요.');
        }
        console.warn(`${LOG_PREFIX} Reorganize response was truncated — salvaged ${newEntries.length} entries`);
    }

    if (!Array.isArray(newEntries) || newEntries.length === 0) {
        throw new Error('재구성된 엔트리가 없습니다.');
    }

    // 기존 엔트리 비활성화 (삭제 대신 disable)
    for (const uid of existingUids) {
        deactivateEntry(data, uid);
    }
    console.log(`${LOG_PREFIX} Deactivated ${existingUids.length} old entries`);

    // 새 엔트리 생성
    const created = [];
    for (const item of newEntries) {
        const entry = await createEntry(settings.targetLorebook, data, {
            title: item.title || 'untitled',
            content: item.content || '',
            keywords: item.keywords || [item.title],
            category: item.category || 'fact',
        });

        if (entry) {
            created.push({
                uid: entry.uid,
                title: item.title,
                content: item.content,
                comment: item.title,
            });
        }
    }

    await saveLorebook(settings.targetLorebook, data);
    refreshEditor();

    // Vectorize
    const collectionId = getCollectionId(settings.targetLorebook);
    try {
        await insertEntries(collectionId, created);
    } catch (err) {
        console.warn(`${LOG_PREFIX} Vector insertion failed (non-critical):`, err);
    }

    console.log(`${LOG_PREFIX} Reorganized into ${created.length} entries`);
    return { reorganized: created.length };
}

/**
 * 잘린 JSON 배열에서 완성된 객체들만 추출
 * 끝에서부터 모든 '}' 위치를 시도하여 유효한 JSON을 찾음
 */
function salvageTruncatedArray(raw) {
    const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();

    const start = cleaned.indexOf('[');
    if (start === -1) return null;

    const text = cleaned.slice(start);

    // 끝에서부터 모든 '}' 위치를 찾아 역순으로 시도
    const bracePositions = [];
    for (let i = text.length - 1; i > 0; i--) {
        if (text[i] === '}') {
            bracePositions.push(i);
        }
    }

    for (const pos of bracePositions) {
        const attempt = text.slice(0, pos + 1) + ']';
        try {
            const parsed = JSON.parse(attempt);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed;
            }
        } catch { /* try next position */ }
    }

    return null;
}
