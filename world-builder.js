/**
 * World Builder — 짧은 설명에서 상세 세계관 로어북 엔트리 생성
 */

import { callLLM } from './llm-service.js';
import { getSettings, createEntry, deactivateEntry, deleteEntry, saveLorebook, loadTargetLorebook, refreshEditor, getMetadata } from './lore-store.js';
import { insertEntries, getCollectionId } from './vector-service.js';
import { generateStoryArc } from './memory-manager.js';

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
 * 수동 엔트리 생성 — 유저가 패널에서 카테고리/제목/내용을 직접 입력해 target 로어북에 1개 추가.
 * AI 호출 없음. createEntry가 managed mode·position·order·metadata를 알아서 처리.
 * @param {{title: string, content: string, category: string}} fields
 * @returns {Promise<{uid: string|number, title: string, category: string}>}
 */
export async function createManualEntry({ title, content, category }) {
    const settings = getSettings();

    if (!settings.targetLorebook) {
        throw new Error('대상(target) 로어북을 먼저 선택해주세요.');
    }

    const cleanTitle = (title || '').trim();
    if (!cleanTitle) {
        throw new Error('제목을 입력해주세요.');
    }

    const data = await loadTargetLorebook();
    if (!data) {
        throw new Error('로어북을 로드할 수 없습니다.');
    }

    const entry = await createEntry(settings.targetLorebook, data, {
        title: cleanTitle,
        content: content || '',
        keywords: [cleanTitle],
        category: category || 'fact',
    });
    if (!entry) {
        throw new Error('엔트리 생성에 실패했습니다.');
    }

    await saveLorebook(settings.targetLorebook, data);
    refreshEditor();

    // 벡터 색인에 삽입 (실패해도 치명적 아님 — BM25로는 바로 잡히고, 벡터는 재색인으로 복구 가능)
    try {
        const collectionId = getCollectionId(settings.targetLorebook);
        await insertEntries(collectionId, [{
            uid: String(entry.uid),
            title: cleanTitle,
            content: content || '',
            comment: cleanTitle,
        }]);
    } catch (err) {
        console.warn(`${LOG_PREFIX} Manual entry vector insertion failed (non-critical):`, err);
    }

    console.log(`${LOG_PREFIX} Created manual entry: ${cleanTitle} (${category || 'fact'})`);
    return { uid: entry.uid, title: cleanTitle, category: category || 'fact' };
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

    const systemPrompt = `You are a world-building assistant for mature/adult roleplay. Expand the provided entry outlines into focused lorebook entries. Preserve mature/adult/violent content. Do NOT censor. Output ONLY valid JSON. No markdown fences, no explanations.`;

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
For each entry above, write a FOCUSED lorebook entry that contains ONLY information directly relevant to this character/scenario. Each entry should have:
- "title": the title (keep as provided unless adjustment is necessary)
- "content": concise description, around 2~4 short sentences
- "keywords": array of trigger keywords
- "category": the category (keep as provided)

CRITICAL CONTENT RULES:
- Keep it SHORT. The content describes the subject's role in this character's life, not the subject itself.
- Do NOT include general/encyclopedic background, history of the topic, origin stories, or how/why something came to be — unless that is itself the entry's topic.
- Do NOT pad with tangential context. Cut anything not directly used in the scenario.
- If the user's draft is provided, expand only on that specific angle.

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
/**
 * 재구성 — 기존 엔트리를 AI로 정리해 새 엔트리 세트를 만든다.
 *
 * ⚠️ 왜 배치로 나누는가 (2026-08-23 사고):
 * 예전엔 로어북 전체(89개, 6만자)를 한 프롬프트에 넣고 "빠짐없이 다시 써라"고 시켰다.
 * 출력 한도(32k)엔 한참 못 미쳤는데도 모델이 서사 사건 20개(약 3만자)를 스스로 잘라먹었다 —
 * "중복 제거 / 한 엔트리엔 한 주제" 지시와 "전부 보존" 지시가 충돌하면 모델은 요약을 택한다.
 * 그리고 원본은 이미 삭제된 뒤라 되돌릴 수 없었다.
 *
 * 그래서 지금은:
 *  1) 카테고리·제목 순으로 묶어 작은 배치로 나눠 호출한다 (한 번에 다룰 양을 줄인다)
 *  2) **모든 배치가 성공한 뒤에야** 원본을 건드린다 (중간 실패 시 로어북 무손상)
 *  3) 결과가 원본보다 심하게 줄면 삭제 모드에선 중단한다 (하이드 모드는 복구 가능하므로 경고만)
 *
 * @param {{onProgress?: (done: number, total: number) => void}} [opts]
 */
export async function reorganizeExisting(opts = {}) {
    const settings = getSettings();

    if (!settings.targetLorebook) {
        throw new Error('대상 로어북을 먼저 선택해주세요.');
    }

    const data = await loadTargetLorebook();
    if (!data?.entries) {
        throw new Error('로어북을 로드할 수 없습니다.');
    }

    // 기존 엔트리 수집 (uid 추적)
    const existing = [];
    for (const [uid, entry] of Object.entries(data.entries)) {
        if (!entry.content) continue;
        if (entry.disable) continue; // 이미 비활성화된 건 스킵
        existing.push({
            uid,
            title: entry.comment || 'untitled',
            content: entry.content,
            category: getMetadata(uid, settings.targetLorebook)?.category || '',
        });
    }

    if (existing.length === 0) {
        throw new Error('분석할 엔트리가 없습니다.');
    }

    // 관련된 것끼리 같은 배치에 들어가야 병합/중복제거가 의미 있다.
    // 배치를 나누면 배치를 가로지르는 중복은 못 잡으므로, 카테고리→제목 순으로 묶어 최대한 모아준다.
    existing.sort((a, b) => (a.category || 'zz').localeCompare(b.category || 'zz')
        || a.title.localeCompare(b.title));

    // 배치는 **개수와 글자수 둘 다**로 자른다.
    // 개수만 보면 큰 엔트리가 몰린 배치에서 출력이 모델 한도를 넘겨 잘리고,
    // salvageTruncatedArray가 완성된 것만 건지면서 나머지 엔트리가 통째로 사라진다.
    // (Snow Opus 사례: 11k~17k자 챕터 엔트리들이 한 배치에 들어가 결과가 원본의 64%로 줄었다.)
    // 재구성은 "전부 다시 쓰기"라 출력이 입력만큼 나온다 → 입력 글자수로 상한을 잡는다.
    const batchSize = Math.max(3, Math.min(Number(settings.reorganizeBatchSize) || 12, 40));
    // 입력 글자수 상한 = 요청 토큰수 × 1. 영문 기준 4자/토큰이므로 출력에 필요한 토큰은
    // 상한의 약 1/4 — 모델이 요청한 만큼 안 뱉어도 여유가 있다.
    // (요청값을 그대로 믿고 크게 잡았다가 Snow Opus에서 잘렸다. 보수적으로 간다.)
    const charCap = Math.max(4000, Number(settings.worldBuildMaxTokens) || 32000);

    const batches = [];
    let cur = [];
    let curChars = 0;
    for (const e of existing) {
        const len = e.content.length + e.title.length + 4;
        // 한 엔트리가 혼자 상한을 넘으면 어쩔 수 없이 단독 배치 (쪼개면 내용이 갈라진다)
        if (cur.length > 0 && (cur.length >= batchSize || curChars + len > charCap)) {
            batches.push(cur);
            cur = [];
            curChars = 0;
        }
        cur.push(e);
        curChars += len;
    }
    if (cur.length > 0) batches.push(cur);

    const systemPrompt = `You are a lorebook reorganizer for mature/adult roleplay. You MUST preserve ALL details from the source material exactly as written — including physical descriptions, body characteristics, scars, injuries, nudity, violence, trauma, and any adult or sensitive content. Do NOT censor, sanitize, skip, or tone down any information. Do NOT invent, add, or create any new information that is not in the original entries. This is a creative fiction lorebook for private use. Output ONLY valid JSON. No markdown fences, no explanations.`;

    const buildUserPrompt = (batch, idx) => `Reorganize these existing lorebook entries into clean, event/entity-based entries.

This is batch ${idx + 1} of ${batches.length}. Reorganize ONLY the entries given below.

CRITICAL RULES:
- ONLY use information that already exists in the entries below. Do NOT add, invent, or extrapolate any new details.
- Preserve ALL content faithfully — including adult, violent, or sensitive details. Do NOT censor or omit anything.
- **Every entry below MUST survive in your output.** Nothing may be dropped. If an entry does not need changing, output it unchanged.
- Narrative events (things that happened at a specific time) MUST stay as their own event entries with their full narration intact. Never replace an event with a place/person description.
- Split entries that cover multiple topics into separate entries.
- Merge two entries ONLY if they describe the exact same thing; when you merge, the merged entry must contain everything both originals said.
- Each entry covers ONE specific thing (one trait, one location, one event, etc.)
- For "event" category: title MUST include RP date/time/day if available (e.g., "Day 3 afternoon - first outing")
- Include memorable quotes, dialogue, text messages, letters verbatim when present in original entries.

Current entries:
${batch.map(e => `[${e.title}] ${e.content}`).join('\n\n')}

Output a JSON array. Each entry must have: "title", "content" (as long as needed to preserve all original details — do NOT shorten or summarize), "keywords" (array), "category" (character/relationship/location/routine/item/event/fact)

Output ONLY the JSON array.`;

    console.log(`${LOG_PREFIX} Reorganizing ${existing.length} entries in ${batches.length} batches `
        + `(최대 ${batchSize}개 / ${charCap.toLocaleString()}자): `
        + batches.map(b => `${b.length}개·${b.reduce((n, e) => n + e.content.length, 0).toLocaleString()}자`).join(' | '));

    // --- 1) 전 배치 실행. 하나라도 실패하면 로어북은 손도 대지 않고 중단 ---
    const newEntries = [];
    let truncated = 0;
    for (let i = 0; i < batches.length; i++) {
        opts.onProgress?.(i, batches.length);

        const response = await callLLM(systemPrompt, buildUserPrompt(batches[i], i), settings.worldBuildMaxTokens, settings);

        let parsed;
        try {
            parsed = JSON.parse(response.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim());
        } catch {
            parsed = salvageTruncatedArray(response);
            if (parsed) {
                // 잘렸다 = 이 배치의 엔트리 일부가 통째로 사라졌다는 뜻. 조용히 넘기면 안 된다.
                console.warn(`${LOG_PREFIX} 배치 ${i + 1}/${batches.length} 응답이 잘림 — `
                    + `${batches[i].length}개 입력 중 ${parsed.length}개만 건짐`);
                globalThis.toastr?.warning?.(
                    `배치 ${i + 1}의 AI 응답이 잘렸습니다 (${batches[i].length}개 → ${parsed.length}개). `
                    + `배치 크기를 줄이고 다시 시도하세요.`, 'LivingLorebook', { timeOut: 15000 });
                truncated++;
            }
        }

        if (!Array.isArray(parsed) || parsed.length === 0) {
            console.error(`${LOG_PREFIX} 배치 ${i + 1}/${batches.length} 파싱 실패:`, response?.slice(0, 500));
            throw new Error(`배치 ${i + 1}/${batches.length} 처리에 실패했습니다. 로어북은 그대로 두었습니다 — 다시 시도해주세요.`);
        }
        newEntries.push(...parsed);
        console.log(`${LOG_PREFIX} 배치 ${i + 1}/${batches.length}: ${batches[i].length}개 → ${parsed.length}개`);
    }
    opts.onProgress?.(batches.length, batches.length);

    // --- 2) 유실 감지 — 결과가 원본보다 심하게 줄었으면 파괴적 모드는 중단 ---
    const handling = settings.reorganizeOldHandling || 'hide';
    const beforeChars = existing.reduce((n, e) => n + e.content.length, 0);
    const afterChars = newEntries.reduce((n, e) => n + String(e?.content || '').length, 0);
    const keepRatio = beforeChars > 0 ? afterChars / beforeChars : 1;
    if (keepRatio < 0.7) {
        const msg = `재구성 결과가 원본의 ${Math.round(keepRatio * 100)}%로 줄었습니다 `
            + `(${beforeChars.toLocaleString()}자 → ${afterChars.toLocaleString()}자). 내용이 유실된 것으로 보입니다.`;
        if (handling === 'delete') {
            throw new Error(`${msg}\n\n원본을 지우지 않고 중단했습니다. 설정에서 "하이드"로 바꾸고 다시 시도하거나, 배치 크기를 줄여보세요.`);
        }
        console.warn(`${LOG_PREFIX} ${msg} (하이드 모드라 원본은 복구 가능)`);
        globalThis.toastr?.warning?.(`${msg} 기존 엔트리는 하이드 상태로 남아 있으니 확인해주세요.`, 'LivingLorebook', { timeOut: 15000 });
    }

    // --- 3) 여기서부터 로어북 변경 ---
    for (const e of existing) {
        if (handling === 'delete') {
            deleteEntry(data, e.uid, settings.targetLorebook);
        } else {
            deactivateEntry(data, e.uid);
        }
    }
    console.log(`${LOG_PREFIX} ${handling === 'delete' ? 'Deleted' : 'Deactivated'} ${existing.length} old entries`);

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

    console.log(`${LOG_PREFIX} Reorganized into ${created.length} entries (${batches.length} batches, ${Math.round(keepRatio * 100)}% 분량 유지)`);

    // 자동 체인: reorganize 후 기존 arc 있으면 자동 업데이트
    let arcUpdated = false;
    if (settings.autoArcOnReorganize) {
        try {
            const freshData = await loadTargetLorebook();
            let hasArc = false;
            for (const [uid, entry] of Object.entries(freshData?.entries || {})) {
                if (entry.disable) continue;
                const meta = getMetadata(uid, settings.targetLorebook);
                if (meta?.category === 'arc') { hasArc = true; break; }
            }
            if (hasArc) {
                console.log(`${LOG_PREFIX} Auto-chain: updating story arc after reorganize...`);
                await generateStoryArc();
                arcUpdated = true;
            }
        } catch (err) {
            console.warn(`${LOG_PREFIX} Auto-chain arc update failed:`, err.message);
        }
    }

    return { reorganized: created.length, arcUpdated, batches: batches.length, keepRatio, handling, truncated };
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
