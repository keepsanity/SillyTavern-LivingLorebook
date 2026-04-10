/**
 * Memory Manager — 기억 정리(organize)와 압축(compress)
 */

import { callLLM } from './llm-service.js';
import {
    getSettings, saveSettings,
    loadTargetLorebook, saveLorebook, refreshEditor,
    createEntry, updateEntryContent, deactivateEntry,
    getMetadata, setMetadata,
    countTokens,
} from './lore-store.js';
import { insertEntries, deleteEntries, getCollectionId, getEntryHash } from './vector-service.js';

const LOG_PREFIX = '[LivingLorebook]';

// ============================================================
// Organize — 대화 분석 후 로어북 갱신
// ============================================================

/**
 * 기억 정리 실행
 * @param {object[]} chat - 현재 채팅 배열
 * @param {string} characterContext - 캐릭터 카드 + 페르소나
 * @param {object} options - { rangeStart?, rangeEnd? } (inclusive, message index)
 * @returns {Promise<{added: number, updated: number, deactivated: number, processedRange: [number, number]}>}
 */
export async function organize(chat, characterContext = '', options = {}) {
    const settings = getSettings();

    if (!settings.targetLorebook) {
        throw new Error('대상 로어북을 먼저 선택해주세요.');
    }

    const data = await loadTargetLorebook();
    if (!data) {
        throw new Error('로어북을 로드할 수 없습니다.');
    }

    // 범위 지정 (없으면 전체)
    const startIdx = Number.isInteger(options.rangeStart) ? Math.max(0, options.rangeStart) : 0;
    const endIdx = Number.isInteger(options.rangeEnd) ? Math.min(chat.length - 1, options.rangeEnd) : chat.length - 1;

    // 해당 범위의 하이드 안 된 메시지만 추출
    const recentMessages = [];
    const processedIndices = [];
    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        if (!m || m.is_system || m.is_hidden) continue;
        recentMessages.push(m);
        processedIndices.push(i);
    }

    if (recentMessages.length === 0) {
        return { added: 0, updated: 0, deactivated: 0, processedRange: [startIdx, endIdx] };
    }

    // 현재 엔트리 목록 생성
    const currentEntries = [];
    for (const [uid, entry] of Object.entries(data.entries || {})) {
        if (entry.disable) continue;
        currentEntries.push(`[uid:${uid}] ${entry.comment || 'untitled'}: ${entry.content}`);
    }

    // 대화 텍스트 구성
    const conversationText = recentMessages.map(m => {
        const name = m.is_user ? 'User' : (m.name || 'Character');
        return `${name}: ${m.mes}`;
    }).join('\n');

    // LLM 호출
    const charInfoBlock = characterContext
        ? `\n\nThe following character/persona info is ALREADY in the prompt — do NOT create lorebook entries for any of this:\n---\n${characterContext}\n---`
        : '';

    const systemPrompt = `You are a memory manager for mature/adult roleplay. Output ONLY valid JSON. No markdown fences, no explanations.

CRITICAL: Before adding ANY new entry, check if similar information already exists in:
1. The current lorebook entries below — if it does, use "update" (with existing uid), do NOT "add" a duplicate
2. The character card/persona info below — if it's already there, do NOT add it at all${charInfoBlock}`;
    const userPrompt = settings.organizePrompt
        .replace('{{currentEntries}}', currentEntries.join('\n') || '(none)')
        .replace('{{conversation}}', conversationText);

    console.log(`${LOG_PREFIX} Organizing memories (${recentMessages.length} messages)...`);

    const response = await callLLM(systemPrompt, userPrompt, settings.organizeMaxTokens, settings);

    // Parse response (handle truncated JSON)
    let instructions;
    try {
        const cleaned = response.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
        instructions = JSON.parse(cleaned);
    } catch (e) {
        // 잘린 JSON 복구 시도
        instructions = salvageTruncatedObject(response);
        if (!instructions) {
            console.error(`${LOG_PREFIX} Failed to parse organize response:`, response);
            throw new Error('AI 응답을 파싱할 수 없습니다. 다시 시도해주세요.');
        }
        console.warn(`${LOG_PREFIX} Organize response was truncated — salvaged partial result`);
    }

    const result = { added: 0, updated: 0, deactivated: 0 };
    const collectionId = getCollectionId(settings.targetLorebook);
    const newVectorEntries = [];
    const deleteHashes = [];

    // 1. 새 엔트리 추가
    if (Array.isArray(instructions.add)) {
        for (const item of instructions.add) {
            const entry = await createEntry(settings.targetLorebook, data, {
                title: item.title || 'untitled',
                content: item.content || '',
                keywords: item.keywords || [item.title],
                category: item.category || 'fact',
            });
            if (entry) {
                result.added++;
                newVectorEntries.push({
                    uid: String(entry.uid),
                    title: item.title,
                    content: item.content,
                    comment: item.title,
                });
            }
        }
    }

    // 2. 엔트리 수정
    if (Array.isArray(instructions.update)) {
        for (const item of instructions.update) {
            const uid = String(item.uid);
            const entry = data.entries?.[uid];
            if (!entry) continue;

            // 기존 벡터 삭제
            deleteHashes.push(getEntryHash(uid, entry.content));

            // 원본 보존
            const meta = getMetadata(uid, settings.targetLorebook);
            if (meta && !meta.originalContent) {
                setMetadata(uid, { originalContent: entry.content }, settings.targetLorebook);
            }

            updateEntryContent(data, uid, item.newContent, settings.targetLorebook);
            setMetadata(uid, { lastUpdated: Date.now() }, settings.targetLorebook);

            // 새 벡터 추가
            newVectorEntries.push({
                uid: uid,
                title: entry.comment || item.title,
                content: item.newContent,
                comment: entry.comment || item.title,
            });

            result.updated++;
            console.log(`${LOG_PREFIX} Updated "${entry.comment}": ${item.reason}`);
        }
    }

    // 3. 엔트리 비활성화
    if (Array.isArray(instructions.deactivate)) {
        for (const item of instructions.deactivate) {
            const uid = String(item.uid);
            if (deactivateEntry(data, uid)) {
                deleteHashes.push(getEntryHash(uid, data.entries[uid]?.content || ''));
                result.deactivated++;
                console.log(`${LOG_PREFIX} Deactivated "${item.title}": ${item.reason}`);
            }
        }
    }

    // 저장
    await saveLorebook(settings.targetLorebook, data);
    refreshEditor();

    // 벡터 업데이트
    try {
        if (deleteHashes.length > 0) {
            await deleteEntries(collectionId, deleteHashes);
        }
        if (newVectorEntries.length > 0) {
            await insertEntries(collectionId, newVectorEntries);
        }
    } catch (err) {
        console.warn(`${LOG_PREFIX} Vector update failed (non-critical):`, err);
    }

    // 상태 업데이트
    settings.lastOrganizeMessageIndex = chat.length;
    settings.lastOrganizeTimestamp = Date.now();
    saveSettings();

    console.log(`${LOG_PREFIX} Organize complete: +${result.added} ~${result.updated} -${result.deactivated}`);
    return {
        ...result,
        processedRange: [startIdx, endIdx],
        processedIndices,
    };
}

// ============================================================
// Compress — AI가 RP 맥락 판단 후 오래된 엔트리 압축
// ============================================================

/**
 * 기억 압축 실행 — AI가 현재 RP 맥락을 보고 어떤 엔트리가 오래되었는지 판단
 * @returns {Promise<{compressed: number}>}
 */
export async function compress() {
    const settings = getSettings();

    if (!settings.targetLorebook) {
        throw new Error('대상 로어북을 먼저 선택해주세요.');
    }

    const data = await loadTargetLorebook();
    if (!data) {
        throw new Error('로어북을 로드할 수 없습니다.');
    }

    // 현재 활성 Tier 1 엔트리 수집
    const tier1Entries = [];
    for (const [uid, entry] of Object.entries(data.entries || {})) {
        if (entry.disable) continue;
        const meta = getMetadata(uid, settings.targetLorebook);
        if (!meta || meta.tier > 1) continue;
        tier1Entries.push({ uid, title: entry.comment || 'untitled', content: entry.content });
    }

    if (tier1Entries.length === 0) {
        return { compressed: 0 };
    }

    // 최근 대화에서 맥락 파악
    const chat = SillyTavern.getContext().chat || [];
    const recentMessages = chat.slice(-20).filter(m => !m.is_system);
    const recentContext = recentMessages.map(m => {
        const name = m.is_user ? 'User' : (m.name || 'Character');
        return `${name}: ${m.mes}`;
    }).join('\n');

    // AI에게 어떤 엔트리가 오래되었는지 판단 요청
    const systemPrompt = 'You are a memory relevance analyst. Output ONLY valid JSON. No markdown fences.';
    const userPrompt = `Based on the current RP context, classify which lorebook entries are still actively relevant vs. becoming old/background information.

Current conversation context (recent):
${recentContext || '(no recent messages)'}

Lorebook entries to classify:
${tier1Entries.map(e => `[uid:${e.uid}] ${e.title}: ${e.content}`).join('\n')}

Output a JSON object:
- "tier2": array of UIDs that are becoming background info (should be summarized to ~${settings.tier2TargetRatio}%)
- "tier3": array of UIDs that are old/distant info (should be ultra-compressed to ~${settings.tier3TargetRatio}%)
- "keep": array of UIDs that are still actively relevant (stay as Tier 1)

Rules:
- Only demote entries whose information is NOT being actively referenced in recent conversation
- Character core traits and ongoing relationships usually stay relevant
- Past events that aren't being discussed can be compressed
- When in doubt, keep at Tier 1`;

    console.log(`${LOG_PREFIX} Asking AI to classify ${tier1Entries.length} entries for compression...`);

    const response = await callLLM(systemPrompt, userPrompt, 1000, settings);

    let classification;
    try {
        const cleaned = response.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
        classification = JSON.parse(cleaned);
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to parse compression classification:`, response);
        throw new Error('AI 응답을 파싱할 수 없습니다.');
    }

    const collectionId = getCollectionId(settings.targetLorebook);
    let compressed = 0;
    const deleteHashes = [];
    const newVectorEntries = [];

    // 분류된 엔트리들 압축
    const toCompress = [
        ...((classification.tier2 || []).map(uid => ({ uid: String(uid), targetTier: 2 }))),
        ...((classification.tier3 || []).map(uid => ({ uid: String(uid), targetTier: 3 }))),
    ];

    for (const { uid, targetTier } of toCompress) {
        const entry = data.entries?.[uid];
        if (!entry || entry.disable) continue;

        const meta = getMetadata(uid, settings.targetLorebook);
        if (!meta) continue;

        // 원본 보존
        if (!meta.originalContent) {
            setMetadata(uid, { originalContent: entry.content }, settings.targetLorebook);
        }

        const targetRatio = targetTier === 2 ? settings.tier2TargetRatio : settings.tier3TargetRatio;
        const systemPrompt = 'You are a text compression assistant. Output ONLY the compressed text. No explanations.';
        const userPrompt = settings.compressPrompt
            .replace('{{content}}', entry.content)
            .replace('{{targetRatio}}', String(targetRatio));

        try {
            const compressedText = await callLLM(systemPrompt, userPrompt, settings.compressMaxTokens, settings);

            if (!compressedText || compressedText.trim().length === 0) {
                console.warn(`${LOG_PREFIX} Empty compression for uid=${uid}, skipping`);
                continue;
            }

            // 기존 벡터 삭제
            deleteHashes.push(getEntryHash(uid, entry.content));

            // 엔트리 업데이트
            updateEntryContent(data, uid, compressedText, settings.targetLorebook);
            setMetadata(uid, { tier: targetTier, lastUpdated: Date.now() }, settings.targetLorebook);

            // 새 벡터
            newVectorEntries.push({
                uid: uid,
                title: entry.comment,
                content: compressedText,
                comment: entry.comment,
            });

            compressed++;
            const prevTier = meta.tier || 1;
            console.log(`${LOG_PREFIX} Compressed "${entry.comment}" tier ${prevTier}→${targetTier}`);
        } catch (err) {
            console.error(`${LOG_PREFIX} Compression failed for "${entry.comment}":`, err);
        }
    }

    if (compressed > 0) {
        await saveLorebook(settings.targetLorebook, data);
        refreshEditor();

        try {
            if (deleteHashes.length > 0) {
                await deleteEntries(collectionId, deleteHashes);
            }
            if (newVectorEntries.length > 0) {
                await insertEntries(collectionId, newVectorEntries);
            }
        } catch (err) {
            console.warn(`${LOG_PREFIX} Vector update failed (non-critical):`, err);
        }
    }

    console.log(`${LOG_PREFIX} Compression complete: ${compressed} entries compressed`);
    return { compressed };
}

/**
 * 잘린 JSON 객체 복구 — add/update/deactivate 중 완성된 부분만 추출
 */
function salvageTruncatedObject(raw) {
    const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();

    // 완성된 배열 필드들을 개별 추출
    const result = { add: [], update: [], deactivate: [] };
    let found = false;

    for (const field of ['add', 'update', 'deactivate']) {
        const regex = new RegExp(`"${field}"\\s*:\\s*\\[`, 'i');
        const match = cleaned.match(regex);
        if (!match) continue;

        const startIdx = cleaned.indexOf(match[0]) + match[0].length;
        // 해당 배열의 끝 찾기 — 끝에서부터 ']' 또는 '}]' 시도
        const remaining = cleaned.slice(startIdx);

        // 완전한 배열 닫힘이 있는 경우
        const closeBracket = remaining.indexOf(']');
        if (closeBracket !== -1) {
            try {
                result[field] = JSON.parse('[' + remaining.slice(0, closeBracket + 1));
                found = true;
                continue;
            } catch { /* try salvage */ }
        }

        // 잘린 경우 — 끝에서부터 '}' 찾아서 시도
        for (let i = remaining.length - 1; i > 0; i--) {
            if (remaining[i] === '}') {
                try {
                    const arr = JSON.parse('[' + remaining.slice(0, i + 1) + ']');
                    if (Array.isArray(arr)) {
                        result[field] = arr;
                        found = true;
                        break;
                    }
                } catch { /* try next */ }
            }
        }
    }

    return found ? result : null;
}
