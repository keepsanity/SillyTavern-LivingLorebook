/**
 * Chat Metadata — LL의 채팅별 상태(target 로어북 + 선택 소스 로어북)를 chat_metadata에 저장/복원.
 * ST 내장 chat lorebook과 동일 패턴: 객체 대신 string 단일 키 (객체는 chat_metadata에서 깨질 수 있음).
 * 여러 UI(사이드바/설정/패널)가 공유하므로 별도 모듈로 분리.
 */

import { chat_metadata, saveMetadata } from '../../../../script.js';
import { getSettings, saveSettings } from './lore-store.js';
import { clearSelectionCache } from './summary-retrieval.js';

const LOG_PREFIX = '[LivingLorebook]';

export const LL_TARGET_KEY = 'll_target_lorebook';
export const LL_SELECTION_KEY = 'll_selection_lorebooks';
const METADATA_KEY = 'living_lorebook'; // (deprecated, 1회 마이그레이션용)

export function getChatLorebook() {
    return chat_metadata?.[LL_TARGET_KEY] || '';
}

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
    getSettings().selectionLorebooks = cleaned;
    saveSettings();
    saveMetadata();
    clearSelectionCache();
    console.log(`${LOG_PREFIX} chat_metadata.${LL_SELECTION_KEY} = ${JSON.stringify(cleaned)}`);
}

/**
 * 현재 채팅의 LL 메타데이터 → settings 복원. init 시점, CHAT_CHANGED 시점 둘 다 호출.
 * 정책: 채팅별 strict — 없으면 settings를 명시적으로 비워 다른 채팅의 selection leak 방지.
 */
export function restoreChatMetadata() {
    const settings = getSettings();
    if (!chat_metadata) {
        settings.targetLorebook = '';
        settings.selectionLorebooks = [];
        return;
    }

    // chat_metadata가 완전히 빈 객체면 "채팅이 아직 로드 안 됨"으로 본다.
    // ST가 채팅을 채우기 전에 CHAT_CHANGED가 튀는 경우가 있는데(특히 모바일 브라우저 재진입),
    // 여기서 지워버리면 target/selection이 통째로 날아가 "managed 로어북 0개 / 색인 없음"으로 보인다.
    // 진짜 빈 채팅이면 곧 이어지는 이벤트에서 정상 복원되므로 건너뛰는 편이 안전하다.
    if (Object.keys(chat_metadata).length === 0) {
        console.warn(`${LOG_PREFIX} chat_metadata가 비어있음 — 아직 로드 전으로 보고 복원 건너뜀 (기존 target "${settings.targetLorebook}" 유지)`);
        return;
    }

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
        try { saveMetadata(); } catch { /* noop */ }
        console.log(`${LOG_PREFIX} Migrated legacy chat_metadata.${METADATA_KEY} → single keys`);
    }

    settings.targetLorebook = chat_metadata[LL_TARGET_KEY] || '';
    settings.selectionLorebooks = getChatSelectionLorebooks();
}
