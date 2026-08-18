/**
 * Chat Metadata — LL의 채팅별 상태(target 로어북 + 선택 소스 로어북)를 chat_metadata에 저장/복원.
 * ST 내장 chat lorebook과 동일 패턴: 객체 대신 string 단일 키 (객체는 chat_metadata에서 깨질 수 있음).
 * 여러 UI(사이드바/설정/패널)가 공유하므로 별도 모듈로 분리.
 */

import { chat_metadata, saveMetadata } from '../../../../script.js';
import { getSettings, saveSettings, invalidateChatScope, stampChatScope, LL_TARGET_KEY, LL_SELECTION_KEY } from './lore-store.js';
import { clearSelectionCache } from './summary-retrieval.js';

const LOG_PREFIX = '[LivingLorebook]';

// 키 상수의 원본은 lore-store (읽기 경로가 거기 있음). 기존 import 경로 유지용 re-export.
export { LL_TARGET_KEY, LL_SELECTION_KEY };
const METADATA_KEY = 'living_lorebook'; // (deprecated, 1회 마이그레이션용)

export function setChatLorebook(lorebookName) {
    if (!chat_metadata) {
        console.warn(`${LOG_PREFIX} chat_metadata unavailable in setChatLorebook`);
        return;
    }
    if (lorebookName) {
        chat_metadata[LL_TARGET_KEY] = lorebookName;
    } else {
        delete chat_metadata[LL_TARGET_KEY];
    }
    stampChatScope(lorebookName || '', getChatSelectionLorebooks());
    getSettings().targetLorebook = lorebookName || '';
    saveSettings();
    saveMetadata();
    console.log(`${LOG_PREFIX} chat_metadata.${LL_TARGET_KEY} = "${lorebookName}"`);
}

export function getChatSelectionLorebooks() {
    const raw = chat_metadata?.[LL_SELECTION_KEY];
    // string으로 저장돼있음 (JSON.stringify 결과) — parse 시도
    if (typeof raw === 'string' && raw.length > 0) {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }
    // 옛 array 형식 (마이그레이션 전) 호환
    if (Array.isArray(raw)) return raw;
    return [];
}

export function setChatSelectionLorebooks(arr) {
    if (!chat_metadata) {
        console.warn(`${LOG_PREFIX} chat_metadata unavailable in setChatSelectionLorebooks`);
        return;
    }
    const cleaned = Array.isArray(arr) ? arr.filter(n => typeof n === 'string' && n.length > 0) : [];
    if (cleaned.length > 0) {
        // ST가 chat_metadata에 array 안 보존하는 듯 — JSON.stringify로 string 저장
        chat_metadata[LL_SELECTION_KEY] = JSON.stringify(cleaned);
    } else {
        delete chat_metadata[LL_SELECTION_KEY];
    }
    stampChatScope(chat_metadata[LL_TARGET_KEY] || '', cleaned);
    getSettings().selectionLorebooks = cleaned;
    saveSettings();
    saveMetadata();
    clearSelectionCache();
    console.log(`${LOG_PREFIX} chat_metadata.${LL_SELECTION_KEY} = ${JSON.stringify(cleaned)}`);
}

/**
 * 채팅 진입 시 1회: 옛 형식 마이그레이션 + 파생 캐시 무효화.
 *
 * ⚠️ 예전처럼 chat_metadata를 _settings로 "복사해두는" 일은 하지 않는다.
 * 복사는 이벤트당 한 번뿐이라 ST의 로드 중간 상태를 잘못 보면 영구히 어긋났다.
 * 이제 값은 lore-store.readChatScope()가 **쓸 때마다** chat_metadata에서 직접 읽는다.
 */
export function restoreChatMetadata() {
    invalidateChatScope();
    if (!chat_metadata) return;

    // 옛 객체 키 1회 마이그레이션 (있으면 새 단일 키로 옮김)
    const legacy = chat_metadata[METADATA_KEY];
    if (legacy && typeof legacy === 'object') {
        if (typeof legacy.targetLorebook === 'string' && !chat_metadata[LL_TARGET_KEY]) {
            chat_metadata[LL_TARGET_KEY] = legacy.targetLorebook;
        }
        if (Array.isArray(legacy.selectionLorebooks) && !chat_metadata[LL_SELECTION_KEY]) {
            chat_metadata[LL_SELECTION_KEY] = JSON.stringify(legacy.selectionLorebooks);
        }
        delete chat_metadata[METADATA_KEY];
        invalidateChatScope();
        try { saveMetadata(); } catch { /* noop */ }
        console.log(`${LOG_PREFIX} Migrated legacy chat_metadata.${METADATA_KEY} → single keys`);
    }

    // 파생 캐시를 지금 한 번 맞춰둔다 (직후 UI가 settings.targetLorebook을 읽으므로)
    getSettings();
}
