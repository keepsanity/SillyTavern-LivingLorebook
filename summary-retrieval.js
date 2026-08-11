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
    saveSettings,
    getMetadata,
    getEffectiveSelectionLorebooks,
    loadAnyLorebook,
    isManagedMode,
    countTokens,
} from './lore-store.js';
import {
    getStringHash,
    queryMultipleCollections,
    getCollectionId,
    reindexCollection,
    getVectorSourceSignature,
    getEmbedMaxChars,
} from './vector-service.js';
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

// ============================================================
// Selection Progress Indicator — AI 호출 동안 입력창 위 플로팅 칩 + 전송버튼 펄스
// (캐시 hit / direct 경로는 즉시 끝나므로 실제 LLM 호출 구간에만 표시)
// ============================================================

let _indicatorSafetyTimer = null;

function showSelectionIndicator(timeoutMs) {
    try {
        const formSheld = document.getElementById('form_sheld');
        if (formSheld && !formSheld.querySelector('.ll-selecting-pill')) {
            const pill = document.createElement('div');
            pill.className = 'll-selecting-pill';
            pill.innerHTML = '<i class="fa-solid fa-brain fa-fade"></i> 로어 선택 중…';
            formSheld.appendChild(pill);
        }
        document.getElementById('send_but')?.classList.add('ll-selecting');
        // 안전망: timeout + 5초가 지나도 남아있으면 강제 제거
        clearTimeout(_indicatorSafetyTimer);
        _indicatorSafetyTimer = setTimeout(hideSelectionIndicator, (timeoutMs || 30000) + 5000);
    } catch { /* 표시 실패가 선택 흐름을 막지 않게 */ }
}

function hideSelectionIndicator() {
    try {
        clearTimeout(_indicatorSafetyTimer);
        _indicatorSafetyTimer = null;
        document.querySelector('#form_sheld .ll-selecting-pill')?.remove();
        document.getElementById('send_but')?.classList.remove('ll-selecting');
    } catch { /* ignore */ }
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
    let candidates = []; // { compositeKey, lorebookName, uid, title, content, category, summary }
    for (const lbName of lorebooks) {
        const data = await loadAnyLorebook(lbName);
        if (!data || !data.entries) continue;
        for (const [uid, entry] of Object.entries(data.entries)) {
            if (entry.disable) continue;
            // constant=true (핀)인 entry는 ST WI가 항상 활성화 → AI 선택 후보 풀에서 제외
            if (entry.constant) continue;
            const meta = getMetadata(uid, lbName);
            const summary = (meta?.summary || '').trim();
            // summary 없는 엔트리도 후보에 포함 — 벡터 엔진은 title+content 임베딩으로 검색 (summary 불필요).
            // AI 엔진 경로에서만 아래에서 summary 있는 것으로 필터링.
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
    const formatMessages = (msgs) => msgs.map(m => {
        const name = m.is_user ? 'User' : (m.name || 'Character');
        return `${name}: ${m.mes}`;
    }).join('\n');

    const chatText = formatMessages(filtered.slice(-scanDepth));

    // 벡터는 더 좁은 창을 쓴다.
    // 긴 창을 하나의 벡터로 뭉개면 여러 장면이 평균나서 "대화 전반의 평균 주제"를 찾게 된다
    // → 지금 장면에 맞는 로어가 흐려짐. 게다가 임베딩 비용은 입력 길이에 비례한다.
    // BM25는 반대로 넓은 창이 유리하다 (앞쪽에서 언급된 고유명사를 잡아줌, 비용도 거의 0).
    const vectorDepth = Math.max(1, Math.min(settings.vectorScanDepth || 4, scanDepth));
    const vectorText = buildRecentQueryText(filtered.slice(-vectorDepth), formatMessages, getEmbedMaxChars());

    if (!chatText.trim()) {
        await measureAndStoreInjectionStats([], false);
        return { entries: [], fromCache: false, stage: 'empty-chat' };
    }

    // === 엔진 분기 ===
    // 기본 'hybrid': BM25 + 벡터를 RRF로 융합 → 즉시 (AI/manifest/캐시 전부 스킵)
    // 'vector' = 벡터만, 'bm25' = 벡터 없이 텍스트 매칭만 (임베딩 의존성 0)
    const engine = settings.selectionEngine || 'hybrid';
    if (engine !== 'ai') {
        return await _selectFast(candidates, { bm25: chatText, vector: vectorText }, settings, lorebooks, engine);
    }

    // 이하 'ai' 엔진 — manifest 힌트가 필요하므로 summary 있는 후보만 사용
    candidates = candidates.filter(c => c.summary);
    if (candidates.length === 0) {
        await measureAndStoreInjectionStats([], false);
        return { entries: [], fromCache: false, stage: 'no-candidates-ai (no summaries)' };
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
    showSelectionIndicator(settings.selectionTimeoutMs || 30000);
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
    } finally {
        hideSelectionIndicator();
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

// ============================================================
// Fast engine — BM25 + 벡터 하이브리드 (RRF 융합). AI 호출 없음.
// ============================================================

/**
 * ST의 /api/vector/query는 유사도 점수를 안 돌려주고 hash/metadata만 준다
 * (src/endpoints/vectors.js queryCollection — score는 threshold 필터에만 쓰이고 버려짐).
 * 그래서 점수 대신 **순위**로 융합한다 → RRF(Reciprocal Rank Fusion).
 * 덕분에 ST 코어를 패치할 필요가 없고 ST 업데이트에도 안 깨진다.
 *
 * score(entry) = wV/(K + rank_vector) + wB/(K + rank_bm25)
 * 두 목록에 다 오른 엔트리가 자연히 위로 올라온다.
 */
const RRF_K = 60;

/** 소스 불일치 경고를 매 생성마다 띄우지 않기 위한 1회 플래그 */
let _sigWarned = null;

/**
 * BM25 랭커 생성 — 벡터 경로와 폴백 경로가 같은 문서 표현을 쓰도록 한 곳에 모음.
 */
function buildCandidateRanker(candidates) {
    return buildBM25(candidates, {
        titleOf: c => c.title || '',
        textOf: c => `${c.title || ''} ${c.summary || ''} ${(c.content || '').slice(0, 1500)}`,
    });
}

/**
 * 임베딩 예산에 맞춰 **최신 메시지부터 역순으로** 담아 벡터 쿼리 텍스트를 만든다.
 *
 * 그냥 긴 텍스트를 넘기면 vector-service가 `slice(0, max)`로 앞을 남기는데,
 * 채팅은 뒤쪽이 최신이라 정작 방금 일어난 일이 통째로 잘려나간다.
 * 메시지 경계에서 끊어 담고, 마지막에 시간순으로 되돌린다.
 *
 * @param {object[]} msgs - 시간순 메시지 (오래된 것 → 최신)
 * @param {(msgs: object[]) => string} format - 메시지 배열 → 텍스트
 * @param {number} maxChars - 임베딩 입력 한도
 */
function buildRecentQueryText(msgs, format, maxChars) {
    const picked = [];
    let used = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
        const line = format([msgs[i]]);
        const cost = line.length + (picked.length > 0 ? 1 : 0);  // 개행 1자
        if (used + cost > maxChars) {
            // 최신 메시지 하나만으로도 예산 초과 → 그 메시지의 **뒷부분**을 살린다
            if (picked.length === 0) picked.push(line.slice(-maxChars));
            break;
        }
        picked.push(line);
        used += cost;
    }
    return picked.reverse().join('\n');
}

/**
 * 벡터 컬렉션들을 한 번에 query → 후보별 순위(1-based) 맵.
 * 컬렉션마다 순위가 따로 매겨지지만 RRF는 그 상태로도 잘 동작한다.
 * @param {string} queryText - 벡터 전용 검색 텍스트 (BM25보다 좁은 창)
 * @returns {Promise<{ranks: Map<string, number>, ms: number, note: string}>}
 */
async function _vectorRanks(candidates, queryText, settings, lorebooks) {
    const topK = settings.vectorSelectTopK || 50;
    const threshold = typeof settings.vectorScoreThreshold === 'number' ? settings.vectorScoreThreshold : 0.6;

    // 임베딩 소스가 재색인 시점과 다르면 벡터 차원이 안 맞아 검색이 무의미/에러 →
    // 조용히 틀린 결과를 주느니 벡터를 끄고 BM25로만 간다.
    const currentSig = getVectorSourceSignature();
    const indexedSig = settings.vectorIndexSignature;
    if (indexedSig && indexedSig !== currentSig) {
        if (_sigWarned !== currentSig) {
            _sigWarned = currentSig;
            console.warn(`${LOG_PREFIX} 임베딩 소스 변경 감지: 인덱스=${indexedSig}, 현재=${currentSig} → 벡터 경로 중단. 재색인 필요.`);
            // 생성 직전 경로라 여기서 던지면 답변이 막힘 — 알림 실패는 삼킨다
            globalThis.toastr?.warning?.('임베딩 소스가 바뀌었습니다. LL 설정에서 벡터 재색인을 실행하세요.', 'LivingLorebook', { timeOut: 8000 });
        }
        return { ranks: new Map(), ms: 0, note: 'source-changed' };
    }

    // 해시(uid only) → candidate. uid는 컬렉션 내에서만 유일하므로 로어북 스코프로 키 구성
    const byKey = new Map();
    for (const c of candidates) {
        byKey.set(`${c.lorebookName}:${getStringHash(String(c.uid))}`, c);
    }

    // collectionId → 로어북 이름 (응답이 collectionId로 그룹지어 오므로 되돌려야 함)
    const idToLb = new Map(lorebooks.map(lb => [getCollectionId(lb), lb]));

    const t0 = performance.now();
    const ranks = new Map();
    let note = '';
    try {
        // 컬렉션마다 /query를 부르면 검색 텍스트를 매번 다시 임베딩한다 → 로어북 수만큼 느려짐.
        // query-multi는 임베딩 1회 + 컬렉션을 가로질러 전역 정렬 후 topK 컷.
        const grouped = await queryMultipleCollections([...idToLb.keys()], queryText, topK, threshold);
        for (const [collectionId, res] of Object.entries(grouped || {})) {
            const lbName = idToLb.get(collectionId);
            if (!lbName) continue;
            const hashes = res?.hashes || [];
            // 그룹 안의 순서는 전역 정렬 순서를 보존한다. 다만 점수를 안 주므로
            // 그룹을 가로지르는 정확한 전역 순위는 복원 불가 → 그룹 내 순위를 쓴다.
            let rank = 0;
            for (const hash of hashes) {
                const cand = byKey.get(`${lbName}:${hash}`);
                if (!cand) continue;   // 인덱스에만 남은 고아 해시 (삭제된 엔트리 등)
                rank++;
                if (!ranks.has(cand.compositeKey) || ranks.get(cand.compositeKey) > rank) {
                    ranks.set(cand.compositeKey, rank);
                }
            }
        }
    } catch (err) {
        // 한 번에 조회하므로 실패는 전부 아니면 전무 — BM25 폴백에 맡긴다
        note = 'query 실패';
        console.warn(`${LOG_PREFIX} vector query-multi failed: ${err.message}`);
    }

    // 0개인데 에러도 아니면 "이번 턴엔 의미상 가까운 게 없다"는 정상 결과 — 실패와 구분해서 표시
    if (ranks.size === 0 && !note) note = `유사도 ${threshold} 미만`;

    return { ranks, ms: performance.now() - t0, note, threshold };
}

/**
 * 빠른 선택 — 벡터/BM25/둘 다(RRF)로 후보를 추려 반환. AI 호출 없음.
 * @param {Array} candidates - summary 무관 전체 후보 (constant/disable 제외됨)
 * @param {{bm25: string, vector: string}} queries - 엔진별 검색 텍스트 (벡터는 더 좁은 창)
 * @param {object} settings
 * @param {string[]} lorebooks - managed 로어북 이름들
 * @param {'hybrid'|'vector'|'bm25'} engine
 */
async function _selectFast(candidates, queries, settings, lorebooks, engine) {
    const maxK = settings.vectorSelectMaxK || 12;
    // 0이면 컷오프 끔(기본) — RRF 점수는 순위 기반이라 절대 유사도처럼 해석되지 않음.
    // 올리면 1등 대비 낮은 꼬리를 잘라낸다.
    const ratio = typeof settings.vectorCutoffRatio === 'number' ? settings.vectorCutoffRatio : 0;
    const wV = typeof settings.hybridVectorWeight === 'number' ? settings.hybridVectorWeight : 1;
    const wB = typeof settings.hybridBm25Weight === 'number' ? settings.hybridBm25Weight : 1;

    const wantVector = engine !== 'bm25';
    const wantBm25 = engine !== 'vector';

    // --- 1. 벡터 순위 ---
    let vRanks = new Map();
    let vecMs = 0;
    let vecNote = '';
    let vecThreshold = null;
    if (wantVector) {
        const r = await _vectorRanks(candidates, queries.vector, settings, lorebooks);
        vRanks = r.ranks;
        vecMs = r.ms;
        vecNote = r.note;
        vecThreshold = r.threshold;
    }

    // --- 2. BM25 순위 ---
    // hybrid에서 벡터가 아무것도 못 건졌으면(인덱스 없음/소스 변경/서버 오류) BM25로 자동 폴백.
    const bm25Needed = wantBm25 || vRanks.size === 0;
    let bRanks = new Map();
    let bmMs = 0;
    if (bm25Needed) {
        const t0 = performance.now();
        const ranker = buildCandidateRanker(candidates);
        // 융합 전이므로 maxK보다 넉넉히 뽑아둔다 (벡터가 못 본 걸 BM25가 끌어올릴 여지)
        const ranked = ranker.search(queries.bm25, Math.max(maxK * 3, settings.bm25PrefilterK || 30));
        ranked.forEach((r, i) => bRanks.set(r.entry.compositeKey, i + 1));
        bmMs = performance.now() - t0;
    }

    if (vRanks.size === 0 && bRanks.size === 0) {
        await measureAndStoreInjectionStats([], false);
        const why = wantVector && vecNote ? vecNote : 'no-match';
        console.warn(`${LOG_PREFIX} Fast(${engine}): 매칭 0개 (${why})`);
        return { entries: [], fromCache: false, stage: `${engine}-empty (${why})` };
    }

    // --- 3. RRF 융합 ---
    const byKey = new Map(candidates.map(c => [c.compositeKey, c]));
    const fused = new Map(); // key → { candidate, score, v, b }
    const add = (key, rank, weight, which) => {
        const cand = byKey.get(key);
        if (!cand) return;
        const cur = fused.get(key) || { candidate: cand, score: 0, v: null, b: null };
        cur.score += weight / (RRF_K + rank);
        cur[which] = rank;
        fused.set(key, cur);
    };
    for (const [key, rank] of vRanks) add(key, rank, wV, 'v');
    for (const [key, rank] of bRanks) add(key, rank, wB, 'b');

    const scored = [...fused.values()].sort((a, b) => b.score - a.score);

    // --- 4. 컷오프 + 상한 ---
    let kept = scored;
    if (ratio > 0) {
        const cutoff = scored[0].score * ratio;
        kept = scored.filter(s => s.score >= cutoff);
    }
    kept = kept.slice(0, maxK);
    if (kept.length === 0) kept = scored.slice(0, 1); // 안전망: 최소 1개

    const entries = kept.map(s => s.candidate);
    await measureAndStoreInjectionStats(entries, false);

    const both = kept.filter(s => s.v != null && s.b != null).length;
    // 벡터를 쓰기로 했는데 하나도 못 건졌으면 BM25 폴백이 실제로 동작한 것 — 로그에 드러나게
    const fellBack = wantVector && vRanks.size === 0;
    const label = fellBack
        ? `${engine}→bm25${vecNote ? ' (' + vecNote + ')' : ''}`
        : engine;
    console.log(
        `${LOG_PREFIX} ${label}: ${entries.length} kept / ${scored.length} fused ` +
        `(vector ${vRanks.size}${vecThreshold != null ? `@${vecThreshold}` : ''}, bm25 ${bRanks.size}, ` +
        `양쪽 ${both}, maxK ${maxK}${ratio > 0 ? `, ratio ${ratio}` : ''}) ` +
        `vec ${vecMs.toFixed(0)}ms/${queries.vector.length}자 · bm25 ${bmMs.toFixed(0)}ms/${queries.bm25.length}자, ` +
        `${lorebooks.length} lorebook${lorebooks.length > 1 ? 's' : ''}`,
    );
    return { entries, fromCache: false, stage: `${label} (${entries.length}/${scored.length})` };
}

/**
 * 로어북 "지문" — 이 로어북이 지금 어떤 상태로 색인돼야 하는지 나타내는 값.
 * `임베더 | 엔트리수 | 내용해시` 로, 임베더가 바뀌거나 **엔트리가 추가/삭제/수정**되면 값이 달라진다.
 * → 예전처럼 임베더만 보지 않고 내용 변화까지 감지 → 리빙 로어북에서 stale을 안 놓친다.
 * (색인 대상 = disable/constant 제외 — 후보 풀·재색인과 동일 기준)
 */
function lorebookFingerprint(data, embedderSig) {
    let count = 0;
    let acc = 0;
    for (const [uid, entry] of Object.entries(data?.entries || {})) {
        if (entry.disable || entry.constant) continue;
        count++;
        acc = (acc * 31 + getStringHash(`${uid}:${entry.content || ''}`)) | 0;
    }
    return `${embedderSig}|${count}|${acc}`;
}

/**
 * 로어북 하나를 벡터 재색인 + per-lorebook 지문 기록.
 * @param {string} lbName
 * @param {{data?: object, fingerprint?: string}} [opts] - 이미 로드/계산했으면 재사용(중복 로드 회피)
 * @returns {Promise<number>} 실제 색인된 엔트리 수
 */
async function reindexOneLorebook(lbName, opts = {}) {
    const data = opts.data || await loadAnyLorebook(lbName);
    if (!data || !data.entries) return 0;
    const entries = [];
    for (const [uid, entry] of Object.entries(data.entries)) {
        if (entry.disable || entry.constant) continue; // 후보 풀과 동일 기준
        entries.push({ uid: String(uid), content: entry.content || '', title: entry.comment || '' });
    }

    const settings = getSettings();
    // shared-ref 회피: DEFAULT에 안 넣고 여기서 own 프로퍼티로 lazy 생성
    if (!settings.vectorIndexByLorebook || typeof settings.vectorIndexByLorebook !== 'object') {
        settings.vectorIndexByLorebook = {};
    }
    const fp = opts.fingerprint || lorebookFingerprint(data, getVectorSourceSignature());

    // 색인할 엔트리가 0개여도 지문은 기록한다 — 안 그러면 이 로어북이 영영 stale로 남아
    // 채팅 바꿀 때마다 매번 재검사 대상이 된다(수렴 안 함).
    if (entries.length === 0) {
        settings.vectorIndexByLorebook[lbName] = fp;
        saveSettings();
        return 0;
    }

    await reindexCollection(getCollectionId(lbName), entries);
    settings.vectorIndexByLorebook[lbName] = fp;

    console.log(`${LOG_PREFIX} Reindexed ${entries.length} entries in ${getCollectionId(lbName)}`);
    return entries.length;
}

/**
 * managed 로어북 전체 재색인 — 벡터 컬렉션 purge 후 현재 엔트리로 재삽입.
 * 해시 스킴 변경 / 내용 수정 / 임베딩 소스 변경으로 stale해진 임베딩을 갱신. UI 버튼에서 호출.
 * @returns {Promise<{lorebooks: number, entries: number, signature: string}>}
 */
export async function reindexManagedLorebooks() {
    const lorebooks = getEffectiveSelectionLorebooks().filter(name => isManagedMode(name));
    const signature = getVectorSourceSignature();
    let totalEntries = 0;
    for (const lbName of lorebooks) {
        totalEntries += await reindexOneLorebook(lbName); // 지문은 내부에서 계산·저장
    }

    // 이 인덱스가 어떤 임베딩 소스로 만들어졌는지 기록 → 이후 소스가 바뀌면 감지 가능.
    // 색인된 게 하나도 없으면(managed 로어북 없음 등) 기록하지 않는다 —
    // 안 그러면 "인덱스 일치"가 떠서 정상인 것처럼 보인다.
    if (totalEntries > 0) {
        const settings = getSettings();
        settings.vectorIndexSignature = signature;
        settings.vectorIndexCount = totalEntries;   // 몇 개가 실제로 들어갔는지 — 상태 표시가 거짓말 못 하게
        settings.vectorIndexAt = Date.now();
        saveSettings();
        _sigWarned = null;
    }

    return { lorebooks: lorebooks.length, entries: totalEntries, signature };
}

/**
 * 채팅 열 때 호출 — managed 로어북 중 "지문이 바뀐(= 아직 색인 안 됐거나 내용이 변한)" 것만 조용히 재색인.
 * 지문 = 임베더 + 엔트리수 + 내용해시 → 임베더가 같아도 엔트리가 추가/수정되면 재색인된다.
 * 지문이 같은 로어북은 건드리지 않음(비용 0).
 * 벡터를 쓰는 엔진(hybrid) + 마스터 ON일 때만 동작.
 * @returns {Promise<{reindexed: string[], entries: number} | null>} null = 할 일 없었음
 */
export async function autoReindexStaleLorebooks() {
    const settings = getSettings();
    if (!settings.summarySelectionEnabled) return null;
    if ((settings.selectionEngine || 'hybrid') !== 'hybrid') return null; // 벡터 쓰는 엔진만

    const signature = getVectorSourceSignature();
    const map = (settings.vectorIndexByLorebook && typeof settings.vectorIndexByLorebook === 'object')
        ? settings.vectorIndexByLorebook : {};

    const managed = getEffectiveSelectionLorebooks().filter(name => isManagedMode(name));
    if (managed.length === 0) return null;

    // 각 로어북의 현재 지문 계산 → 저장된 지문과 다르면 재색인 (1회 로드, stale이면 그 data 재사용)
    const work = []; // { lbName, data, fingerprint }
    for (const lbName of managed) {
        const data = await loadAnyLorebook(lbName);
        const fp = lorebookFingerprint(data, signature);
        if (map[lbName] !== fp) work.push({ lbName, data, fingerprint: fp });
    }
    if (work.length === 0) return null;

    let totalEntries = 0;
    const reindexed = [];
    for (const { lbName, data, fingerprint } of work) {
        const n = await reindexOneLorebook(lbName, { data, fingerprint });
        if (n > 0) { totalEntries += n; reindexed.push(lbName); }
    }
    if (reindexed.length === 0) return null;

    // 글로벌 상태창 표시도 최신으로 (상태 "일치" 판정용)
    settings.vectorIndexSignature = signature;
    settings.vectorIndexCount = totalEntries;
    settings.vectorIndexAt = Date.now();
    saveSettings();
    _sigWarned = null;
    return { reindexed, entries: totalEntries };
}
