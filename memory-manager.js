import { l, lt } from './i18n.js';
import { operationContext, isOperationCurrent } from './lore-store.js';
import { MEMORY_POLICY, ARC_POLICY } from './memory-policy.js';
/**
 * Memory Manager — 기억 정리(organize)와 압축(compress)
 */

import { callLLM } from './llm-service.js';
import {
    getSettings,
    loadAnyLorebook, saveLorebook, refreshEditor,
    createEntry, updateEntryContent, setEntryPinned,
    getMetadata, stageMetadata,
    countTokens, isManagedMode,
} from './lore-store.js';
import { insertEntries, deleteEntries, getCollectionId, getEntryHash } from './vector-service.js';

const LOG_PREFIX = '[LivingLorebook]';

export { organizeMemories as organize } from './organize-memory.js';

// ============================================================
// Compress — AI가 RP 맥락 판단 후 오래된 엔트리 압축
// ============================================================

/**
 * 기억 압축 실행 — AI가 현재 RP 맥락을 보고 어떤 엔트리가 오래되었는지 판단
 * @returns {Promise<{compressed: number}>}
 */
export async function compress() {
    const settings = structuredClone(getSettings());
    const operation = operationContext();

    if (!settings.targetLorebook) {
        throw new Error(l('ll.1c7e28934a4ba644', "Select a target lorebook first."));
    }

    const data = await loadAnyLorebook(settings.targetLorebook);
    if (!data) {
        throw new Error(l('ll.fb9199f839943224', "Could not load the lorebook."));
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
        throw new Error(l('ll.23b16480449b3d31', "Could not parse the AI response."));
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
            stageMetadata(data, uid, { originalContent: entry.content }, settings.targetLorebook);
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
            stageMetadata(data, uid, { tier: targetTier, lastUpdated: Date.now() }, settings.targetLorebook);

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
        if (!isOperationCurrent(operation)) throw new Error(l('ll.515f3432faf2e879', "The chat changed. Saving was cancelled."));
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
    const settings = structuredClone(getSettings());
    const operation = operationContext();
    const batchSize = options.batchSize ?? 8;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const lorebookName = options.lorebookName || settings.targetLorebook;

    if (!lorebookName) {
        throw new Error(l('ll.1c7e28934a4ba644', "Select a target lorebook first."));
    }

    const data = lorebookName === settings.targetLorebook
        ? await loadAnyLorebook(settings.targetLorebook)
        : await loadAnyLorebook(lorebookName);
    if (!data) {
        throw new Error(lt('ll.5a1b112120659992')`Lorebook "${lorebookName}"could not be loaded.`);
    }

    // summary가 비어있는 활성 엔트리만 수집 (외부 로어북도 동일 — 메타 없으면 자동 생성됨)
    const targets = [];
    for (const [uid, entry] of Object.entries(data.entries || {})) {
        if (options.uids && !options.uids.includes(String(uid))) continue;
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
                    if (!batch.some(e => e.uid === uid) || !summary) {
                        failed++;
                        continue;
                    }
                    // 외부 엔트리(메타 없음)면 자동으로 LL 메타데이터 시드 생성
                    const existingMeta = getMetadata(uid, lorebookName);
                    if (!existingMeta) {
                        const ent = data.entries[uid];
                        stageMetadata(data, uid, {
                            tier: 1,
                            createdAt: Date.now(),
                            category: 'fact',
                            keywords: Array.isArray(ent?.key) && ent.key.length > 0
                                ? ent.key
                                : [ent?.comment || 'untitled'],
                            summary,
                        }, lorebookName);
                    } else {
                        stageMetadata(data, uid, { summary }, lorebookName);
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

    if (!isOperationCurrent(operation)) throw new Error(l('ll.515f3432faf2e879', "The chat changed. Saving was cancelled."));

    await saveLorebook(lorebookName, data);
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
    const settings = structuredClone(getSettings());
    const operation = operationContext();

    if (!settings.targetLorebook) {
        throw new Error(l('ll.1c7e28934a4ba644', "Select a target lorebook first."));
    }

    const data = await loadAnyLorebook(settings.targetLorebook);
    if (!data) {
        throw new Error(l('ll.fb9199f839943224', "Could not load the lorebook."));
    }

    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    if (chat.length === 0) {
        throw new Error(l('ll.6860965f9c298580', "The conversation is empty."));
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
        ? `Previous continuity brief (verify against source facts; condense old detail, preserve supported causes and unresolved consequences):\n${existingContent.replace(/^##\s+.*\r?\n/, '').trim()}\n`
        : '';

    const systemPrompt = `${MEMORY_POLICY}\n${ARC_POLICY}\nOutput ONLY the prose continuity brief.`;
    const userPrompt = settings.storyArcPrompt
        .replace('{{existingArc}}', existingArcBlock)
        .replace('{{existingEntries}}', entriesBlock)
        .replace('{{conversation}}', conversationText);

    const totalEntries = Object.values(entriesByCategory).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`${LOG_PREFIX} Generating story arc (active chat: ${recentActive.length}/${activeChat.length}, hidden: ${chat.length - activeChat.length}, entries: ${totalEntries}, existing arc: ${existingUid ? 'yes' : 'no'})...`);

    const arcText = await callLLM(systemPrompt, userPrompt, 2000, settings);
    if (!arcText || !arcText.trim()) {
        throw new Error(l('ll.ef9e91a0eb7995ec', "The AI returned an empty response."));
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
        stageMetadata(data, existingUid, { lastUpdated: Date.now() }, settings.targetLorebook);
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
            throw new Error(l('ll.bf161c083ec705ec', "Could not create the arc entry."));
        }
        // 새 entry pinned 처리
        setEntryPinned(data, entry.uid, true);
        // arc는 summary도 자동 — "When to select"는 사실상 항상이지만 형식상 채워둠
        stageMetadata(data, String(entry.uid), {
            summary: 'When to select: always (story arc — provides overall timeline and relationship context).',
        }, settings.targetLorebook);
        resultUid = String(entry.uid);
        created = true;
        console.log(`${LOG_PREFIX} Story Arc created (uid=${entry.uid})`);
    }

    if (!isOperationCurrent(operation)) throw new Error(l('ll.515f3432faf2e879', "The chat changed. Saving was cancelled."));

    await saveLorebook(settings.targetLorebook, data);
    refreshEditor();

    const tokens = await countTokens(cleanedArc);
    return { created, updated, uid: resultUid, tokens };
}
