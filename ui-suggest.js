import { l, lt } from './i18n.js';
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
    modal.innerHTML = lt('ll.d06480d8543c18a8')`
        <div class="ll-suggest-header">
            <div class="ll-suggest-title">
                <i class="fa-solid fa-wand-magic-sparkles"></i> World Suggestions
            </div>
            <button class="ll-suggest-close" title="Close">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>

        <div class="ll-suggest-body">
            <div class="ll-suggest-section">
                <label class="ll-suggest-label">Extra world details (optional)</label>
                <textarea class="ll-suggest-req" id="ll_suggest_req" rows="4"
                    placeholder="Example: the protagonist lives in a studio apartment; add two nearby cafés..."></textarea>
                <div class="ll-suggest-actions-top">
                    <button class="ll-suggest-btn ll-suggest-btn-secondary" id="ll_suggest_regen">
                        <i class="fa-solid fa-arrows-rotate"></i> Get / Refresh Suggestions
                    </button>
                </div>
            </div>

            <div class="ll-suggest-section">
                <div class="ll-suggest-list-header">
                    <label class="ll-suggest-label">Suggested Entries</label>
                    <div class="ll-suggest-list-controls">
                        <button class="ll-suggest-mini-btn" id="ll_suggest_all">Select All</button>
                        <button class="ll-suggest-mini-btn" id="ll_suggest_none">Deselect All</button>
                    </div>
                </div>
                <div class="ll-suggest-list" id="ll_suggest_list">
                    <div class="ll-suggest-empty">
                        No suggestions yet. Click "Get Suggestions" above.
                    </div>
                </div>
            </div>
        </div>

        <div class="ll-suggest-footer">
            <button class="ll-suggest-btn ll-suggest-btn-cancel" id="ll_suggest_cancel">Cancel</button>
            <button class="ll-suggest-btn ll-suggest-btn-primary" id="ll_suggest_generate">
                <i class="fa-solid fa-check"></i> Create Selected Entries
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
        toastr.warning(l('ll.1c7e28934a4ba644', "Select a target lorebook first."));
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
        list.innerHTML = lt('ll.c3fe3c83c38f85d9')`<div class="ll-suggest-empty">No suggestions yet. Click "Get Suggestions" above.</div>`;
        return;
    }

    const catLabels = {
        arc: l('ll.687bf8f66ea0f585', "Story Arc"),
        character: l('ll.280f69c4a593505d', "Characters"), relationship: l('ll.18ab6599abaaab1b', "Relationships"), location: l('ll.61eaecc09cb7e53d', "Locations"),
        event: l('ll.d04be92d4a8150be', "Events"), routine: l('ll.2513c886e137082c', "Routines"), item: l('ll.976d37728f17ec71', "Items"), fact: l('ll.115bced49291a6a0', "Settings"),
    };

    list.innerHTML = suggestState.suggestions.map((s, i) => lt('ll.7ecf3d93b2056aab')`
        <div class="ll-suggest-item" data-idx="${i}">
            <label class="ll-suggest-item-head">
                <input type="checkbox" class="ll-suggest-item-check" checked />
                <select class="ll-suggest-item-cat">
                    ${Object.entries(catLabels).map(([k, v]) =>
                        `<option value="${k}"${s.category === k ? ' selected' : ''}>${v}</option>`,
                    ).join('')}
                </select>
                <input type="text" class="ll-suggest-item-title" value="${escapeAttr(s.title || '')}" placeholder="Title" />
            </label>
            <div class="ll-suggest-item-reason">${escapeHtml(s.reason || '')}</div>
            <textarea class="ll-suggest-item-draft" rows="2" placeholder="Extra notes / draft (optional)">${escapeHtml(s.content || '')}</textarea>
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
    btn.innerHTML = l('ll.078fcb8d0ea5bc2b', "<i class=\"fa-solid fa-spinner fa-spin\"></i> Generating suggestions...");
    list.innerHTML = lt('ll.929223a6ed4c5376')`<div class="ll-suggest-empty"><i class="fa-solid fa-spinner fa-spin"></i> AI analysis in progress...</div>`;

    try {
        const suggestions = await suggestWorldEntries(
            suggestState.characterContext,
            suggestState.userRequirements,
        );
        suggestState.suggestions = suggestions;
        renderSuggestList();
        toastr.success(lt('ll.2f018ef85a1718d1')`${suggestions.length}suggestions received.`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Suggest failed:`, err);
        toastr.error(err.message || l('ll.31f6d430e401ad66', "Could not get suggestions."));
        list.innerHTML = lt('ll.497dcd6122b4a172')`<div class="ll-suggest-empty">Suggestion request failed. Try again.</div>`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = l('ll.7fa9c178eda3952e', "<i class=\"fa-solid fa-arrows-rotate\"></i> Get / Refresh Suggestions");
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
        toastr.warning(l('ll.8b025aefd221810a', "No items selected."));
        return;
    }

    const btn = document.getElementById('ll_suggest_generate');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = l('ll.33b25c5cc3a6db8e', "<i class=\"fa-solid fa-spinner fa-spin\"></i> Creating...");
    }

    try {
        const userReq = document.getElementById('ll_suggest_req')?.value || '';
        const created = await generateFromSuggestions(items, suggestState.characterContext, userReq);
        toastr.success(lt('ll.12f2f7ea0eb9e8fc')`${created.length}entries created.`);
        closeSuggestModal();
        refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Generate from suggestions failed:`, err);
        toastr.error(err.message || l('ll.a5f8da63ba2ccd44', "Entry creation failed."));
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = l('ll.3c0e2e80026affe6', "<i class=\"fa-solid fa-check\"></i> Create Selected Entries");
        }
    }
}
