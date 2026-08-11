/**
 * UI — 엔트리 편집/토글 액션 (타임라인 카드에서).
 * 인라인 편집 + 하이드/LIVE/핀 토글 + 삭제. 저장 후 refreshPanel()로 타임라인 갱신.
 */

import { escapeHtml, escapeAttr, refreshPanel } from './ui-shared.js';
import {
    getSettings,
    loadTargetLorebook, saveLorebook, refreshEditor,
    updateEntryFields, enableEntry, deactivateEntry, setEntryPinned, setMetadata, deleteEntry,
} from './lore-store.js';
import { clearSelectionCache } from './summary-retrieval.js';

const LOG_PREFIX = '[LivingLorebook]';

const CATEGORY_LABELS = {
    arc: '줄거리',
    character: '캐릭터', relationship: '관계', location: '장소',
    event: '사건', routine: '일상', item: '아이템', fact: '설정',
};

export function openInlineEditor(card, uid) {
    if (!card) return;
    if (card.classList.contains('ll-editing')) return; // 이미 편집 중

    const title = card.querySelector('.ll-entry-title')?.textContent.replace(/HIDE\s*$/, '').trim() || '';
    const rawContent = card.querySelector('.ll-entry-content')?.dataset?.raw || '';
    const currentCat = card.dataset.category || 'fact';
    const currentKeywords = Array.from(card.querySelectorAll('.ll-entry-keyword')).map(el => el.textContent);

    card.classList.add('ll-editing');

    const editForm = document.createElement('div');
    editForm.className = 'll-entry-edit-form';
    editForm.innerHTML = `
        <div class="ll-edit-row">
            <label>제목</label>
            <input type="text" class="ll-edit-title" value="${escapeAttr(title)}" />
        </div>
        <div class="ll-edit-row">
            <label>카테고리</label>
            <select class="ll-edit-cat">
                ${Object.entries(CATEGORY_LABELS).map(([k, v]) =>
                    `<option value="${k}"${currentCat === k ? ' selected' : ''}>${v}</option>`,
                ).join('')}
            </select>
        </div>
        <div class="ll-edit-row">
            <label>내용</label>
            <textarea class="ll-edit-content" rows="6">${escapeHtml(rawContent)}</textarea>
        </div>
        <div class="ll-edit-row">
            <label>키워드 (쉼표 구분)</label>
            <input type="text" class="ll-edit-keywords" value="${escapeAttr(currentKeywords.join(', '))}" />
        </div>
        <div class="ll-edit-actions">
            <button class="ll-edit-cancel">취소</button>
            <button class="ll-edit-save">저장</button>
        </div>
    `;

    // 기존 컨텐츠/키워드/헤더 버튼 숨기기
    card.querySelector('.ll-entry-content').style.display = 'none';
    card.querySelector('.ll-entry-keywords')?.style.setProperty('display', 'none');
    card.querySelector('.ll-entry-actions').style.display = 'none';
    card.appendChild(editForm);

    editForm.querySelector('.ll-edit-cancel').addEventListener('click', () => {
        closeInlineEditor(card);
    });
    editForm.querySelector('.ll-edit-save').addEventListener('click', async () => {
        await saveInlineEdit(card, uid, editForm);
    });
}

function closeInlineEditor(card) {
    card.classList.remove('ll-editing');
    card.querySelector('.ll-entry-edit-form')?.remove();
    card.querySelector('.ll-entry-content').style.display = '';
    card.querySelector('.ll-entry-keywords')?.style.removeProperty('display');
    card.querySelector('.ll-entry-actions').style.display = '';
}

async function saveInlineEdit(card, uid, form) {
    const settings = getSettings();
    const newTitle = form.querySelector('.ll-edit-title')?.value?.trim() || 'untitled';
    const newContent = form.querySelector('.ll-edit-content')?.value?.trim() || '';
    const newCat = form.querySelector('.ll-edit-cat')?.value || 'fact';
    const keywordsRaw = form.querySelector('.ll-edit-keywords')?.value || '';
    const newKeywords = keywordsRaw.split(',').map(k => k.trim()).filter(Boolean);

    try {
        const data = await loadTargetLorebook();
        if (!data) throw new Error('로어북 로드 실패');

        updateEntryFields(data, uid, {
            title: newTitle,
            content: newContent,
            keywords: newKeywords,
            category: newCat,
        }, settings.targetLorebook);

        await saveLorebook(settings.targetLorebook, data);
        refreshEditor();
        toastr.success('저장되었습니다.');
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Edit save failed:`, err);
        toastr.error(err.message || '저장에 실패했습니다.');
    }
}

export async function handleEntryHideToggle(uid) {
    const settings = getSettings();
    try {
        const data = await loadTargetLorebook();
        if (!data?.entries?.[uid]) throw new Error('엔트리를 찾을 수 없습니다');

        const entry = data.entries[uid];
        if (entry.disable) {
            enableEntry(data, uid);
            toastr.info('재활성화되었습니다.');
        } else {
            deactivateEntry(data, uid);
            toastr.info('하이드되었습니다.');
        }

        await saveLorebook(settings.targetLorebook, data);
        refreshEditor();
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Hide toggle failed:`, err);
        toastr.error(err.message || '처리에 실패했습니다.');
    }
}

export async function handleEntryLiveToggle(uid, live) {
    const settings = getSettings();
    try {
        // live는 순수 LL 메타데이터(WI 필드 아님) → setMetadata가 알아서 저장.
        // organize 때 이 플래그된 엔트리만 풀 내용으로 보내 갱신한다.
        setMetadata(uid, { live }, settings.targetLorebook);
        clearSelectionCache();
        await refreshPanel();
        toastr.info(live
            ? '🔄 업데이트 대상 지정 — 기억 정리 때 이 엔트리를 갱신합니다.'
            : '업데이트 대상 해제됨.');
    } catch (err) {
        console.error(`${LOG_PREFIX} Live toggle failed:`, err);
        toastr.error(err.message || '처리에 실패했습니다.');
    }
}

export async function handleEntryPinToggle(uid, pinned) {
    const settings = getSettings();
    try {
        const data = await loadTargetLorebook();
        if (!data?.entries?.[uid]) throw new Error('엔트리를 찾을 수 없습니다');

        setEntryPinned(data, uid, pinned);
        await saveLorebook(settings.targetLorebook, data);
        refreshEditor();
        clearSelectionCache();
        await refreshPanel();
        toastr.info(pinned ? '📌 핀됨 — 항상 inject됩니다.' : '핀 해제됨.');
    } catch (err) {
        console.error(`${LOG_PREFIX} Pin toggle failed:`, err);
        toastr.error(err.message || '처리에 실패했습니다.');
    }
}

export async function handleEntryDelete(uid) {
    const settings = getSettings();
    if (!confirm('이 엔트리를 완전히 삭제하시겠습니까? 되돌릴 수 없습니다.')) return;

    try {
        const data = await loadTargetLorebook();
        if (!data?.entries?.[uid]) throw new Error('엔트리를 찾을 수 없습니다');

        deleteEntry(data, uid, settings.targetLorebook);
        await saveLorebook(settings.targetLorebook, data);
        refreshEditor();
        toastr.success('삭제되었습니다.');
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Delete failed:`, err);
        toastr.error(err.message || '삭제에 실패했습니다.');
    }
}
