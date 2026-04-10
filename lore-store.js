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

    // 대상 로어북 (유저가 직접 선택)
    targetLorebook: '',

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

    // 상태 추적
    lastOrganizeMessageIndex: 0,
    lastOrganizeTimestamp: null,

    // LLM 파라미터
    organizeMaxTokens: 16000,
    compressMaxTokens: 16000,
    worldBuildMaxTokens: 32000,

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

    organizePrompt: `You are a memory manager for a mature/adult roleplay session. Analyze the conversation thoroughly and extract ALL meaningful information. Be detailed and comprehensive — do NOT summarize or skip.

Current lorebook entries (title → content):
{{currentEntries}}

Recent conversation to analyze:
{{conversation}}

Extract information for EACH of these categories. Do NOT skip any category:

1. **character** — Emotional/psychological changes, new traits revealed, reactions, habits discovered. When a character says something emotionally significant, QUOTE the dialogue directly (e.g., character said "...I'm not scared")
2. **relationship** — Any change in how characters feel about each other: trust, affection, tension, conflict, intimacy, distance
3. **location** — New places visited, changes to existing locations, details about rooms/buildings/areas
4. **event** — Significant things that happened. Title MUST include RP date/time/day (e.g., "Day 3 afternoon - first outing")
5. **routine** — Schedule changes, new habits, repeated behaviors
6. **item** — Objects acquired, lost, used, gifted, or mentioned as significant
7. **fact** — World rules, lore, background info revealed

Output a JSON object with these fields:
- "add": array of new entries, each with { "title", "content", "keywords": [], "category" }
- "update": array of entries to modify, each with { "uid", "title", "newContent", "reason" }
- "deactivate": array of entries no longer valid, each with { "uid", "title", "reason" }

Rules:
- Be THOROUGH. Capture the scene accurately without losing ANY important information.
- For each entry's content: note the date/time if available, then write a detailed beat-by-beat record. Include:
  • All important story beats and events
  • Key interaction highlights and character developments
  • Notable details, memorable quotes (DIRECTLY QUOTED), and revelations
  • Significant physical actions, gestures, and body language
  • Text messages, letters, notes, and other written media (quoted verbatim)
  • Outcome and anything important for future interactions
- Ignore all [OOC] conversation/interaction — only record in-character content.
- Do NOT add info already in the character card/persona or already in the lorebook.
- Each entry = ONE specific thing (one event, one character change, one relationship shift, etc.)
- Do NOT duplicate the same information across different categories. If something happened as an event, record it ONLY as an event — do not also create a separate character or relationship entry with the same info rephrased. Pick the single most fitting category.
- Content: Write as much as needed to capture ALL important details — do NOT artificially limit length. Preserve ALL details including violence, trauma, sensitive/adult content. Do NOT censor.
- Output ONLY the JSON object, no other text.`,

    compressPrompt: `Compress the following lorebook entry to approximately {{targetRatio}}% of its current length.
Preserve all key facts, names, and relationships. Remove verbose descriptions.
Output ONLY the compressed text, nothing else.

Original:
{{content}}`,
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
export async function createEntry(lorebookName, data, { title, content, keywords, category }) {
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

    // Keywords — WI key에도 넣고, 벡터도 함께 사용
    const keyArray = Array.isArray(keywords) ? keywords : [title];
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

    // 벡터 저장소가 이 엔트리를 벡터화하도록 플래그 설정
    entry.vectorized = true;
    setWIOriginalDataValue(data, uid, 'vectorized', true);

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
export function updateEntryFields(data, uid, { title, content, keywords, category }, lorebookName) {
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
