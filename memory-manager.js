/**
 * Memory Manager — 기억 정리(organize)와 압축(compress)
 */

import { callLLM } from './llm-service.js';
import {
    getSettings, saveSettings,
    loadTargetLorebook, loadAnyLorebook, saveLorebook, refreshEditor,
    createEntry, updateEntryContent, deactivateEntry, setEntryPinned,
    getMetadata, setMetadata,
    countTokens, isManagedMode,
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
                summary: typeof item.summary === 'string' ? item.summary : '',
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
            const updateMeta = { lastUpdated: Date.now() };
            if (typeof item.summary === 'string' && item.summary.trim()) {
                updateMeta.summary = item.summary.trim();
            }
            setMetadata(uid, updateMeta, settings.targetLorebook);

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

    // ============================================================
    // 자동 체인: organize 후 backfill / arc 자동 실행
    // 실패해도 organize 본체는 성공으로 처리. 토스트로 알림.
    // ============================================================
    const chainResult = { backfilled: 0, arcUpdated: false, errors: [] };

    // 1. backfill 자동 — managed mode targetLorebook이고 새 entries 있을 때
    if (settings.autoBackfillOnOrganize && result.added > 0 && isManagedMode(settings.targetLorebook)) {
        try {
            console.log(`${LOG_PREFIX} Auto-chain: backfill for new entries...`);
            const bfResult = await backfillSummaries({ lorebookName: settings.targetLorebook });
            chainResult.backfilled = bfResult.filled;
            console.log(`${LOG_PREFIX} Auto-chain: backfill ${bfResult.filled}/${bfResult.total} filled`);
        } catch (err) {
            console.warn(`${LOG_PREFIX} Auto-chain backfill failed:`, err.message);
            chainResult.errors.push(`backfill: ${err.message}`);
        }
    }

    // 2. arc 업데이트 자동 — 기존 arc entry 있을 때만
    if (settings.autoArcOnOrganize) {
        try {
            // 기존 arc entry 확인
            const freshData = await loadTargetLorebook();
            let hasArc = false;
            for (const [uid, entry] of Object.entries(freshData?.entries || {})) {
                if (entry.disable) continue;
                const meta = getMetadata(uid, settings.targetLorebook);
                if (meta?.category === 'arc') {
                    hasArc = true;
                    break;
                }
            }
            if (hasArc) {
                console.log(`${LOG_PREFIX} Auto-chain: updating story arc...`);
                await generateStoryArc();
                chainResult.arcUpdated = true;
                console.log(`${LOG_PREFIX} Auto-chain: arc updated`);
            }
        } catch (err) {
            console.warn(`${LOG_PREFIX} Auto-chain arc update failed:`, err.message);
            chainResult.errors.push(`arc: ${err.message}`);
        }
    }

    return {
        ...result,
        processedRange: [startIdx, endIdx],
        processedIndices,
        chain: chainResult,
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

// ============================================================
// Backfill Summaries — 기존 엔트리에 summary 일괄 생성
// ============================================================

/**
 * Summary 없는 활성 엔트리들에 대해 일괄로 "When to select" 힌트 생성.
 * AI 선택 파이프라인(Phase 2)이 작동하려면 모든 엔트리에 summary가 있어야 함.
 *
 * @param {object} options - { batchSize?: number, onProgress?: (done, total) => void }
 * @returns {Promise<{filled: number, skipped: number, failed: number, total: number}>}
 */
export async function backfillSummaries(options = {}) {
    const settings = getSettings();
    const batchSize = options.batchSize ?? 8;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const lorebookName = options.lorebookName || settings.targetLorebook;

    if (!lorebookName) {
        throw new Error('대상 로어북을 먼저 선택해주세요.');
    }

    const data = lorebookName === settings.targetLorebook
        ? await loadTargetLorebook()
        : await loadAnyLorebook(lorebookName);
    if (!data) {
        throw new Error(`로어북 "${lorebookName}"을 로드할 수 없습니다.`);
    }

    // summary가 비어있는 활성 엔트리만 수집 (외부 로어북도 동일 — 메타 없으면 자동 생성됨)
    const targets = [];
    for (const [uid, entry] of Object.entries(data.entries || {})) {
        if (entry.disable) continue;
        const meta = getMetadata(uid, lorebookName);
        const existing = meta?.summary;
        if (existing && existing.trim()) continue;
        targets.push({ uid: String(uid), title: entry.comment || 'untitled', content: entry.content || '' });
    }

    const total = targets.length;
    if (total === 0) {
        return { filled: 0, skipped: 0, failed: 0, total: 0 };
    }

    console.log(`${LOG_PREFIX} Backfilling summaries for ${total} entries...`);

    let filled = 0;
    let failed = 0;
    let processed = 0;

    // 배치 단위로 LLM 호출
    for (let i = 0; i < targets.length; i += batchSize) {
        const batch = targets.slice(i, i + batchSize);

        const entriesBlock = batch.map(e => {
            // 너무 긴 엔트리는 앞부분만 — summary 생성에 전체 내용 불필요
            const truncated = e.content.length > 2000 ? e.content.slice(0, 2000) + '...' : e.content;
            return `[uid:${e.uid}] ${e.title}\n${truncated}`;
        }).join('\n\n---\n\n');

        const systemPrompt = 'You are a retrieval-summary writer for a roleplay lorebook. Output ONLY valid JSON. No markdown fences, no explanations.';
        const userPrompt = settings.summaryBackfillPrompt.replace('{{entries}}', entriesBlock);

        try {
            const response = await callLLM(systemPrompt, userPrompt, 2000, settings);
            const cleaned = response.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
            const parsed = JSON.parse(cleaned);

            if (Array.isArray(parsed.summaries)) {
                for (const s of parsed.summaries) {
                    const uid = String(s.uid);
                    const summary = typeof s.summary === 'string' ? s.summary.trim() : '';
                    if (!summary) {
                        failed++;
                        continue;
                    }
                    // 외부 엔트리(메타 없음)면 자동으로 LL 메타데이터 시드 생성
                    const existingMeta = getMetadata(uid, lorebookName);
                    if (!existingMeta) {
                        const ent = data.entries[uid];
                        setMetadata(uid, {
                            tier: 1,
                            createdAt: Date.now(),
                            category: 'fact',
                            keywords: Array.isArray(ent?.key) && ent.key.length > 0
                                ? ent.key
                                : [ent?.comment || 'untitled'],
                            summary,
                        }, lorebookName);
                    } else {
                        setMetadata(uid, { summary }, lorebookName);
                    }
                    filled++;
                }
            } else {
                console.warn(`${LOG_PREFIX} Backfill batch returned no summaries array:`, parsed);
                failed += batch.length;
            }
        } catch (err) {
            console.error(`${LOG_PREFIX} Backfill batch failed:`, err);
            failed += batch.length;
        }

        processed += batch.length;
        if (onProgress) {
            try { onProgress(processed, total); } catch { /* ignore */ }
        }
    }

    console.log(`${LOG_PREFIX} Backfill complete: ${filled} filled, ${failed} failed, ${total} total`);
    return { filled, skipped: 0, failed, total };
}

/**
 * Story Arc 생성/업데이트 — chat 전체를 봐서 timeline + 관계 호 요약 entry로 저장.
 * 기존 arc entry 있으면 그것 update (incremental), 없으면 새로 생성.
 * arc entry는 자동 pinned (constant=true) — 매 generation 항상 inject.
 *
 * @returns {Promise<{created: boolean, updated: boolean, uid: string, tokens: number}>}
 */
export async function generateStoryArc() {
    const settings = getSettings();

    if (!settings.targetLorebook) {
        throw new Error('대상 로어북을 먼저 선택해주세요.');
    }

    const data = await loadTargetLorebook();
    if (!data) {
        throw new Error('로어북을 로드할 수 없습니다.');
    }

    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    if (chat.length === 0) {
        throw new Error('대화가 비어있습니다.');
    }

    // 활성 chat만 (is_hidden, is_system 제외) + 최근 N개로 trim
    const activeChat = chat.filter(m => !m.is_system && !m.is_hidden);
    const arcChatLimit = settings.arcChatLimit || 100;
    const recentActive = activeChat.length > arcChatLimit
        ? activeChat.slice(-arcChatLimit)
        : activeChat;
    const conversationText = recentActive.map(m => {
        const name = m.is_user ? 'User' : (m.name || 'Character');
        return `${name}: ${m.mes}`;
    }).join('\n');

    // 기존 arc entry 찾기 + 다른 active entries 본문 수집
    const contentLimit = Number(settings.arcEntryContentLimit) || 0;
    let existingUid = null;
    let existingContent = '';
    const entriesByCategory = {}; // { category: [{ title, summary, content }] }
    for (const [uid, entry] of Object.entries(data.entries || {})) {
        if (entry.disable) continue;
        const meta = getMetadata(uid, settings.targetLorebook);
        const cat = meta?.category || 'fact';
        if (cat === 'arc') {
            existingUid = uid;
            existingContent = entry.content || '';
            continue; // arc는 별도 처리 — entries 모음엔 안 넣음
        }
        // content에서 `## title\n` 헤더 제거 (중복 방지)
        let body = (entry.content || '').replace(/^##\s+.*\r?\n/, '').trim();
        if (contentLimit > 0 && body.length > contentLimit) {
            body = body.slice(0, contentLimit) + '...';
        }
        // title이라도 있으면 포함 — 사건 흐름에서 빠지는 것보단 이름이라도 보내는 게 나음
        const title = entry.comment;
        if (!title && !body && !meta?.summary) continue;
        if (!entriesByCategory[cat]) entriesByCategory[cat] = [];
        entriesByCategory[cat].push({
            title: title || 'untitled',
            summary: (meta?.summary || '').trim(),
            content: body,
        });
    }

    // entries 텍스트 조립 (카테고리별 그룹) — full content + summary 둘 다
    const categoryOrder = ['character', 'relationship', 'location', 'event', 'routine', 'item', 'fact'];
    const entriesLines = [];
    for (const cat of categoryOrder) {
        const items = entriesByCategory[cat];
        if (!items || items.length === 0) continue;
        entriesLines.push(`### [${cat}]`);
        for (const it of items) {
            entriesLines.push(`\n--- ${it.title} ---`);
            if (it.summary) entriesLines.push(`(retrieval hint: ${it.summary})`);
            if (it.content) entriesLines.push(it.content);
        }
    }
    const entriesBlock = entriesLines.length > 0
        ? entriesLines.join('\n')
        : '(none)';

    const existingArcBlock = existingContent
        ? `Previous arc summary (update/expand, do NOT discard existing facts unless contradicted by new events):\n${existingContent.replace(/^##\s+.*\r?\n/, '').trim()}\n`
        : '';

    const systemPrompt = 'You are a narrative arc summarizer. Output ONLY the prose summary text. No JSON, no markdown headers, no preamble.';
    const userPrompt = settings.storyArcPrompt
        .replace('{{existingArc}}', existingArcBlock)
        .replace('{{existingEntries}}', entriesBlock)
        .replace('{{conversation}}', conversationText);

    const totalEntries = Object.values(entriesByCategory).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`${LOG_PREFIX} Generating story arc (active chat: ${recentActive.length}/${activeChat.length}, hidden: ${chat.length - activeChat.length}, entries: ${totalEntries}, existing arc: ${existingUid ? 'yes' : 'no'})...`);

    const arcText = await callLLM(systemPrompt, userPrompt, 2000, settings);
    if (!arcText || !arcText.trim()) {
        throw new Error('AI가 빈 응답을 반환했습니다.');
    }

    const cleanedArc = arcText.trim();
    const arcTitle = 'Story Arc';

    let resultUid;
    let created = false;
    let updated = false;

    if (existingUid) {
        // 기존 update
        updateEntryContent(data, existingUid, cleanedArc, settings.targetLorebook);
        setEntryPinned(data, existingUid, true);  // 항상 pinned 유지
        setMetadata(existingUid, { lastUpdated: Date.now() }, settings.targetLorebook);
        resultUid = existingUid;
        updated = true;
        console.log(`${LOG_PREFIX} Story Arc updated (uid=${existingUid})`);
    } else {
        // 새로 생성
        const entry = await createEntry(settings.targetLorebook, data, {
            title: arcTitle,
            content: cleanedArc,
            keywords: ['story_arc', 'timeline', 'narrative'],
            category: 'arc',
        });
        if (!entry) {
            throw new Error('Arc entry 생성 실패');
        }
        // 새 entry pinned 처리
        setEntryPinned(data, entry.uid, true);
        // arc는 summary도 자동 — "When to select"는 사실상 항상이지만 형식상 채워둠
        setMetadata(String(entry.uid), {
            summary: 'When to select: always (story arc — provides overall timeline and relationship context).',
        }, settings.targetLorebook);
        resultUid = String(entry.uid);
        created = true;
        console.log(`${LOG_PREFIX} Story Arc created (uid=${entry.uid})`);
    }

    await saveLorebook(settings.targetLorebook, data);
    refreshEditor();

    const tokens = await countTokens(cleanedArc);
    return { created, updated, uid: resultUid, tokens };
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
