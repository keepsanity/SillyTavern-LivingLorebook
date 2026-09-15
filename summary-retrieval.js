import { rankMemories, fitMemoryBudget } from './retrieval-policy.js';
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
    getSettings, operationContext, isOperationCurrent,
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
const _selectInflight = new Map();
let _selectionEpoch = 0;
let _lastTrace = { entries: [], omitted: [], stage: '', actual: null };
export function getSelectionTrace() { return structuredClone(_lastTrace); }
export function recordActivatedEntries(entries) {
    const keys = new Set(entries.map(e => `${e.world}::${e.uid}`));
    _lastTrace.actual = _lastTrace.entries.filter(e => keys.has(e.compositeKey));
}

export function clearSelectionCache() {
    _selectionEpoch++;
    _lastTrace = { entries: [], omitted: [], stage: '', actual: null };
    _lastInjection = { totalTokens: 0, entryCount: 0, perLorebook: {}, timestamp: 0, fromCache: false };
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
    const op = operationContext();
    const epoch = _selectionEpoch;
    const snapshot = structuredClone(chat);
    const settings = structuredClone(getSettings());
    const key = JSON.stringify([op, epoch, snapshot.slice(-(settings.selectionScanDepth || 8)), getEffectiveSelectionLorebooks(), settings.selectionEngine]);
    if (_selectInflight.has(key)) return _selectInflight.get(key);
    const run = (async () => {
        if (settings.selectionEngine === 'hybrid') {
            try { await autoReindexStaleLorebooks(); }
            catch (err) { console.warn('[LivingLorebook] 재색인 실패; 검색 폴백 사용', err); }
        }
        if (epoch !== _selectionEpoch || !isOperationCurrent(op)) return { entries: [], stage: 'stale-discarded', fromCache: false };
        const result = await _selectEntriesImpl(snapshot);
        if (epoch !== _selectionEpoch || !isOperationCurrent(op)) return { entries: [], stage: 'stale-discarded', fromCache: false };
        const fitted = await fitMemoryBudget(result.entries, settings.selectionTokenBudget || 0, countTokens);
        if (epoch !== _selectionEpoch || !isOperationCurrent(op)) return { entries: [], stage: 'stale-discarded', fromCache: false };
        const perLorebook = {};
        for (const e of fitted.entries) {
            perLorebook[e.lorebookName] ||= { count: 0, tokens: 0 };
            perLorebook[e.lorebookName].count++;
            perLorebook[e.lorebookName].tokens += e.tokens;
        }
        _lastInjection = { totalTokens: fitted.tokens, entryCount: fitted.entries.length, perLorebook, timestamp: Date.now(), fromCache: result.fromCache };
        _lastTrace = { entries: fitted.entries.map(e => ({ compositeKey: e.compositeKey, title: e.title, lorebookName: e.lorebookName, reason: e.reason || 'AI 선택', tokens: e.tokens })), omitted: fitted.omitted, stage: result.stage, actual: null };
        return { ...result, entries: fitted.entries };
    })();
    _selectInflight.set(key, run);
    try { return await run; } finally { _selectInflight.delete(key); }
}

/**
 * ST의 WI 후보 목록에 managed 로어북 엔트리를 끼워 넣는다. (WORLDINFO_ENTRIES_LOADED 핸들러)
 *
 * ⚠️ 이게 없으면 LL은 아무것도 주입하지 못한다:
 * ST는 global/character/chat/persona 4곳에 **바인딩된** 로어북만 순회하고,
 * WORLDINFO_FORCE_ACTIVATE는 "이미 순회 중인 엔트리를 활성으로 승격"시킬 뿐 새로 추가하지 않는다.
 * LL의 target은 ST가 모르는 자체 키(ll_target_lorebook)라 순회 대상이 아니었다 → force-activate가 전부 무시됨.
 * 여기서 chatLore 배열에 push하면(emit 직후 ST가 그 배열로 목록을 조립하므로) 순회 대상이 된다.
 *
 * managed 로어북은 키워드가 비어 있어 스스로 활성화되지 않고, LL이 고른 것만 force-activate로 켜진다.
 * @param {{globalLore: object[], characterLore: object[], chatLore: object[], personaLore: object[]}} lore
 */
export async function injectManagedEntriesIntoWI(lore) {
    const settings = getSettings();
    if (!settings.enabled || !settings.summarySelectionEnabled) return;

    const books = getEffectiveSelectionLorebooks().filter(name => isManagedMode(name));
    if (books.length === 0) return;
    const orderByKey = new Map(_lastTrace.entries.map((e, i) => [e.compositeKey, 100000 - i]));

    // 이미 ST가 들고 있는 것(사용자가 별도로 바인딩해둔 경우)과 중복 방지
    const seen = new Set();
    for (const arr of [lore.globalLore, lore.characterLore, lore.chatLore, lore.personaLore]) {
        if (!Array.isArray(arr)) continue;
        for (let i = 0; i < arr.length; i++) {
            const e = arr[i];
            seen.add(`${e.world}.${e.uid}`);
            if (books.includes(e.world)) arr[i] = { ...e, order: orderByKey.get(`${e.world}::${e.uid}`) ?? e.order, key: [], keysecondary: [], vectorized: false, constant: false };
        }
    }

    let added = 0;
    for (const lbName of books) {
        const data = await loadAnyLorebook(lbName);
        if (!data?.entries) continue;
        for (const [uid, entry] of Object.entries(data.entries)) {
            if (entry.disable) continue;
            const key = `${lbName}.${entry.uid ?? uid}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const { uid: _uid, ...rest } = entry;
            // 키워드는 비워서 ST가 **자체 발동**시키지 못하게 한다 — managed 모드의 계약은 "LL이 통제".
            // (managed 전환은 LL 메타데이터가 있는 엔트리의 키워드만 지운다. 외부에서 추가된 엔트리는
            //  키워드가 살아있어서, ST 순회 대상이 된 지금은 엉뚱한 엔트리가 키워드로 튀어나올 수 있다.)
            // constant(핀)는 그대로 둬서 항상 활성 유지.
            lore.chatLore.push({ uid: entry.uid ?? uid, world: lbName, ...rest, order: orderByKey.get(`${lbName}::${entry.uid ?? uid}`) ?? entry.order, key: [], keysecondary: [], vectorized: false, constant: false });
            added++;
        }
    }
    if (added > 0) {
        console.log(`${LOG_PREFIX} WI 후보에 managed 엔트리 ${added}개 주입 (books: ${books.join(', ')})`);
    }
}

/**
 * managed 로어북의 핀(constant) 엔트리 수집 — **항상 주입 대상**.
 *
 * ⚠️ 예전엔 "constant면 ST WI가 알아서 활성화한다"고 보고 후보에서 빼기만 했는데, 그건 로어북이
 * ST에 바인딩(캐릭터/채팅/페르소나/글로벌)돼 있을 때만 참이다. LL의 target은 ST가 모르는
 * 자체 키(chat_metadata.ll_target_lorebook)라서, ST에 안 붙여둔 로어북의 핀 엔트리는
 * **아무도 주입해주지 않는다** → LL이 직접 force-activate 한다.
 */
async function collectPinnedEntries() {
    const lorebooks = getEffectiveSelectionLorebooks().filter(name => isManagedMode(name));
    const out = [];
    for (const lbName of lorebooks) {
        const data = await loadAnyLorebook(lbName);
        if (!data?.entries) continue;
        for (const [uid, entry] of Object.entries(data.entries)) {
            if (entry.disable || !entry.constant) continue;
            out.push({
                compositeKey: `${lbName}::${uid}`,
                lorebookName: lbName,
                uid: String(uid),
                title: entry.comment || 'untitled',
                content: entry.content || '',
                category: getMetadata(uid, lbName)?.category || 'fact',
                summary: '', reason: '고정 기억',
                rawEntry: entry,
            });
        }
    }
    return out;
}

/** 선택 결과 + 핀 엔트리 병합 (핀은 선택 엔진/maxK와 무관하게 항상 들어간다) */
async function _selectEntriesImpl(chat) {
    const result = await _selectCore(chat);
    const pinned = await collectPinnedEntries();
    if (pinned.length === 0) return result;

    const selected = Array.isArray(result.entries) ? result.entries : [];
    const seen = new Set(selected.map(e => e.compositeKey));
    const merged = [...pinned.filter(p => !seen.has(p.compositeKey)), ...selected];

    // 통계는 병합된 최종 주입분 기준으로 다시 기록 (상태바가 실제 주입량을 말하게)
    return { ...result, entries: merged, stage: `${result.stage} +pinned${pinned.length}` };
}

async function _selectCore(chat) {
    const settings = structuredClone(getSettings());
    const allLorebooks = getEffectiveSelectionLorebooks();

    // managed mode인 로어북만 — 그래야 ST 자동 활성화와 이중주입 안 남
    const lorebooks = allLorebooks.filter(name => isManagedMode(name));

    if (lorebooks.length === 0) {
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
                aliases: Array.isArray(meta?.aliases) ? meta.aliases : [],
                live: !!meta?.live, openLoop: !!meta?.openLoop,
                rawEntry: { ...entry, key: entry.key?.length ? entry.key : (meta?.keywords || []) },  // ST WI 시스템에 force-activate 시 통째 전달
            });
        }
    }

    if (candidates.length === 0) {
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
        return { entries: [], fromCache: false, stage: 'no-candidates-ai (no summaries)' };
    }

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
                // title (가중치 ↑) + summary + content 전체 (자르지 않음 — 위 _selectFast와 동일 이유)
                textOf: c => `${c.title || ''} ${c.summary || ''} ${c.content || ''}`,
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

    // 캐시 체크 — 슬라이딩 윈도우 사용 (마지막 메시지 제외) → 메시지 1개 추가에도 hit
    const chatHash = getStringHash(chatText);
    const manifestSig = prefiltered.map(c => `${c.compositeKey}|${c.title}|${c.content}|${c.summary}`).join('\n');
    const manifestHash = getStringHash(manifestSig + '|K=' + aiSelectK);

    if (settings.selectionCacheEnabled !== false &&
        _selectionCache.chatHash === chatHash &&
        _selectionCache.manifestHash === manifestHash) {
        const keySet = new Set(_selectionCache.selectedKeys);
        const cachedEntries = prefiltered.filter(c => keySet.has(c.compositeKey));
        if (cachedEntries.length >= 0) {
            console.log(`${LOG_PREFIX} Selection cache HIT (${cachedEntries.length} entries)`);
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
        const rawList = parsed.selected ?? parsed.chosen ?? parsed.entries ?? parsed.selection ?? parsed.results;
        if (Array.isArray(rawList)) {
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
            selectedIndices = [...new Set(selectedIndices)];
            aiCallSucceeded = rawList.length === 0 || selectedIndices.length > 0;
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
    } else {
        const fallback = await _selectFast(candidates, { bm25: chatText, vector: vectorText }, settings, lorebooks, 'bm25');
        selectedEntries = fallback.entries.slice(0, aiSelectK);
        stage = 'fallback-bm25';
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



/** 소스 불일치 경고를 매 생성마다 띄우지 않기 위한 1회 플래그 */
let _sigWarned = null;

/**
 * BM25 랭커 생성 — 벡터 경로와 폴백 경로가 같은 문서 표현을 쓰도록 한 곳에 모음.
 */
function buildCandidateRanker(candidates) {
    return buildBM25(candidates, {
        titleOf: c => c.title || '',
        // 본문을 자르지 않는다. 실측상 컷 유무의 비용 차이가 오차 범위(101후보/13만자, 5~8ms)인데,
        // 자르면 긴 사건 엔트리의 뒷부분이 통째로 검색에서 빠진다(이 로어북 기준 본문의 24%).
        textOf: c => `${c.title || ''} ${c.summary || ''} ${c.content || ''}`,
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
    for (const book of lorebooks) {
        const data = await loadAnyLorebook(book);
        if (settings.vectorIndexByLorebook?.[book] !== lorebookFingerprint(data, currentSig)) {
            return { ranks: new Map(), ms: 0, note: 'stale-index' };
        }
    }
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

    // 컬렉션마다 /query를 부르면 검색 텍스트를 매번 다시 임베딩한다 → 로어북 수만큼 느려짐.
    // query-multi는 임베딩 1회 + 컬렉션을 가로질러 전역 정렬 후 topK 컷.
    const runQuery = async (th) => {
        const grouped = await queryMultipleCollections([...idToLb.keys()], queryText, topK, th);
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
    };

    try {
        // 0개가 나와도 임계값을 낮춰 재시도하지 않는다.
        // 벡터가 0개인 건 고장이 아니라 "이 턴엔 의미상 가까운 게 없다"는 답이다.
        // 낮춰서 억지로 뽑으면 무관한 엔트리가 관련 있는 척 들어온다 —
        // 실측: 무관한 턴은 전 항목 0.38~0.58인데 0.45로 낮추자 33개가 통과해 상한을 다 채웠다.
        // (관련 있는 턴은 0.69~0.75가 나오므로 기본 0.6이 두 경우를 정확히 가른다.)
        await runQuery(threshold);
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
/**
 * 엔트리 자신의 키워드가 대화에 **문자 그대로** 나오는지 검사.
 *
 * 왜 필요한가: managed 모드는 ST가 키워드로 자체 발동하지 못하게 `key`를 지우고 넘긴다.
 * 그래서 "Sabrina" 같은 고유명사가 대화에 계속 나와도 ST는 못 켜고, LL의 하이브리드 점수는
 * 상대 컷오프(양쪽 엔진 동의)에 걸려 잘려나간다 — BM25는 잡는데 벡터가 못 잡는 전형적 케이스.
 * 이름이 그대로 찍혀 있으면 그건 가장 강한 신호다. 점수 경쟁에서 빼주고 자리를 보장한다.
 *
 * ST의 selective 시맨틱(보조 키워드 + selectiveLogic)을 그대로 따른다.
 * @returns {Set<string>} 매칭된 candidate의 compositeKey
 */
function matchKeywordEntries(candidates, scanText) {
    const hits = new Set();
    if (!scanText) return hits;
    const haystack = scanText.toLowerCase();

    // `/pattern/flags` 형식은 정규식으로, 그 외는 리터럴로.
    // 영문/숫자만인 키는 단어경계를 요구한다 ("River"가 "Rivers"에 걸리지 않게).
    // 한글엔 단어경계 개념이 없으므로 부분일치 그대로 둔다.
    const testKey = (key) => {
        const k = String(key || '').trim();
        if (k.length < 2) return false;   // 1글자 키는 오탐이 너무 많다

        const re = k.match(/^\/(.+)\/([gimsuy]*)$/);
        if (re) {
            try { return new RegExp(re[1], re[2].replace('g', '')).test(scanText); } catch { return false; }
        }

        const lower = k.toLowerCase();
        // 순수 ASCII 키는 단어경계를 요구 ("River"가 "Rivers"에 안 걸리게).
        // 한글/CJK엔 단어경계 개념이 없으므로 부분일치 그대로.
        if (!/[^\x00-\x7f]/.test(k)) {
            try {
                const esc = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`(^|[^\\w])${esc}([^\\w]|$)`, 'i').test(haystack);
            } catch { return haystack.includes(lower); }
        }
        return haystack.includes(lower);
    };

    for (const c of candidates) {
        const e = c.rawEntry || {};
        const keys = Array.isArray(e.key) ? e.key : [];
        if (keys.length === 0) continue;
        if (!keys.some(testKey)) continue;

        const sec = Array.isArray(e.keysecondary) ? e.keysecondary.filter(k => String(k || '').trim()) : [];
        if (e.selective && sec.length > 0) {
            const matched = sec.filter(testKey).length;
            const logic = Number(e.selectiveLogic) || 0;   // AND_ANY=0, NOT_ALL=1, NOT_ANY=2, AND_ALL=3
            const ok = logic === 1 ? matched < sec.length
                : logic === 2 ? matched === 0
                : logic === 3 ? matched === sec.length
                : matched > 0;                              // AND_ANY
            if (!ok) continue;
        }
        hits.add(c.compositeKey);
    }
    return hits;
}

/** 로어북별 채택 수 — "왜 메인 로어북만 들어가지?"를 로그만 보고 판단할 수 있게. */
function perBookLabel(entries, lorebooks) {
    const count = new Map(lorebooks.map(lb => [lb, 0]));
    for (const e of entries) count.set(e.lorebookName, (count.get(e.lorebookName) || 0) + 1);
    return [...count.entries()].map(([lb, n]) => `${lb}: ${n}개`).join(' · ');
}

async function _selectFast(candidates, queries, settings, lorebooks, engine) {
    const maxK = Math.max(1, settings.vectorSelectMaxK || 12);
    const kwHits = settings.keywordMatchEnabled !== false ? matchKeywordEntries(candidates, queries.bm25) : new Set();
    const vector = engine === 'bm25' ? { ranks: new Map(), note: 'bm25-only' }
        : await _vectorRanks(candidates, queries.vector, settings, lorebooks);
    const ranked = buildCandidateRanker(candidates).search(queries.bm25, Math.max(maxK * 3, settings.bm25PrefilterK || 30));
    const ordered = rankMemories(candidates, {
        vectorRanks: vector.ranks, bm25Results: ranked, keywordHits: kwHits, text: queries.bm25, recentText: queries.vector, settings,
        vectorUnavailable: engine === 'bm25' || vector.note === 'source-changed' || vector.note === 'query 실패' || vector.note === 'stale-index',
    });
    return { entries: ordered.slice(0, maxK), fromCache: false,
        stage: engine + (vector.note ? ' · ' + vector.note : '') + ' · 인물/연속성 우선' };
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
        acc = (acc * 31 + getStringHash(`${uid}:${entry.comment || ''}:${entry.content || ''}`)) | 0;
    }
    return `${embedderSig}|${count}|${acc}`;
}

/**
 * 로어북 하나를 벡터 재색인 + per-lorebook 지문 기록.
 * @param {string} lbName
 * @param {{data?: object, fingerprint?: string}} [opts] - 이미 로드/계산했으면 재사용(중복 로드 회피)
 * @returns {Promise<number>} 실제 색인된 엔트리 수
 */
const reindexJobs = new Map();
async function reindexOneLorebook(lbName, opts = {}) {
    if (reindexJobs.has(lbName)) return reindexJobs.get(lbName);
    const job = reindexOneImpl(lbName, opts);
    reindexJobs.set(lbName, job);
    try { return await job; } finally { reindexJobs.delete(lbName); }
}
async function reindexOneImpl(lbName, opts = {}) {
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
