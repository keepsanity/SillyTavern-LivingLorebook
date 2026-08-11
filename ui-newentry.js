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
        toastr.warning('먼저 설정에서 Target 로어북을 선택해주세요.', 'LivingLorebook');
        return;
    }

    // 카테고리 옵션 — arc(줄거리)는 organize/arc 자동 생성 전용이라 수동 목록에서 제외
    const catOptions = Object.entries(CATEGORIES)
        .filter(([k]) => k !== 'arc')
        .map(([k, c]) => `<option value="${k}"${k === 'fact' ? ' selected' : ''}>${c.iconChar} ${c.label}</option>`)
        .join('');

    const modal = document.createElement('dialog');
    modal.className = 'll-suggest-modal ll-newentry-modal';
    modal.innerHTML = `
        <div class="ll-suggest-header">
            <div class="ll-suggest-title"><i class="fa-solid fa-plus"></i> 새 엔트리</div>
            <button class="ll-suggest-close" title="닫기"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="ll-suggest-body">
            <div class="ll-suggest-section">
                <label class="ll-suggest-label">카테고리</label>
                <select class="ll-suggest-item-cat" id="ll_new_cat" style="width:100%;">${catOptions}</select>
            </div>
            <div class="ll-suggest-section">
                <label class="ll-suggest-label">제목</label>
                <input type="text" class="ll-suggest-item-title" id="ll_new_title" style="width:100%;" placeholder="제목" />
            </div>
            <div class="ll-suggest-section">
                <label class="ll-suggest-label">내용</label>
                <textarea class="ll-suggest-req" id="ll_new_content" rows="7" placeholder="엔트리 본문을 자유롭게 입력하세요..."></textarea>
            </div>
            <div style="font-size:11px;opacity:0.6;line-height:1.4;">
                Target 로어북 <b>${escapeHtml(s.targetLorebook)}</b> 에 추가됩니다.
                managed mode면 키워드 없이 저장되고 LL 선택 엔진이 주입을 통제합니다.
            </div>
        </div>
        <div class="ll-suggest-footer">
            <button class="ll-suggest-btn ll-suggest-btn-cancel" id="ll_new_cancel">취소</button>
            <button class="ll-suggest-btn ll-suggest-btn-primary" id="ll_new_create"><i class="fa-solid fa-check"></i> 생성</button>
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
            toastr.warning('제목을 입력해주세요.', 'LivingLorebook');
            return;
        }
        createBtn.disabled = true;
        createBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 생성 중...';
        try {
            const res = await createManualEntry({ title, content, category });
            clearSelectionCache();   // 새 후보 추가 → 선택 캐시 무효화
            close();
            await refreshPanel();
            toastr.success(`"${res.title}" 엔트리 추가됨`, 'LivingLorebook');
        } catch (err) {
            console.error(`${LOG_PREFIX} manual entry create failed:`, err);
            toastr.error(err.message || '엔트리 생성 실패', 'LivingLorebook');
            createBtn.disabled = false;
            createBtn.innerHTML = '<i class="fa-solid fa-check"></i> 생성';
        }
    });

    setTimeout(() => modal.querySelector('#ll_new_title')?.focus(), 50);
}
