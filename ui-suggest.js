/**
 * UI — 세계관 제안 모달.
 * 캐릭터/페르소나 + 유저 요구사항을 AI에 보내 엔트리를 제안받고, 고른 것만 생성.
 * 생성 로직은 world-builder(suggestWorldEntries / generateFromSuggestions).
 */

import { escapeHtml, escapeAttr, refreshPanel, getCharacterContext } from './ui-shared.js';
import { getSettings } from './lore-store.js';
import { suggestWorldEntries, generateFromSuggestions } from './world-builder.js';

const LOG_PREFIX = '[LivingLorebook]';

let suggestState = {
    suggestions: [],
    userRequirements: '',
    characterContext: '',
};

export function createSuggestModal() {
    if (document.querySelector('dialog.ll-suggest-modal')) return;

    const modal = document.createElement('dialog');
    modal.className = 'll-suggest-modal';
    modal.innerHTML = `
        <div class="ll-suggest-header">
            <div class="ll-suggest-title">
                <i class="fa-solid fa-wand-magic-sparkles"></i> 세계관 제안
            </div>
            <button class="ll-suggest-close" title="닫기">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>

        <div class="ll-suggest-body">
            <div class="ll-suggest-section">
                <label class="ll-suggest-label">내가 넣고싶은 설정 (선택)</label>
                <textarea class="ll-suggest-req" id="ll_suggest_req" rows="4"
                    placeholder="예시: 주인공 집은 원룸이고, 친구는 한국계 2세야. 동네에 있는 카페 2개 정도 넣어줘..."></textarea>
                <div class="ll-suggest-actions-top">
                    <button class="ll-suggest-btn ll-suggest-btn-secondary" id="ll_suggest_regen">
                        <i class="fa-solid fa-arrows-rotate"></i> 제안 받기 / 다시 받기
                    </button>
                </div>
            </div>

            <div class="ll-suggest-section">
                <div class="ll-suggest-list-header">
                    <label class="ll-suggest-label">제안된 엔트리</label>
                    <div class="ll-suggest-list-controls">
                        <button class="ll-suggest-mini-btn" id="ll_suggest_all">전체 선택</button>
                        <button class="ll-suggest-mini-btn" id="ll_suggest_none">전체 해제</button>
                    </div>
                </div>
                <div class="ll-suggest-list" id="ll_suggest_list">
                    <div class="ll-suggest-empty">
                        아직 제안이 없습니다. 위의 "제안 받기" 버튼을 눌러주세요.
                    </div>
                </div>
            </div>
        </div>

        <div class="ll-suggest-footer">
            <button class="ll-suggest-btn ll-suggest-btn-cancel" id="ll_suggest_cancel">취소</button>
            <button class="ll-suggest-btn ll-suggest-btn-primary" id="ll_suggest_generate">
                <i class="fa-solid fa-check"></i> 선택한 항목 생성
            </button>
        </div>
    `;
    document.body.appendChild(modal);

    // Events — click outside modal content (backdrop) closes it
    modal.addEventListener('click', (e) => { if (e.target === modal) closeSuggestModal(); });
    modal.querySelector('.ll-suggest-close').addEventListener('click', closeSuggestModal);
    modal.querySelector('#ll_suggest_cancel').addEventListener('click', closeSuggestModal);

    modal.querySelector('#ll_suggest_req').addEventListener('input', (e) => {
        suggestState.userRequirements = e.target.value;
    });

    modal.querySelector('#ll_suggest_regen').addEventListener('click', handleSuggestRegenerate);
    modal.querySelector('#ll_suggest_all').addEventListener('click', () => {
        modal.querySelectorAll('.ll-suggest-item-check').forEach(cb => cb.checked = true);
    });
    modal.querySelector('#ll_suggest_none').addEventListener('click', () => {
        modal.querySelectorAll('.ll-suggest-item-check').forEach(cb => cb.checked = false);
    });
    modal.querySelector('#ll_suggest_generate').addEventListener('click', handleSuggestGenerate);
}

export function openSuggestModal() {
    if (!getSettings().targetLorebook) {
        toastr.warning('대상 로어북을 먼저 선택해주세요.');
        return;
    }
    suggestState.suggestions = [];
    suggestState.userRequirements = '';
    suggestState.characterContext = getCharacterContext();

    const dlg = document.querySelector('dialog.ll-suggest-modal');
    if (dlg && !dlg.open) dlg.showModal();

    const req = document.getElementById('ll_suggest_req');
    if (req) req.value = '';
    renderSuggestList();
}

function closeSuggestModal() {
    const dlg = document.querySelector('dialog.ll-suggest-modal');
    if (dlg?.open) dlg.close();
}

function renderSuggestList() {
    const list = document.getElementById('ll_suggest_list');
    if (!list) return;

    if (suggestState.suggestions.length === 0) {
        list.innerHTML = `<div class="ll-suggest-empty">아직 제안이 없습니다. 위의 "제안 받기" 버튼을 눌러주세요.</div>`;
        return;
    }

    const catLabels = {
        arc: '줄거리',
        character: '캐릭터', relationship: '관계', location: '장소',
        event: '사건', routine: '일상', item: '아이템', fact: '설정',
    };

    list.innerHTML = suggestState.suggestions.map((s, i) => `
        <div class="ll-suggest-item" data-idx="${i}">
            <label class="ll-suggest-item-head">
                <input type="checkbox" class="ll-suggest-item-check" checked />
                <select class="ll-suggest-item-cat">
                    ${Object.entries(catLabels).map(([k, v]) =>
                        `<option value="${k}"${s.category === k ? ' selected' : ''}>${v}</option>`,
                    ).join('')}
                </select>
                <input type="text" class="ll-suggest-item-title" value="${escapeAttr(s.title || '')}" placeholder="제목" />
            </label>
            <div class="ll-suggest-item-reason">${escapeHtml(s.reason || '')}</div>
            <textarea class="ll-suggest-item-draft" rows="2" placeholder="추가 메모 / 초안 (선택)">${escapeHtml(s.content || '')}</textarea>
        </div>
    `).join('');
}

async function handleSuggestRegenerate() {
    const btn = document.getElementById('ll_suggest_regen');
    const list = document.getElementById('ll_suggest_list');
    if (!btn || !list) return;

    // 현재 입력 수집
    suggestState.userRequirements = document.getElementById('ll_suggest_req')?.value || '';

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 제안 생성 중...';
    list.innerHTML = `<div class="ll-suggest-empty"><i class="fa-solid fa-spinner fa-spin"></i> AI 분석 중...</div>`;

    try {
        const suggestions = await suggestWorldEntries(
            suggestState.characterContext,
            suggestState.userRequirements,
        );
        suggestState.suggestions = suggestions;
        renderSuggestList();
        toastr.success(`${suggestions.length}개의 제안을 받았습니다.`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Suggest failed:`, err);
        toastr.error(err.message || '제안 받기에 실패했습니다.');
        list.innerHTML = `<div class="ll-suggest-empty">제안 받기 실패. 다시 시도해주세요.</div>`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> 제안 받기 / 다시 받기';
    }
}

async function handleSuggestGenerate() {
    const modal = document.querySelector('.ll-suggest-modal');
    if (!modal) return;

    // 선택된 항목들 수집 (인라인 편집 반영)
    const items = [];
    modal.querySelectorAll('.ll-suggest-item').forEach(el => {
        const checked = el.querySelector('.ll-suggest-item-check')?.checked;
        if (!checked) return;
        items.push({
            title: el.querySelector('.ll-suggest-item-title')?.value?.trim() || 'untitled',
            category: el.querySelector('.ll-suggest-item-cat')?.value || 'fact',
            content: el.querySelector('.ll-suggest-item-draft')?.value?.trim() || '',
        });
    });

    if (items.length === 0) {
        toastr.warning('선택된 항목이 없습니다.');
        return;
    }

    const btn = document.getElementById('ll_suggest_generate');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 생성 중...';
    }

    try {
        const userReq = document.getElementById('ll_suggest_req')?.value || '';
        const created = await generateFromSuggestions(items, suggestState.characterContext, userReq);
        toastr.success(`${created.length}개의 엔트리가 생성되었습니다.`);
        closeSuggestModal();
        refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Generate from suggestions failed:`, err);
        toastr.error(err.message || '엔트리 생성에 실패했습니다.');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-check"></i> 선택한 항목 생성';
        }
    }
}
