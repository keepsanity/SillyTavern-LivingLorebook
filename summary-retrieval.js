/**
 * Summary-based Retrieval — 매 generation 직전 AI가 summary 보고 top-N 엔트리 선택
 *
 * 멀티 로어북 지원:
 *   - getEffectiveSelectionLorebooks() 가 후보 풀 결정
 *   - 벡터 prefilter는 각 컬렉션 병렬 query → union
 *   - manifest는 short id (인덱스) 기반으로 토큰 절약 + uid 충돌 회피
 *
 * 캐시: chatHash + manifestHash 일치 시 재사용
 */

import { callLLM } from './llm-service.js';
import {
    getSettings,
    getMetadata,
    getEffectiveSelectionLorebooks,
    loadAnyLorebook,
    isManagedMode,
    countTokens,
} from './lore-store.js';
import { getStringHash } from './vector-service.js';
import { buildBM25 } from './bm25.js';

const LOG_PREFIX = '[LivingLorebook]';

// ============================================================
// Cache
// ============================================================

let _selectionCache = {
    chatHash: null,
    manifestHash: null,
    selectedKeys: [],
    timestamp: 0,
};

// 마지막 inject된 본문의 토큰 수 (UI status bar용) + per-lorebook breakdown
let _lastInjection = {
    totalTokens: 0,
    entryCount: 0,
    perLorebook: {}, // { [lorebookName]: { count, tokens } }
    timestamp: 0,
    fromCache: false,
};

// 동시 호출 시 같은 Promise 공유 — 중복 LLM 호출 방지
// (precompute 백그라운드 + onGenerationBeforeWI 동시 호출 케이스)
let _selectInflight = null;

export function clearSelectionCache() {
    _selectionCache = { chatHash: null, manifestHash: null, selectedKeys: [], timestamp: 0 };
}

/**
 * 잘린 JSON에서 selected array의 완성된 items만 추출.
 * 응답이 maxTokens 한도 초과로 잘렸을 때 안전망.
 *
 * 입력 예시 (잘림):
 *   { "selected": [
 *     { "k": 0, "reason": "..." },
 *     { "k": 6, "reason": "..." },
 *     { "k": 22, "reason": "잘림—
 *
 * 출력: 처음 2개 item만 추출.
 *
 * @param {string} cleaned - markdown fence 제거된 raw text
 * @returns {Array<{k: number, reason?: string}>|null}
 */
function salvageSelectedArray(cleaned) {
    // selected 또는 다른 root key 찾기
    const rootKeys = ['selected', 'chosen', 'entries', 'selection', 'results'];
    let arrayStart = -1;
    for (const key of rootKeys) {
        const re = new RegExp(`"${key}"\\s*:\\s*\\[`, 'i');
        const m = cleaned.match(re);
        if (m) {
            arrayStart = m.index + m[0].length;
            break;
        }
    }
    if (arrayStart === -1) return null;

    // array 내용에서 완성된 객체들 추출
    const items = [];
    let i = arrayStart;
    const len = cleaned.length;

    while (i < len) {
        // 공백/콤마 스킵
        while (i < len && /[\s,]/.test(cleaned[i])) i++;
        if (i >= len) break;
        if (cleaned[i] === ']') break; // array 정상 종료

        // 객체 시작이 아니면 — number 형식 가능
        if (cleaned[i] !== '{') {
            // number array 형식? "selected": [0, 3, 7]
            const numMatch = cleaned.slice(i).match(/^(\d+)/);
            if (numMatch) {
                items.push({ k: Number(numMatch[1]) });
                i += numMatch[0].length;
                continue;
            }
            break;
        }

        // 객체 — 짝맞는 } 찾기
        let depth = 0;
        let inString = false;
        let escape = false;
        const start = i;
        let foundEnd = -1;
        for (let j = i; j < len; j++) {
            const ch = cleaned[j];
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) { foundEnd = j; break; }
            }
        }
        if (foundEnd === -1) break; // 잘림 — 더 못 파싱

        try {
            const obj = JSON.parse(cleaned.slice(start, foundEnd + 1));
            items.push(obj);
        } catch { /* 개별 객체 파싱 실패 — skip */ }
        i = foundEnd + 1;
    }

    return items.length > 0 ? items : null;
}

/**
 * 마지막 주입 토큰 정보 (UI용). selectEntries가 inject 시 업데이트.
 */
export function getLastInjectionStats() {
    return { ..._lastInjection, perLorebook: { ..._lastInjection.perLorebook } };
}

/**
 * 선택된 엔트리들의 토큰 수 측정 (비동기) + module 상태 업데이트.
 * 캐시 hit일 땐 token count도 캐시 활용 (마지막 측정값 그대로) — 매번 재계산 안 함.
 */
async function measureAndStoreInjectionStats(entries, fromCache) {
    if (fromCache && _lastInjection.entryCount === entries.length) {
        // 같은 결과 재사용 — 토큰 측정 스킵
        _lastInjection.fromCache = true;
        _lastInjection.timestamp = Date.now();
        return;
    }

    const perLorebook = {};
    let total = 0;
    for (const e of entries) {
        const tok = await countTokens(e.content || '');
        total += tok;
        if (!perLorebook[e.lorebookName]) {
            perLorebook[e.lorebookName] = { count: 0, tokens: 0 };
        }
        perLorebook[e.lorebookName].count++;
        perLorebook[e.lorebookName].tokens += tok;
    }
    _lastInjection = {
        totalTokens: total,
        entryCount: entries.length,
        perLorebook,
        timestamp: Date.now(),
        fromCache,
    };
}

// ============================================================
// Public API
// ============================================================

/**
 * 현재 chat 기준으로 주입할 엔트리 선택 (멀티 로어북).
 * 동시 호출 시 같은 Promise를 공유 — 중복 LLM 호출 방지.
 * @param {object[]} chat
 * @returns {Promise<{entries: Array<{lorebookName, uid, title, content, category, summary}>, fromCache: boolean, stage: string}>}
 */
export async function selectEntries(chat) {
    if (_selectInflight) {
        console.log(`${LOG_PREFIX} selectEntries: dedup'd (joining inflight call)`);
        return _selectInflight;
    }
    _selectInflight = _selectEntriesImpl(chat);
    try {
        return await _selectInflight;
    } finally {
        _selectInflight = null;
    }
}

async function _selectEntriesImpl(chat) {
    const settings = getSettings();
    const allLorebooks = getEffectiveSelectionLorebooks();

    // managed mode인 로어북만 — 그래야 ST 자동 활성화와 이중주입 안 남
    const lorebooks = allLorebooks.filter(name => isManagedMode(name));

    if (lorebooks.length === 0) {
        await measureAndStoreInjectionStats([], false);
        return { entries: [], fromCache: false, stage: allLorebooks.length === 0 ? 'no-lorebooks' : 'no-managed-lorebooks' };
    }

    // 모든 managed selection 로어북에서 후보 수집
    const candidates = []; // { compositeKey, lorebookName, uid, title, content, category, summary }
    for (const lbName of lorebooks) {
        const data = await loadAnyLorebook(lbName);
        if (!data || !data.entries) continue;
        for (const [uid, entry] of Object.entries(data.entries)) {
            if (entry.disable) continue;
            // constant=true (핀)인 entry는 ST WI가 항상 활성화 → AI 선택 후보 풀에서 제외
            if (entry.constant) continue;
            const meta = getMetadata(uid, lbName);
            const summary = (meta?.summary || '').trim();
            if (!summary) continue;
            candidates.push({
                compositeKey: `${lbName}::${uid}`,
                lorebookName: lbName,
                uid: String(uid),
                title: entry.comment || 'untitled',
                content: entry.content || '',
                category: meta?.category || 'fact',
                summary,
                rawEntry: entry,  // ST WI 시스템에 force-activate 시 통째 전달
            });
        }
    }

    if (candidates.length === 0) {
        await measureAndStoreInjectionStats([], false);
        return { entries: [], fromCache: false, stage: 'no-candidates' };
    }

    // 채팅 컨텍스트
    const scanDepth = settings.selectionScanDepth || 8;
    const filtered = chat.filter(m => !m.is_system && !m.is_hidden);
    const recentChat = filtered.slice(-scanDepth);
    const chatText = recentChat.map(m => {
        const name = m.is_user ? 'User' : (m.name || 'Character');
        return `${name}: ${m.mes}`;
    }).join('\n');

    if (!chatText.trim()) {
        await measureAndStoreInjectionStats([], false);
        return { entries: [], fromCache: false, stage: 'empty-chat' };
    }

    // 슬라이딩 윈도우 캐시 키 — 마지막이 assistant인 경우에만 잘라냄.
    // → swipe / regen / 답변 직후 precompute 모두 같은 키 생성 → cache hit.
    let cacheBase = filtered;
    if (filtered.length > 0) {
        const last = filtered[filtered.length - 1];
        if (last && !last.is_user) {
            cacheBase = filtered.slice(0, -1);
        }
    }
    const chatTextForCache = cacheBase.slice(-scanDepth).map(m => {
        const name = m.is_user ? 'User' : (m.name || 'Character');
        return `${name}: ${m.mes}`;
    }).join('\n') || chatText;

    const aiSelectK = settings.aiSelectK || 8;
    const prefilterK = settings.bm25PrefilterK || 30;

    // 1차 필터: BM25 텍스트 매칭 — vector 인덱스 의존성 0, 매 호출 즉석 계산
    // 토글 OFF면 완전 스킵
    let prefiltered = candidates;
    let prefilterStage = 'prefilter-disabled';
    let bm25Ms = 0;
    if (settings.bm25PrefilterEnabled && candidates.length > prefilterK) {
        const tBm = performance.now();
        try {
            const ranker = buildBM25(candidates, {
                titleOf: c => c.title || '',
                // title (가중치 ↑) + summary + keywords(meta) + content 첫 1500자
                textOf: c => {
                    const body = (c.content || '').slice(0, 1500);
                    return `${c.title || ''} ${c.summary || ''} ${body}`;
                },
            });
            const ranked = ranker.search(chatText, prefilterK);
            bm25Ms = performance.now() - tBm;
            if (ranked.length > 0) {
                prefiltered = ranked.map(r => r.entry);
                prefilterStage = `bm25 (${prefiltered.length}/${candidates.length})`;
            } else {
                // BM25 score 0 — chat에 매칭되는 단어 없음. 전체 후보 그대로
                prefilterStage = `bm25-nomatch (using all ${candidates.length})`;
            }
        } catch (err) {
            console.warn(`${LOG_PREFIX} BM25 prefilter failed, using all candidates:`, err.message);
        }
    }

    // 후보가 K 이하면 AI 호출 스킵
    if (prefiltered.length <= aiSelectK) {
        console.log(`${LOG_PREFIX} Selection: ${prefiltered.length} candidates ≤ K=${aiSelectK}, skipping AI`);
        await measureAndStoreInjectionStats(prefiltered, false);
        return {
            entries: prefiltered,
            fromCache: false,
            stage: `direct (${prefilterStage})`,
        };
    }

    // 캐시 체크 — 슬라이딩 윈도우 사용 (마지막 메시지 제외) → 메시지 1개 추가에도 hit
    const chatHash = getStringHash(chatTextForCache);
    const manifestSig = prefiltered.map(c => `${c.compositeKey}|${c.summary}`).join('\n');
    const manifestHash = getStringHash(manifestSig + '|K=' + aiSelectK);

    if (settings.selectionCacheEnabled !== false &&
        _selectionCache.chatHash === chatHash &&
        _selectionCache.manifestHash === manifestHash) {
        const keySet = new Set(_selectionCache.selectedKeys);
        const cachedEntries = prefiltered.filter(c => keySet.has(c.compositeKey));
        if (cachedEntries.length > 0) {
            console.log(`${LOG_PREFIX} Selection cache HIT (${cachedEntries.length} entries)`);
            await measureAndStoreInjectionStats(cachedEntries, true);
            return { entries: cachedEntries, fromCache: true, stage: 'cache-hit' };
        }
    }

    // AI 선택 — short id (인덱스) 기반 manifest로 토큰 절약
    const tLlm = performance.now();
    const manifest = prefiltered.map((c, i) => {
        const lbTag = lorebooks.length > 1 ? ` <${c.lorebookName}>` : '';
        return `[k:${i}]${lbTag} ${c.title}\n  ${c.summary}`;
    }).join('\n\n');

    const systemPrompt = 'You are a lorebook entry selector. Output ONLY valid JSON. No markdown fences, no explanations.';
    const userPrompt = `Given the recent roleplay context, select up to ${aiSelectK} lorebook entries whose "When to select" hints best match the current scene.

Selection rules:
1. RELEVANCE — Pick entries directly tied to what's happening RIGHT NOW (current location, present characters, ongoing actions/topics).
2. CONTINUITY — ALSO include past events that happened at the SAME LOCATION or with the SAME CHARACTERS who are present, even if not explicitly mentioned in recent chat. Characters remember their own history. (Example: if a scene is at "X bar", include past events that happened at "X bar". If character Y is in the scene, include Y's relevant past events / relationship entries.)
3. SKIP purely tangential entries — vague thematic matches without scene/character connection.

Recent conversation:
${chatText}

Available entries (k = key, optional <source>, title, "When to select" hint):
${manifest}

Output a JSON object:
{ "selected": [ { "k": <integer>, "reason": "<one short phrase>" }, ... ] }

Maximum ${aiSelectK} entries. Output ONLY the JSON object.`;

    let selectedIndices = [];
    let aiCallSucceeded = false;
    try {
        const profileOverride = settings.selectionProfileId || settings.profileId || '';
        const timeoutMs = settings.selectionTimeoutMs || 30000;
        // Promise.race로 timeout 적용. maxTokens 3000 — K=20까지 안전 마진
        const llmPromise = callLLM(systemPrompt, userPrompt, 3000, settings, profileOverride);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`AI selection timeout (${timeoutMs}ms)`)), timeoutMs),
        );
        const response = await Promise.race([llmPromise, timeoutPromise]);
        const cleaned = response.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();

        // 디버그: raw 응답 — 형식 안 맞으면 콘솔 보고 진단
        if (settings.debugSelectionResponse) {
            console.log(`${LOG_PREFIX} AI raw response:`, cleaned.length > 800 ? cleaned.substring(0, 800) + '...' : cleaned);
        }

        // 1차: 정상 JSON 파싱 시도
        // 실패하면 (truncated 등) salvage — 완성된 selected items만 추출
        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        } catch (parseErr) {
            const salvaged = salvageSelectedArray(cleaned);
            if (salvaged && salvaged.length > 0) {
                console.warn(`${LOG_PREFIX} JSON truncated — salvaged ${salvaged.length} entries from partial response`);
                parsed = { selected: salvaged };
            } else {
                throw parseErr; // salvage 실패 → catch 블록으로
            }
        }

        // robust 파싱 — 모델별 응답 형식 다양성 대응
        // 받아들이는 형식들:
        //   { "selected": [{"k": 0, ...}, ...] }            ← 정식
        //   { "selected": [0, 3, 7] }                        ← number array
        //   { "selected": ["0", "3"] }                       ← string array
        //   { "selected": [{"index": 0}, {"id": 3}] }        ← 다른 키
        //   { "chosen": [...] } / { "entries": [...] }       ← 다른 root key
        const rawList = parsed.selected ?? parsed.chosen ?? parsed.entries ?? parsed.selection ?? parsed.results ?? [];
        if (Array.isArray(rawList) && rawList.length > 0) {
            selectedIndices = rawList.map(item => {
                if (typeof item === 'number') return item;
                if (typeof item === 'string') {
                    const n = Number(item);
                    return Number.isInteger(n) ? n : NaN;
                }
                if (typeof item === 'object' && item !== null) {
                    // 흔한 key 변형들
                    for (const key of ['k', 'index', 'idx', 'id', 'i', 'entry']) {
                        if (key in item && (typeof item[key] === 'number' || typeof item[key] === 'string')) {
                            return Number(item[key]);
                        }
                    }
                }
                return NaN;
            }).filter(i => Number.isInteger(i) && i >= 0 && i < prefiltered.length)
                .slice(0, aiSelectK);
            aiCallSucceeded = selectedIndices.length > 0;
            if (!aiCallSucceeded) {
                console.warn(`${LOG_PREFIX} AI response parsed but no valid indices:`, cleaned.substring(0, 300));
            }
        } else {
            console.warn(`${LOG_PREFIX} AI response missing 'selected' array:`, cleaned.substring(0, 300));
        }
    } catch (err) {
        console.warn(`${LOG_PREFIX} AI selection failed (${err.message})`);
        // 사용자에게 가시적 알림 — silent 폴백이 컨텍스트 빠뜨리는 거 모르고 답변 받는 상황 방지
        if (typeof toastr !== 'undefined') {
            const isTimeout = String(err.message).includes('timeout');
            toastr.warning(
                isTimeout
                    ? `LL AI 선택 timeout (${(settings.selectionTimeoutMs / 1000) | 0}s) — 이전 캐시로 폴백`
                    : `LL AI 선택 실패: ${err.message} — 폴백 사용`,
                'LivingLorebook',
                { timeOut: 4000 },
            );
        }
    }

    // 폴백 우선순위:
    // 1. AI 호출 성공 → 그 결과 사용
    // 2. 이전 캐시(_selectionCache.selectedKeys)가 있으면 그것 → 적어도 컨텍스트 살아있음
    // 3. prefiltered 앞에서 K개 (관련성 없을 수 있지만 빈 prompt보단 나음)
    let selectedEntries;
    let stage;
    if (aiCallSucceeded) {
        selectedEntries = selectedIndices.map(i => prefiltered[i]).filter(Boolean);
        stage = 'ai-select';
    } else if (_selectionCache.selectedKeys && _selectionCache.selectedKeys.length > 0) {
        const keySet = new Set(_selectionCache.selectedKeys);
        selectedEntries = prefiltered.filter(c => keySet.has(c.compositeKey));
        if (selectedEntries.length === 0) {
            // 캐시 entry들이 prefiltered에 없음 (다른 lorebook scope) → 슬라이스 폴백
            selectedEntries = prefiltered.slice(0, aiSelectK);
            stage = 'fallback-slice';
        } else {
            stage = 'fallback-prev-cache';
            console.log(`${LOG_PREFIX} Using previous cache as fallback (${selectedEntries.length} entries)`);
        }
    } else {
        selectedEntries = prefiltered.slice(0, aiSelectK);
        stage = 'fallback-slice';
    }

    const selectedKeys = selectedEntries.map(e => e.compositeKey);

    // AI 호출 성공한 경우만 캐시 갱신 (실패 폴백을 캐시에 굳히지 않기)
    if (aiCallSucceeded) {
        _selectionCache = {
            chatHash,
            manifestHash,
            selectedKeys,
            timestamp: Date.now(),
        };
    }

    const llmMs = performance.now() - tLlm;
    await measureAndStoreInjectionStats(selectedEntries, false);
    console.log(`${LOG_PREFIX} Selection: ${selectedEntries.length} chosen from ${prefiltered.length} | bm25 ${bm25Ms.toFixed(0)}ms · llm ${llmMs.toFixed(0)}ms | ${stage}, ${prefilterStage}, ${lorebooks.length} lorebook${lorebooks.length > 1 ? 's' : ''}`);
    return { entries: selectedEntries, fromCache: false, stage: `${stage} (${prefilterStage})` };
}
