import { l, lt } from './i18n.js';
/**
 * UI — 엔트리 편집/토글 액션 (타임라인 카드에서).
 * 인라인 편집 + 하이드/LIVE/핀 토글 + 삭제. 저장 후 refreshPanel()로 타임라인 갱신.
 */

import { escapeHtml, escapeAttr, refreshPanel } from './ui-shared.js';
import {
    getSettings,
    loadTargetLorebook, saveLorebook, refreshEditor,
    getMetadata, stageMetadata, updateEntryFields, enableEntry, deactivateEntry, setEntryPinned, setMetadata, deleteEntry,
} from './lore-store.js';
import { clearSelectionCache } from './summary-retrieval.js';

const LOG_PREFIX = '[LivingLorebook]';

const CATEGORY_LABELS = {
    arc: l('ll.687bf8f66ea0f585', "Story Arc"),
    character: l('ll.280f69c4a593505d', "Characters"), relationship: l('ll.18ab6599abaaab1b', "Relationships"), location: l('ll.61eaecc09cb7e53d', "Locations"),
    event: l('ll.d04be92d4a8150be', "Events"), routine: l('ll.2513c886e137082c', "Routines"), item: l('ll.976d37728f17ec71', "Items"), fact: l('ll.category.fact', "Facts"),
};

export function openInlineEditor(card, uid) {
    if (!card) return;
    if (card.classList.contains('ll-editing')) return; // 이미 편집 중

    const title = card.querySelector('.ll-entry-title')?.textContent.replace(/HIDE\s*$/, '').trim() || '';
    const rawContent = card.querySelector('.ll-entry-content')?.dataset?.raw || '';
    const currentCat = card.dataset.category || 'fact';
    const metadata = getMetadata(uid, getSettings().targetLorebook) || {};
    const currentKeywords = Array.from(card.querySelectorAll('.ll-entry-keyword')).map(el => el.textContent);

    card.classList.add('ll-editing');

    const editForm = document.createElement('div');
    editForm.className = 'll-entry-edit-form';
    editForm.innerHTML = lt('ll.9fddc29bcbb92317')`
        <div class="ll-edit-row">
            <label>Title</label>
            <input type="text" class="ll-edit-title" value="${escapeAttr(title)}" />
        </div>
        <div class="ll-edit-row">
            <label>Category</label>
            <select class="ll-edit-cat">
                ${Object.entries(CATEGORY_LABELS).map(([k, v]) =>
                    `<option value="${k}"${currentCat === k ? ' selected' : ''}>${v}</option>`,
                ).join('')}
            </select>
        </div>
        <div class="ll-edit-row">
            <label>Content</label>
            <textarea class="ll-edit-content" rows="6">${escapeHtml(rawContent)}</textarea>
        </div>
        <div class="ll-edit-row">
            <label>Keywords (comma-separated)</label>
            <input type="text" class="ll-edit-keywords" value="${escapeAttr(currentKeywords.join(', '))}" />
        </div>
        <div class="ll-edit-row"><label>Names / aliases (comma-separated)</label><input class="ll-edit-aliases" value="${escapeAttr((metadata.aliases || []).join(', '))}" /></div>
        <div class="ll-edit-memory-state">
            <label class="ll-edit-check">
                <input class="ll-edit-open-loop" type="checkbox" ${metadata.openLoop ? 'checked' : ''} />
                <span>Unresolved matters</span>
            </label>
            <div class="ll-edit-hint">Mark outstanding promises, goals, or conflicts. Related name mentions can prioritize this memory.</div>
            <div class="ll-edit-hint">${metadata.live ? l('ll.6b8db5457dbdb9f2', "LIVE is on · The AI can update completion status during memory organization.") : l('ll.82dba1ad43450e29', "LIVE is off · Enable LIVE on this entry to let the AI update this flag.")}</div>
        </div>
        <div class="ll-edit-actions">
            <button class="ll-edit-cancel">Cancel</button>
            <button class="ll-edit-save">Save</button>
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
    const settings = structuredClone(getSettings());
    const newTitle = form.querySelector('.ll-edit-title')?.value?.trim() || 'untitled';
    const newContent = form.querySelector('.ll-edit-content')?.value?.trim() || '';
    const newCat = form.querySelector('.ll-edit-cat')?.value || 'fact';
    const keywordsRaw = form.querySelector('.ll-edit-keywords')?.value || '';
    const newKeywords = keywordsRaw.split(',').map(k => k.trim()).filter(Boolean);

    try {
        const data = await loadTargetLorebook();
        if (!data) throw new Error(l('ll.348562f0779ac6cd', "Could not load the lorebook."));

        updateEntryFields(data, uid, {
            title: newTitle,
            content: newContent,
            keywords: newKeywords,
            category: newCat,
        }, settings.targetLorebook);

        stageMetadata(data, uid, {
            aliases: (form.querySelector('.ll-edit-aliases')?.value || '').split(',').map(v => v.trim()).filter(Boolean),
            openLoop: !!form.querySelector('.ll-edit-open-loop')?.checked,
        }, settings.targetLorebook);
        await saveLorebook(settings.targetLorebook, data);
        clearSelectionCache();
        refreshEditor();
        toastr.success(l('ll.ba971bfea1b3477d', "Saved."));
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Edit save failed:`, err);
        toastr.error(err.message || l('ll.f9cf47b313962996', "Save failed."));
    }
}

export async function handleEntryHideToggle(uid) {
    const settings = structuredClone(getSettings());
    try {
        const data = await loadTargetLorebook();
        if (!data?.entries?.[uid]) throw new Error(l('ll.1081a83f7d861645', "Entry not found."));

        const entry = data.entries[uid];
        if (entry.disable) {
            enableEntry(data, uid);
            toastr.info(l('ll.87b4ad24d811b2bf', "Entry enabled."));
        } else {
            deactivateEntry(data, uid);
            toastr.info(l('ll.660d8489c2ec4c9c', "Entry hidden."));
        }

        await saveLorebook(settings.targetLorebook, data);
        refreshEditor();
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Hide toggle failed:`, err);
        toastr.error(err.message || l('ll.cd261a6ef8beab97', "Operation failed."));
    }
}

export async function handleEntryLiveToggle(uid, live) {
    const settings = structuredClone(getSettings());
    try {
        // live는 순수 LL 메타데이터(WI 필드 아님) → setMetadata가 알아서 저장.
        // organize 때 이 플래그된 엔트리만 풀 내용으로 보내 갱신한다.
        await setMetadata(uid, { live }, settings.targetLorebook);
        clearSelectionCache();
        await refreshPanel();
        toastr.info(live
            ? l('ll.a07dbf2610209952', "🔄 LIVE enabled — this entry can be updated during memory organization.")
            : l('ll.1f011581aa03d92a', "LIVE disabled."));
    } catch (err) {
        console.error(`${LOG_PREFIX} Live toggle failed:`, err);
        toastr.error(err.message || l('ll.cd261a6ef8beab97', "Operation failed."));
    }
}

export async function handleEntryPinToggle(uid, pinned) {
    const settings = structuredClone(getSettings());
    try {
        const data = await loadTargetLorebook();
        if (!data?.entries?.[uid]) throw new Error(l('ll.1081a83f7d861645', "Entry not found."));

        setEntryPinned(data, uid, pinned);
        await saveLorebook(settings.targetLorebook, data);
        refreshEditor();
        clearSelectionCache();
        await refreshPanel();
        toastr.info(pinned ? l('ll.6fcdaf275990fc70', "📌 Pinned — always selected, subject to token limits.") : l('ll.b6255d2040def1e1', "Unpinned."));
    } catch (err) {
        console.error(`${LOG_PREFIX} Pin toggle failed:`, err);
        toastr.error(err.message || l('ll.cd261a6ef8beab97', "Operation failed."));
    }
}

export async function handleEntryDelete(uid) {
    const settings = structuredClone(getSettings());
    if (!confirm(l('ll.dec17b6f3883b782', "Permanently delete this entry? This cannot be undone."))) return;

    try {
        const data = await loadTargetLorebook();
        if (!data?.entries?.[uid]) throw new Error(l('ll.1081a83f7d861645', "Entry not found."));

        deleteEntry(data, uid, settings.targetLorebook);
        await saveLorebook(settings.targetLorebook, data);
        refreshEditor();
        toastr.success(l('ll.977dfc49dbc7d8b2', "Deleted."));
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Delete failed:`, err);
        toastr.error(err.message || l('ll.f318d8a511e3ec54', "Delete failed."));
    }
}
