/**
 * World Builder — 짧은 설명에서 상세 세계관 로어북 엔트리 생성
 */

import { callLLM } from './llm-service.js';
import { getSettings, createEntry, deactivateEntry, deleteEntry, saveLorebook, loadTargetLorebook, refreshEditor } from './lore-store.js';
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
 * 세계관 엔트리 제안 — 캐릭터 카드 + 기존 로어북 분석 후 필요한 엔트리 목록만 제안
 * @param {string} characterContext - 캐릭터 카드 + 페르소나
 * @param {string} userRequirements - 유저가 직접 넣고싶은 설정
 * @returns {Promise<Array<{title, category, reason}>>}
 */
export async function suggestWorldEntries(characterContext, userRequirements = '') {
    const settings = getSettings();

    if (!settings.targetLorebook) {
        throw new Error('대상 로어북을 먼저 선택해주세요.');
    }

    // 기존 로어북 엔트리 수집
    const data = await loadTargetLorebook();
    const existingEntries = [];
    if (data?.entries) {
        for (const entry of Object.values(data.entries)) {
            if (entry.disable) continue;
            if (!entry.content) continue;
            existingEntries.push(`- [${entry.comment || 'untitled'}]: ${(entry.content || '').slice(0, 200)}`);
        }
    }

    const systemPrompt = `You are a world-building assistant for mature/adult roleplay. Analyze the character card, persona, existing lorebook, and user requirements. Suggest ONLY the entries that are MISSING and would meaningfully enrich the roleplay.

Rules:
- Do NOT suggest entries for info already in the character card/persona
- Do NOT suggest entries that already exist in the current lorebook
- Do NOT invent conflicting details
- If the user has provided specific requirements, prioritize those
- Suggest a reasonable number — quality over quantity
- Output ONLY valid JSON. No markdown fences, no explanations.`;

    const userPrompt = `## Character Card + Persona
${characterContext || '(none)'}

## Existing Lorebook Entries
${existingEntries.length > 0 ? existingEntries.join('\n') : '(empty)'}

## User Requirements (things they want to add)
${userRequirements || '(none specified — use your judgment)'}

## Task
Suggest entries that are MISSING and should be added. Output a JSON array where each item has:
- "title": short descriptive title
- "category": one of "character", "relationship", "location", "routine", "item", "event", "fact"
- "reason": brief explanation (1 sentence) why this entry is needed

Output ONLY the JSON array.`;

    console.log(`${LOG_PREFIX} Requesting world entry suggestions...`);

    const response = await callLLM(systemPrompt, userPrompt, settings.worldBuildMaxTokens, settings);

    let suggestions;
    try {
        const cleaned = response.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
        suggestions = JSON.parse(cleaned);
    } catch (e) {
        suggestions = salvageTruncatedArray(response);
        if (!suggestions) {
            console.error(`${LOG_PREFIX} Failed to parse suggestions response:`, response);
            throw new Error('AI 응답을 파싱할 수 없습니다.');
        }
    }

    if (!Array.isArray(suggestions)) {
        throw new Error('제안 형식이 잘못되었습니다.');
    }

    return suggestions;
}

/**
 * 선택된 제안들을 상세 내용으로 확장 후 로어북에 추가
 * @param {Array<{title, category, reason?}>} selectedItems - 유저가 선택/편집한 항목들
 * @param {string} characterContext
 * @param {string} userRequirements
 * @returns {Promise<Array>}
 */
export async function generateFromSuggestions(selectedItems, characterContext, userRequirements = '') {
    const settings = getSettings();

    if (!settings.targetLorebook) {
        throw new Error('대상 로어북을 먼저 선택해주세요.');
    }
    if (!Array.isArray(selectedItems) || selectedItems.length === 0) {
        throw new Error('선택된 항목이 없습니다.');
    }

    const data = await loadTargetLorebook();
    if (!data) throw new Error('로어북을 로드할 수 없습니다.');

    const systemPrompt = `You are a world-building assistant for mature/adult roleplay. Expand the provided entry outlines into full detailed lorebook entries. Preserve ALL details including violence, trauma, sensitive/adult content. Do NOT censor. Output ONLY valid JSON. No markdown fences, no explanations.`;

    const outlineList = selectedItems.map((item, i) =>
        `${i + 1}. [${item.category}] ${item.title}${item.reason ? ` — ${item.reason}` : ''}${item.content ? ` — user's draft: ${item.content}` : ''}`,
    ).join('\n');

    const userPrompt = `## Character Card + Persona
${characterContext || '(none)'}

## User Requirements
${userRequirements || '(none)'}

## Entries to Expand
${outlineList}

## Task
For each entry above, write a detailed, comprehensive lorebook entry. Each entry should have:
- "title": the title (keep it as provided unless you have a compelling reason to adjust)
- "content": detailed description (as long as needed — do NOT artificially shorten)
- "keywords": array of trigger keywords
- "category": the category (keep as provided)

Output a JSON array of the expanded entries. Output ONLY the JSON array.`;

    const response = await callLLM(systemPrompt, userPrompt, settings.worldBuildMaxTokens, settings);

    let entries;
    try {
        const cleaned = response.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
        entries = JSON.parse(cleaned);
    } catch (e) {
        entries = salvageTruncatedArray(response);
        if (!entries) {
            console.error(`${LOG_PREFIX} Failed to parse generation response:`, response);
            throw new Error('AI 응답을 파싱할 수 없습니다.');
        }
    }

    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error('생성된 엔트리가 없습니다.');
    }

    // 엔트리 생성
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

    await saveLorebook(settings.targetLorebook, data);
    refreshEditor();

    // 벡터 삽입
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

    console.log(`${LOG_PREFIX} Generated ${created.length} entries from suggestions`);
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
- Merge entries that are about the exact same thing — remove ALL duplicates.
- Do NOT duplicate the same information across different categories. If something is an event, record it ONLY as an event — do not also create a character or relationship entry with the same info rephrased. Pick the single most fitting category.
- Each entry covers ONE specific thing (one trait, one location, one event, etc.)
- For "event" category: title MUST include RP date/time/day if available (e.g., "Day 3 afternoon - first outing")
- Include memorable quotes, dialogue, text messages, letters verbatim when present in original entries.

Current entries:
${existingEntries.join('\n\n')}

Output a JSON array. Each entry must have: "title", "content" (as long as needed to preserve all original details — do NOT shorten or summarize), "keywords" (array), "category" (character/relationship/location/routine/item/event/fact)

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

    // 기존 엔트리 처리 (설정값에 따라 하이드 or 삭제)
    const handling = settings.reorganizeOldHandling || 'hide';
    for (const uid of existingUids) {
        if (handling === 'delete') {
            deleteEntry(data, uid, settings.targetLorebook);
        } else {
            deactivateEntry(data, uid);
        }
    }
    console.log(`${LOG_PREFIX} ${handling === 'delete' ? 'Deleted' : 'Deactivated'} ${existingUids.length} old entries`);

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
