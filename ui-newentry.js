import { l, lt } from './i18n.js';
/**
 * UI — 새 엔트리(수동 생성) 모달.
 * Target 로어북에 카테고리/제목/내용을 직접 입력해 엔트리 1개 추가. 생성 로직은 world-builder.createManualEntry.
 */

import { CATEGORIES, escapeHtml, refreshPanel } from './ui-shared.js';
import { getSettings } from './lore-store.js';
import { clearSelectionCache } from './summary-retrieval.js';
import { createManualEntry } from './world-builder.js';

const LOG_PREFIX = '[LivingLorebook]';

export function openNewEntryModal() {
    const s = getSettings();
    if (!s.targetLorebook) {
        toastr.warning(l('ll.06def69837fcc543', "Select a target lorebook in settings first."), 'LivingLorebook');
        return;
    }

    // 카테고리 옵션 — arc(줄거리)는 organize/arc 자동 생성 전용이라 수동 목록에서 제외
    const catOptions = Object.entries(CATEGORIES)
        .filter(([k]) => k !== 'arc')
        .map(([k, c]) => `<option value="${k}"${k === 'fact' ? ' selected' : ''}>${c.iconChar} ${c.label}</option>`)
        .join('');

    const modal = document.createElement('dialog');
    modal.className = 'll-suggest-modal ll-newentry-modal';
    modal.innerHTML = lt('ll.147fe6b0afd6602e')`
        <div class="ll-suggest-header">
            <div class="ll-suggest-title"><i class="fa-solid fa-plus"></i> New Entry</div>
            <button class="ll-suggest-close" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="ll-suggest-body">
            <div class="ll-suggest-section">
                <label class="ll-suggest-label">Category</label>
                <select class="ll-suggest-item-cat" id="ll_new_cat" style="width:100%;">${catOptions}</select>
            </div>
            <div class="ll-suggest-section">
                <label class="ll-suggest-label">Title</label>
                <input type="text" class="ll-suggest-item-title" id="ll_new_title" style="width:100%;" placeholder="Title" />
            </div>
            <div class="ll-suggest-section">
                <label class="ll-suggest-label">Content</label>
                <textarea class="ll-suggest-req" id="ll_new_content" rows="7" placeholder="Write the entry content here..."></textarea>
            </div>
            <div style="font-size:11px;opacity:0.6;line-height:1.4;">
                Target lorebook <b>${escapeHtml(s.targetLorebook)}</b> will receive this entry.
                In managed mode, native keys are empty and LL controls selection.
            </div>
        </div>
        <div class="ll-suggest-footer">
            <button class="ll-suggest-btn ll-suggest-btn-cancel" id="ll_new_cancel">Cancel</button>
            <button class="ll-suggest-btn ll-suggest-btn-primary" id="ll_new_create"><i class="fa-solid fa-check"></i> Create</button>
        </div>
    `;
    document.body.appendChild(modal);
    modal.showModal();

    const close = () => { modal.close(); modal.remove(); };
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('.ll-suggest-close').addEventListener('click', close);
    modal.querySelector('#ll_new_cancel').addEventListener('click', close);

    const createBtn = modal.querySelector('#ll_new_create');
    createBtn.addEventListener('click', async () => {
        const title = modal.querySelector('#ll_new_title').value.trim();
        const content = modal.querySelector('#ll_new_content').value;
        const category = modal.querySelector('#ll_new_cat').value;
        if (!title) {
            toastr.warning(l('ll.c5348ab5543850dd', "Enter a title."), 'LivingLorebook');
            return;
        }
        createBtn.disabled = true;
        createBtn.innerHTML = l('ll.33b25c5cc3a6db8e', "<i class=\"fa-solid fa-spinner fa-spin\"></i> Creating...");
        try {
            const res = await createManualEntry({ title, content, category });
            clearSelectionCache();   // 새 후보 추가 → 선택 캐시 무효화
            close();
            await refreshPanel();
            toastr.success(lt('ll.7041168d699daf1d')`"${res.title}" Entry added`, 'LivingLorebook');
        } catch (err) {
            console.error(`${LOG_PREFIX} manual entry create failed:`, err);
            toastr.error(err.message || l('ll.fc1065f3fa7265d7', "Entry creation failed."), 'LivingLorebook');
            createBtn.disabled = false;
            createBtn.innerHTML = l('ll.c48aa4bd0429d61b', "<i class=\"fa-solid fa-check\"></i> Create");
        }
    });

    setTimeout(() => modal.querySelector('#ll_new_title')?.focus(), 50);
}
