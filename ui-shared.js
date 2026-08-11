/**
 * UI Shared — 여러 UI 모듈이 공유하는 상수/순수 헬퍼 + 소소한 도메인 헬퍼.
 * (index.js가 UI를 다 들고 있던 걸 모듈로 쪼개는 리팩터의 토대)
 */

import { characters, this_chid } from '../../../../script.js';
import { power_user } from '../../../power-user.js';

const LOG_PREFIX = '[LivingLorebook]';

/**
 * 현재 캐릭터 카드 + 유저 페르소나를 한 덩어리 텍스트로 — organize/build/제안이 "이미 프롬프트에 있는 정보"
 * 참고용으로 씀 (중복 엔트리 방지).
 */
export function getCharacterContext() {
    const parts = [];
    if (this_chid !== undefined && characters[this_chid]) {
        const char = characters[this_chid];
        if (char.description) parts.push(`[Character Description]\n${char.description}`);
        if (char.personality) parts.push(`[Personality]\n${char.personality}`);
        if (char.scenario) parts.push(`[Scenario]\n${char.scenario}`);
        if (char.first_mes) parts.push(`[First Message]\n${char.first_mes}`);
    }
    if (power_user.persona_description) {
        parts.push(`[User Persona]\n${power_user.persona_description}`);
    }
    return parts.join('\n\n');
}

// 카테고리 설정 (아이콘 / 한글 라벨 / 이모지)
export const CATEGORIES = {
    arc:           { icon: 'fa-solid fa-book-bookmark',  label: '줄거리',   iconChar: '📖' },
    character:     { icon: 'fa-solid fa-user',           label: '캐릭터',   iconChar: '🧑' },
    relationship:  { icon: 'fa-solid fa-heart',          label: '관계',     iconChar: '💕' },
    location:      { icon: 'fa-solid fa-location-dot',   label: '장소',     iconChar: '📍' },
    event:         { icon: 'fa-solid fa-bolt',           label: '사건',     iconChar: '⚡' },
    routine:       { icon: 'fa-solid fa-clock',          label: '일상',     iconChar: '🔄' },
    item:          { icon: 'fa-solid fa-gem',            label: '아이템',   iconChar: '💎' },
    fact:          { icon: 'fa-solid fa-circle-info',    label: '설정',     iconChar: 'ℹ️' },
};

/** 텍스트 노드용 이스케이프 (innerHTML로 넣을 본문) */
export function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/** 속성값용 이스케이프 (value="..." 등) */
export function escapeAttr(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── refreshPanel 레지스트리 ──────────────────────────────────
// 패널은 아직 index.js가 소유. UI 모듈(모달 등)이 순환 import 없이 패널을 새로고침할 수 있게,
// index.js가 init에서 자기 refreshPanel을 등록하고, 다른 모듈은 여기 refreshPanel()을 호출한다.
let _refreshPanelFn = null;
export function registerRefreshPanel(fn) { _refreshPanelFn = fn; }
export function refreshPanel() { return _refreshPanelFn?.(); }
