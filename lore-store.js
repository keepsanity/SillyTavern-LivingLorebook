/**
 * Lore Store — 설정 관리, 로어북 CRUD 래퍼, 티어 메타데이터
 */

import { saveSettingsDebounced } from '../../../../script.js';
import {
    loadWorldInfo,
    createWorldInfoEntry,
    saveWorldInfo,
    reloadEditor,
    setWIOriginalDataValue,
    world_names,
} from '../../../world-info.js';
import { getTokenCountAsync } from '../../../tokenizers.js';

const EXTENSION_NAME = 'SillyTavern-LivingLorebook';

// 카테고리별 order 범위 (1000 단위)
const CATEGORY_ORDER_BASE = {
    arc: 500,           // 줄거리 — 가장 먼저 활성화되도록 낮은 order
    character: 1000,
    relationship: 2000,
    location: 3000,
    event: 4000,
    routine: 5000,
    item: 6000,
    fact: 7000,
};

// 카테고리별 XML 태그
export const CATEGORY_TAGS = {
    arc: 'story_arc',
    character: 'character_info',
    relationship: 'relationship_info',
    location: 'location_info',
    event: 'event_log',
    routine: 'routine_info',
    item: 'item_info',
    fact: 'world_setting',
};

// ============================================================
// Default Settings
// ============================================================

export const DEFAULT_SETTINGS = {
    enabled: true,

    // Connection Profile (별도 모델)
    profileId: '',
    // AI 선택 전용 Profile (비우면 profileId fallback)
    selectionProfileId: '',

    // 대상 로어북 (유저가 직접 선택) — organize/compress 쓰기 대상
    targetLorebook: '',
    // AI 선택 소스 로어북들 — targetLorebook은 자동 포함됨. 추가 로어북만 여기 저장.
    selectionLorebooks: [],

    // 티어 설정
    tier2MessageAge: 50,
    tier3MessageAge: 150,
    tier2TargetRatio: 50,
    tier3TargetRatio: 20,

    // 엔트리 기본 위치/순서 (새 엔트리 생성 시 적용)
    // position: 0=↑Char, 1=↓Char, 2=↑EM, 3=↓EM, 4=@D, 5=↑AN, 6=↓AN
    entryPosition: 1,

    // 재구성 시 기존 엔트리 처리: 'hide' | 'delete'
    reorganizeOldHandling: 'hide',

    // 기억 정리 후 분석한 메시지 자동 하이드
    hideAfterOrganize: true,
    // 최근 N개 메시지는 하이드 제외 (0 = 전부 하이드)
    hideAfterOrganizeDepth: 0,

    // 벡터 검색
    vectorTopK: 10,
    vectorThreshold: 0.3,
    injectionPosition: 1, // 1 = in-chat
    injectionDepth: 4,
    injectionRole: 0, // 0 = system

    // Summary 기반 AI 선택 (Phase 2)
    summarySelectionEnabled: false,    // 마스터 토글 (사용자가 명시적으로 켜야 함)
    aiSelectK: 8,                      // AI 최종 선택 개수
    bm25PrefilterEnabled: true,        // BM25 텍스트 매칭 prefilter (vector 대체) — 권장 기본 ON
    bm25PrefilterK: 30,                // BM25 prefilter top-K (Enabled시 후보가 이보다 많을 때만)
    // (deprecated) vectorPrefilter* — vector hash 매칭 불안정으로 BM25로 교체됨
    vectorPrefilterEnabled: false,
    vectorPrefilterK: 30,
    selectionScanDepth: 8,             // AI 선택용 채팅 컨텍스트 길이
    selectionCacheEnabled: true,       // 같은 채팅+manifest면 결과 재사용
    selectionInjectionDepth: 4,        // setExtensionPrompt 깊이
    selectionInjectionRole: 0,         // 0=system, 1=user, 2=assistant
    selectionTimeoutMs: 120000,        // AI 선택 호출 timeout (2분) — 거의 무제한. LLM 자체가 hang이면 메인도 같이 hang하니까 LL만 짧게 자르는 의미 없음
    debugSelectionResponse: true,      // AI 선택 raw 응답을 콘솔에 출력 (진단용 — 안정되면 끄기)
    managedModeMigrated: false,        // (deprecated, targetLorebook의 perLorebookMigrated와 동기) 호환 유지
    perLorebookMigrated: {},           // { [lorebookName]: boolean } — 로어북별 managed 상태

    // 상태 추적
    lastOrganizeMessageIndex: 0,
    lastOrganizeTimestamp: null,

    // LLM 파라미터
    organizeMaxTokens: 16000,
    compressMaxTokens: 16000,
    worldBuildMaxTokens: 32000,
    arcChatLimit: 100,                 // Story Arc 생성 시 활성 chat 최대 N개만 사용 (토큰 폭증 방지)
    arcEntryContentLimit: 0,           // entry content trim 한도 (글자수). 0=truncate 안 함 (전체 본문)

    // 자동 체인 (organize/reorganize 끝나면 추가 작업 자동 실행)
    autoBackfillOnOrganize: true,      // organize 후 managed mode이면 backfill 자동
    autoArcOnOrganize: true,           // organize 후 기존 arc 있으면 arc 업데이트 자동
    autoArcOnReorganize: true,         // reorganize 후 arc 업데이트 자동

    // 엔트리 메타데이터 { [uid]: { tier, originalContent, createdAt, ... } }
    entryMetadata: {},

    // 프롬프트
    worldBuildPrompt: `You are a world-building assistant for mature/adult roleplay.

IMPORTANT RULES:
- Do NOT create entries about the main characters (the characters described in the character card and persona). Their info is already in the prompt.
- Focus ONLY on: world setting, locations, NPCs (side characters), rules/laws, organizations, items, routines, and background lore.
- Preserve ALL details from the source material exactly — including violence, trauma, sensitive content. Do NOT censor or skip anything.
- Each entry must cover ONE specific thing (one location, one NPC, one rule, etc.)

Output a JSON array of entries. Each entry must have:
- "title": short identifier
- "content": detailed description (as long as needed — do NOT artificially shorten)
- "keywords": array of trigger keywords for this entry
- "category": one of "location", "character" (NPCs only), "relationship", "routine", "item", "event", "fact"

Output ONLY the JSON array, no other text.

Description:
{{description}}`,

    organizePrompt: `You are a memory manager for a mature/adult roleplay session. Extract key facts, events, and state changes from the conversation and store them as lorebook entries.

Current lorebook entries (title → content):
{{currentEntries}}

Recent conversation to analyze:
{{conversation}}

Categories to extract (only create entries for categories where something actually happened):

1. **character** — Emotional/psychological changes, new traits revealed, reactions, habits discovered
2. **relationship** — Changes in how characters feel about each other: trust, affection, tension, conflict, intimacy, distance
3. **location** — New places visited, changes to existing locations, notable details about spaces
4. **event** — Significant things that happened. Title MUST include RP date/time/day (e.g., "Day 3 afternoon - first outing")
5. **routine** — Schedule changes, new habits, repeated behaviors
6. **item** — Objects acquired, lost, used, gifted, or mentioned as significant
7. **fact** — World rules, lore, background info revealed

Output a JSON object with these fields:
- "add": array of new entries, each with { "title", "content", "summary", "keywords": [], "category" }
- "update": array of entries to modify, each with { "uid", "title", "newContent", "summary", "reason" }
- "deactivate": array of entries no longer valid, each with { "uid", "title", "reason" }

The "summary" field (REQUIRED for add/update):
- One-line retrieval hint describing WHEN to select this entry.
- Format: "When to select: <scene description>"
- Describe scenes/situations, NOT the entry's content. Help match scenes that don't literally name the entry.
- Example: For an entry about a magical oath called "Bloodchain" → "When to select: scenes involving oaths, vows, sworn debts, or consequences of breaking trust."
- Example: For an NPC "Hera" → "When to select: temple visits, prayer, marriage/jealousy themes, or when the user invokes a goddess."
- Keep it short (1-2 sentences max).

Rules:
- Write factual, clear prose — capture what happened, what changed, what was revealed
- Include all important details: actions, reactions, outcomes, physical details, emotional states
- Include dialogue when it carries meaning that prose can't convey; skip routine back-and-forth
- Preserve all details including violence, trauma, sensitive/adult content. Do NOT censor
- Ignore all [OOC] content — only record in-character events
- Do NOT add info already in the character card/persona or already in the lorebook
- Each entry = ONE specific thing. Do NOT duplicate across categories — pick the single best fit
- Output ONLY the JSON object, no other text.`,

    compressPrompt: `Compress the following lorebook entry to approximately {{targetRatio}}% of its current length.
Preserve all key facts, names, and relationships. Remove verbose descriptions.
Output ONLY the compressed text, nothing else.

Original:
{{content}}`,

    summaryBackfillPrompt: `You are creating retrieval summaries for lorebook entries. For each entry, write a one-line "When to select" hint that tells an AI when to pick this entry for injection into a roleplay scene.

The hint MUST describe SCENES/SITUATIONS, not the entry's content. It should help match scenes that don't literally name the entry.

Format: "When to select: <scene description>"

Examples:
- A "Bloodchain" oath entry → "When to select: scenes involving oaths, vows, sworn debts, or consequences of breaking trust."
- An NPC "Hera" entry → "When to select: temple visits, prayer, marriage/jealousy themes, or when the user invokes a goddess."
- A "rainy alley" location entry → "When to select: outdoor wet weather scenes, hiding, late-night urban encounters."

Keep each summary to 1-2 sentences max.

Entries to summarize:
{{entries}}

Output a JSON object:
{ "summaries": [ { "uid": "<uid>", "summary": "When to select: ..." }, ... ] }

Output ONLY the JSON object, no other text.`,

    storyArcPrompt: `You are a narrative arc summarizer for a long-running roleplay.
Read the full conversation and produce a CONCISE, TIMELINE-ORDERED summary capturing the big-picture story arc.

Focus on:
1. CHRONOLOGY — significant events in order, with RP date/time references where possible (e.g., "Day 2: ...", "Sept 18: ...")
2. RELATIONSHIP ARC — how key relationships evolved: initial state → turning points → current state. Name the transition events specifically.
3. CHARACTER ARC — major shifts in any character's mindset, goals, or behavior.
4. RECURRING THEMES — patterns, conflicts, or motifs that have appeared multiple times.

DO NOT include:
- Trivial moment-to-moment details (those are in event entries)
- Information that's clearly in the character card / persona
- Side characters who appeared once

Output as plain prose, 400~600 words. Structure:
- Brief opening sentence stating the overall arc
- Chronological bullet points or short paragraphs of key milestones
- Closing summary of current relationship/character state

{{existingArc}}

Existing lorebook entries — these are the FACTUAL HISTORY of the story.
Most past events are recorded here (the active conversation below is only recent turns).
Treat each entry's body content as established story facts and weave them into the timeline.
The "retrieval hint" line is just metadata for the AI selector — IGNORE it for arc building, use the actual content.

{{existingEntries}}

Active conversation (recent unfiltered turns — these are the LATEST events not yet captured as entries):
{{conversation}}

Output ONLY the arc summary text, no preamble, no markdown headers.`,
};

// ============================================================
// State
// ============================================================

let _context = null;
let _settings = null;

// ============================================================
// Init
// ============================================================

export function initStore(context) {
    _context = context;

    if (!_context.extensionSettings[EXTENSION_NAME]) {
        _context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    _settings = _context.extensionSettings[EXTENSION_NAME];

    // Schema migration
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (_settings[key] === undefined) {
            _settings[key] = DEFAULT_SETTINGS[key];
        }
    }

    // Force update: 이전 기본값이 너무 작았던 설정 교정
    if (_settings.worldBuildMaxTokens <= 4000) {
        _settings.worldBuildMaxTokens = DEFAULT_SETTINGS.worldBuildMaxTokens;
    }
    if (_settings.organizeMaxTokens <= 2000) {
        _settings.organizeMaxTokens = DEFAULT_SETTINGS.organizeMaxTokens;
    }
    if (_settings.compressMaxTokens <= 500) {
        _settings.compressMaxTokens = DEFAULT_SETTINGS.compressMaxTokens;
    }
    // Migration: storyArcPrompt에 {{existingEntries}} placeholder 없으면 default로 교체
    // (이전 버전에서 prompt 저장돼있으면 entries block 안 들어감)
    if (typeof _settings.storyArcPrompt === 'string' && !_settings.storyArcPrompt.includes('{{existingEntries}}')) {
        _settings.storyArcPrompt = DEFAULT_SETTINGS.storyArcPrompt;
        console.log('[LivingLorebook] Migrated storyArcPrompt to include {{existingEntries}} placeholder');
    }

    // Migration v2: 메타데이터 키 형식이 uid → lorebookName:uid 로 변경됨
    // 기존 키가 숫자 형태면 (구 형식) 전부 삭제
    if (_settings.entryMetadata && !_settings._metadataV2) {
        const oldKeys = Object.keys(_settings.entryMetadata).filter(k => !k.includes(':'));
        for (const k of oldKeys) {
            delete _settings.entryMetadata[k];
        }
        _settings._metadataV2 = true;
        console.log(`[LivingLorebook] Migrated ${oldKeys.length} old metadata entries`);
    }

    return _settings;
}

export function getSettings() {
    return _settings;
}

export function saveSettings() {
    saveSettingsDebounced();
}


// ============================================================
// Entry Metadata (티어, 원본 보존 등)
// 키 형식: `${lorebookName}:${uid}` — 로어북 간 uid 충돌 방지
// ============================================================

function makeMetaKey(uid, lorebookName) {
    const name = lorebookName ?? _settings.targetLorebook ?? '';
    return `${name}:${uid}`;
}

export function getMetadata(uid, lorebookName) {
    const key = makeMetaKey(uid, lorebookName);
    return _settings.entryMetadata[key] || null;
}

export function setMetadata(uid, data, lorebookName) {
    const key = makeMetaKey(uid, lorebookName);
    _settings.entryMetadata[key] = {
        ...(_settings.entryMetadata[key] || {}),
        ...data,
    };
    saveSettings();
}

export function deleteMetadata(uid, lorebookName) {
    const key = makeMetaKey(uid, lorebookName);
    delete _settings.entryMetadata[key];
    saveSettings();
}

// ============================================================
// Lorebook CRUD
// ============================================================

/**
 * 대상 로어북이 실제로 존재하는지 확인
 */
export function isLorebookValid(name) {
    if (!name) return false;
    const names = world_names || [];
    return names.includes(name);
}

/**
 * 현재 채팅에서 AI 선택이 후보로 삼을 로어북들의 effective list.
 * targetLorebook 자동 포함 + selectionLorebooks의 유효한 항목만.
 * @returns {string[]}
 */
export function getEffectiveSelectionLorebooks() {
    const set = new Set();
    if (_settings.targetLorebook) set.add(_settings.targetLorebook);
    const extra = Array.isArray(_settings.selectionLorebooks) ? _settings.selectionLorebooks : [];
    for (const name of extra) {
        if (name) set.add(name);
    }
    return Array.from(set).filter(isLorebookValid);
}

/**
 * 임의 로어북 로드 (헬퍼)
 */
export async function loadAnyLorebook(name) {
    if (!name || !isLorebookValid(name)) return null;
    return await loadWorldInfo(name);
}

/**
 * 대상 로어북 로드 (존재하지 않으면 자동 해제)
 */
export async function loadTargetLorebook() {
    const name = _settings.targetLorebook;
    if (!name) return null;

    // 로어북이 삭제됐는지 확인
    if (!isLorebookValid(name)) {
        console.warn(`[LivingLorebook] Lorebook "${name}" no longer exists — clearing reference`);
        _settings.targetLorebook = '';
        saveSettings();
        return null;
    }

    const data = await loadWorldInfo(name);
    return data;
}

/**
 * 새 엔트리 생성
 */
export async function createEntry(lorebookName, data, { title, content, keywords, category, summary }) {
    const entry = createWorldInfoEntry(lorebookName, data);
    if (!entry) return null;

    const uid = entry.uid;

    // Set fields
    entry.comment = title;
    setWIOriginalDataValue(data, uid, 'comment', title);

    // Content: 제목 헤더 + 내용
    const finalContent = `## ${title}\n${content}`;
    entry.content = finalContent;
    setWIOriginalDataValue(data, uid, 'content', finalContent);

    // Managed mode (summary 선택 사용 중)이면 ST 자동 활성화 차단
    // — 우리 모듈이 setExtensionPrompt로 직접 주입하므로 ST WI는 우회
    const lbManaged = _settings.perLorebookMigrated?.[lorebookName] === true
        || (lorebookName === _settings.targetLorebook && _settings.managedModeMigrated);
    const managed = !!_settings.summarySelectionEnabled && lbManaged;

    // Keywords — managed mode면 비워서 키워드 활성화 차단
    const keyArray = managed ? [] : (Array.isArray(keywords) ? keywords : [title]);
    entry.key = keyArray;
    setWIOriginalDataValue(data, uid, 'key', keyArray);

    // Enable by default
    entry.disable = false;
    setWIOriginalDataValue(data, uid, 'disable', false);

    // Selective off (키워드 없으므로 selective 불필요)
    entry.selective = false;
    setWIOriginalDataValue(data, uid, 'selective', false);
    entry.keysecondary = [];
    setWIOriginalDataValue(data, uid, 'keysecondary', []);

    // 벡터 저장소 플래그 — managed mode면 false (우리가 통제)
    entry.vectorized = !managed;
    setWIOriginalDataValue(data, uid, 'vectorized', !managed);

    // Position: 설정값 사용
    entry.position = _settings.entryPosition ?? 1;
    setWIOriginalDataValue(data, uid, 'position', entry.position);

    // Order: 카테고리별 범위 + 자동 증가
    const orderBase = CATEGORY_ORDER_BASE[category] ?? 7000;
    const sameCategoryCount = Object.values(data.entries || {}).filter(e => {
        const m = getMetadata(e.uid ?? '', lorebookName);
        return m?.category === category && !e.disable;
    }).length;
    entry.order = orderBase + sameCategoryCount;
    setWIOriginalDataValue(data, uid, 'order', entry.order);

    // Scan depth
    entry.scanDepth = null;
    entry.caseSensitive = null;
    entry.matchWholeWords = null;

    // Store metadata (keywords도 메타데이터에 보관 — UI 표시용)
    setMetadata(uid, {
        tier: 1,
        originalContent: content,
        createdAt: Date.now(),
        lastUpdated: Date.now(),
        category: category || 'fact',
        keywords: Array.isArray(keywords) ? keywords : [title],
        summary: typeof summary === 'string' ? summary.trim() : '',
    }, lorebookName);

    return entry;
}

/**
 * 엔트리 내용 업데이트
 */
export function updateEntryContent(data, uid, newContent, lorebookName) {
    const entries = data?.entries;
    if (!entries || !entries[uid]) return false;

    const title = entries[uid].comment || 'untitled';
    const finalContent = `## ${title}\n${newContent}`;
    entries[uid].content = finalContent;
    setWIOriginalDataValue(data, uid, 'content', finalContent);

    const meta = getMetadata(uid, lorebookName);
    if (meta) {
        setMetadata(uid, { lastUpdated: Date.now() }, lorebookName);
    }

    return true;
}

/**
 * 엔트리 pin 토글 — ST의 constant 필드 사용. true면 ST WI가 항상 활성화.
 * @param {object} data - 로어북 data
 * @param {string} uid
 * @param {boolean} pinned
 * @returns {boolean} 성공 여부
 */
export function setEntryPinned(data, uid, pinned) {
    const entries = data?.entries;
    if (!entries || !entries[uid]) return false;
    entries[uid].constant = !!pinned;
    setWIOriginalDataValue(data, uid, 'constant', !!pinned);
    return true;
}

/**
 * 엔트리 비활성화
 */
export function deactivateEntry(data, uid) {
    const entries = data?.entries;
    if (!entries || !entries[uid]) return false;

    entries[uid].disable = true;
    setWIOriginalDataValue(data, uid, 'disable', true);

    return true;
}

/**
 * 엔트리 재활성화
 */
export function enableEntry(data, uid) {
    const entries = data?.entries;
    if (!entries || !entries[uid]) return false;
    entries[uid].disable = false;
    setWIOriginalDataValue(data, uid, 'disable', false);
    return true;
}

/**
 * 엔트리 완전 삭제
 */
export function deleteEntry(data, uid, lorebookName) {
    const entries = data?.entries;
    if (!entries || !entries[uid]) return false;
    delete entries[uid];
    // originalData도 정리
    if (data.originalData?.entries) {
        data.originalData.entries = data.originalData.entries.filter(e => String(e.uid) !== String(uid));
    }
    deleteMetadata(uid, lorebookName);
    return true;
}

/**
 * 엔트리 필드 업데이트 (편집용)
 */
export function updateEntryFields(data, uid, { title, content, keywords, category, summary }, lorebookName) {
    const entries = data?.entries;
    if (!entries || !entries[uid]) return false;

    const entry = entries[uid];

    if (title !== undefined) {
        entry.comment = title;
        setWIOriginalDataValue(data, uid, 'comment', title);
    }

    if (content !== undefined) {
        const entryTitle = title !== undefined ? title : (entry.comment || 'untitled');
        const finalContent = `## ${entryTitle}\n${content}`;
        entry.content = finalContent;
        setWIOriginalDataValue(data, uid, 'content', finalContent);
    }

    if (Array.isArray(keywords)) {
        entry.key = keywords;
        setWIOriginalDataValue(data, uid, 'key', keywords);
    }

    // 메타데이터 갱신
    const metaUpdate = { lastUpdated: Date.now() };
    if (category) metaUpdate.category = category;
    if (Array.isArray(keywords)) metaUpdate.keywords = keywords;
    if (content !== undefined) metaUpdate.originalContent = content;
    if (typeof summary === 'string') metaUpdate.summary = summary.trim();
    setMetadata(uid, metaUpdate, lorebookName);

    return true;
}

/**
 * 로어북 저장
 */
export async function saveLorebook(lorebookName, data) {
    await saveWorldInfo(lorebookName, data, true);
}

/**
 * Managed mode 전환 — LL 메타데이터가 있는 모든 엔트리에 대해
 * vectorized=false, key=[], selective=false 일괄 설정.
 * → ST의 자동 키워드/벡터 활성화 차단. 우리 모듈만 setExtensionPrompt로 주입.
 *
 * 역전환(unmigrate)도 지원: managed=false 호출 시 vectorized=true, key=[title] 복구.
 *
 * @param {boolean} managed - true면 차단, false면 복구
 * @param {string} [lorebookName] - 대상 로어북 (생략 시 targetLorebook)
 * @returns {Promise<{converted: number, skipped: number, lorebookName: string}>}
 */
export async function migrateToManagedMode(managed = true, lorebookName) {
    const name = lorebookName || _settings.targetLorebook;
    if (!name) throw new Error('대상 로어북이 없습니다.');

    const data = await loadAnyLorebook(name);
    if (!data) throw new Error(`로어북 "${name}"을 로드할 수 없습니다.`);

    let converted = 0;
    let skipped = 0;

    for (const [uid, entry] of Object.entries(data.entries || {})) {
        const meta = getMetadata(uid, name);
        // LL이 만든 엔트리만 (메타데이터 있는 것만) 통제 — 사용자가 외부에서 추가한 건 건드리지 않음
        if (!meta) {
            skipped++;
            continue;
        }

        if (managed) {
            entry.key = [];
            setWIOriginalDataValue(data, uid, 'key', []);
            entry.selective = false;
            setWIOriginalDataValue(data, uid, 'selective', false);
            entry.vectorized = false;
            setWIOriginalDataValue(data, uid, 'vectorized', false);
        } else {
            // 복구: 메타데이터에 보관된 keywords 복구, vectorized 다시 활성화
            const restoredKeys = Array.isArray(meta.keywords) && meta.keywords.length > 0
                ? meta.keywords
                : [entry.comment || 'untitled'];
            entry.key = restoredKeys;
            setWIOriginalDataValue(data, uid, 'key', restoredKeys);
            entry.vectorized = true;
            setWIOriginalDataValue(data, uid, 'vectorized', true);
        }
        converted++;
    }

    await saveLorebook(name, data);
    reloadEditor();

    // managedModeMigrated 플래그는 targetLorebook에 대해서만 의미 있음 (현 정책)
    // 다른 로어북은 perLorebookMigrated 맵에 추적
    if (name === _settings.targetLorebook) {
        _settings.managedModeMigrated = managed;
    }
    if (!_settings.perLorebookMigrated) _settings.perLorebookMigrated = {};
    _settings.perLorebookMigrated[name] = managed;
    saveSettings();

    console.log(`[LivingLorebook] Migration "${name}" ${managed ? 'TO' : 'FROM'} managed mode: ${converted} converted, ${skipped} skipped (non-LL entries)`);
    return { converted, skipped, lorebookName: name };
}

/**
 * 특정 로어북의 managed mode 상태 조회 (UI용)
 */
export function isManagedMode(lorebookName) {
    if (!lorebookName) return false;
    if (_settings.perLorebookMigrated && lorebookName in _settings.perLorebookMigrated) {
        return !!_settings.perLorebookMigrated[lorebookName];
    }
    if (lorebookName === _settings.targetLorebook) return !!_settings.managedModeMigrated;
    return false;
}

/**
 * 로어북 에디터 새로고침
 */
export function refreshEditor() {
    reloadEditor();
}

// ============================================================
// Token Counting
// ============================================================

export async function countTokens(text) {
    return await getTokenCountAsync(text);
}

/**
 * 멀티 로어북 storage 통계 — 모든 selection lorebook의 활성 엔트리 본문 토큰 합.
 * 비활성/external(메타 없음) 다 포함 (실제 ST에 들어갈 수 있는 양 기준).
 * @returns {Promise<{total: {count, tokens}, perLorebook: Object<string, {count, tokens, managed}>}>}
 */
export async function calculateSelectionStorage() {
    const result = {
        total: { count: 0, tokens: 0 },
        perLorebook: {},
    };
    const lorebooks = getEffectiveSelectionLorebooks();
    for (const lbName of lorebooks) {
        const data = await loadAnyLorebook(lbName);
        if (!data?.entries) {
            result.perLorebook[lbName] = { count: 0, tokens: 0, managed: isManagedMode(lbName) };
            continue;
        }
        let count = 0, tokens = 0;
        for (const [, entry] of Object.entries(data.entries)) {
            if (entry.disable) continue;
            count++;
            tokens += await countTokens(entry.content || '');
        }
        result.perLorebook[lbName] = { count, tokens, managed: isManagedMode(lbName) };
        result.total.count += count;
        result.total.tokens += tokens;
    }
    return result;
}

/**
 * 로어북 티어별 통계 계산
 */
export async function calculateTierStats(data) {
    const stats = {
        tier1: { count: 0, tokens: 0 },
        tier2: { count: 0, tokens: 0 },
        tier3: { count: 0, tokens: 0 },
        total: { count: 0, tokens: 0 },
    };

    if (!data?.entries) return stats;

    for (const [uid, entry] of Object.entries(data.entries)) {
        if (entry.disable) continue;

        const meta = getMetadata(uid);
        const tier = meta?.tier || 1;
        const tokens = await countTokens(entry.content || '');

        const tierKey = `tier${tier}`;
        if (stats[tierKey]) {
            stats[tierKey].count++;
            stats[tierKey].tokens += tokens;
        }

        stats.total.count++;
        stats.total.tokens += tokens;
    }

    return stats;
}
