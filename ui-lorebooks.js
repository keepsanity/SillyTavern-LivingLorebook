/**
 * UI — 로어북 관리 (설정 뷰의 "선택 소스 로어북" 영역).
 * 카드 리스트 렌더 + managed 전환 + summary 백필 + dropdown 채우기.
 * 패널 갱신은 ui-shared의 refreshPanel 레지스트리를 통해 (index 순환 의존 회피).
 */

import { world_names } from '../../../world-info.js';
import { escapeHtml, escapeAttr, refreshPanel } from './ui-shared.js';
import {
    getSettings, saveSettings,
    loadTargetLorebook, loadAnyLorebook,
    getMetadata, isManagedMode, getEffectiveSelectionLorebooks, migrateToManagedMode,
    rebuildLorebookMetadata,
} from './lore-store.js';
import { clearSelectionCache } from './summary-retrieval.js';
import { backfillSummaries } from './memory-manager.js';
import { getChatSelectionLorebooks, setChatSelectionLorebooks } from './chat-meta.js';

const LOG_PREFIX = '[LivingLorebook]';

/**
 * 특정 로어북에 대해 managed mode 전환/해제.
 */
async function handleMigrateLorebook(lorebookName, goingToManaged, btn) {
    const settings = getSettings();
    if (!lorebookName) return;
    if (btn?.dataset.busy === '1') return;

    const confirmMsg = goingToManaged
        ? `"${lorebookName}"을 managed mode로 전환합니다.\n\n• LL 메타데이터가 있는 엔트리의 키워드/벡터 활성화가 꺼집니다.\n• 우리 모듈이 setExtensionPrompt로 직접 주입합니다.\n• 외부 엔트리(메타 없음)는 건드리지 않습니다 — backfill 먼저 권장.\n\n계속하시겠습니까?`
        : `"${lorebookName}"의 managed mode를 해제합니다.\n\n• LL 엔트리의 ST 자동 활성화가 복구됩니다.\n• summary는 유지됩니다.\n\n계속하시겠습니까?`;

    if (!window.confirm(confirmMsg)) return;

    if (btn) {
        btn.dataset.busy = '1';
        btn.disabled = true;
        var origHTML = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }

    try {
        const result = await migrateToManagedMode(goingToManaged, lorebookName);
        const msg = goingToManaged
            ? `[${lorebookName}] ${result.converted}개 전환${result.skipped > 0 ? ` (외부 ${result.skipped}개 보존)` : ''}`
            : `[${lorebookName}] ${result.converted}개 복구`;
        toastr.success(msg);

        // 모든 lorebook이 unmanaged 상태면 AI 선택도 자동 OFF
        if (!goingToManaged) {
            const lbs = getEffectiveSelectionLorebooks();
            const anyManaged = lbs.some(name => isManagedMode(name));
            if (!anyManaged && settings.summarySelectionEnabled) {
                settings.summarySelectionEnabled = false;
                const enabledEl = document.querySelector('#ll_s_selection_enabled');
                if (enabledEl) enabledEl.checked = false;
                saveSettings();
                toastr.info('통제 중인 로어북이 없어 AI 선택을 자동으로 껐습니다.');
            }
        }

        clearSelectionCache();
        const panel = document.querySelector('.ll-panel');
        if (panel) renderSelectionLorebookList(panel);
    } catch (err) {
        console.error(`${LOG_PREFIX} Migrate failed:`, err);
        toastr.error(err.message || '전환에 실패했습니다.');
        if (btn) btn.innerHTML = origHTML;
    } finally {
        if (btn) {
            btn.dataset.busy = '';
            btn.disabled = false;
        }
    }
}


/**
 * 메타데이터 재구축 — 로어북 파일을 밖에서 교체했을 때 카테고리/키워드를 실제 엔트리에 맞춘다.
 */
async function handleRebuildMetadata(lorebookName, btn, panel) {
    if (!lorebookName) return;
    if (btn?.dataset.busy === '1') return;

    const settings = getSettings();
    const data = lorebookName === settings.targetLorebook
        ? await loadTargetLorebook()
        : await loadAnyLorebook(lorebookName);
    if (!data?.entries) {
        toastr.error(`로어북 "${lorebookName}"을 로드할 수 없습니다.`);
        return;
    }

    const count = Object.keys(data.entries).length;
    if (!window.confirm(`"${lorebookName}"의 LL 메타데이터를 현재 엔트리 ${count}개 기준으로 다시 만듭니다.\n\n`
        + `• 카테고리를 제목에서 다시 판정합니다 (AI 호출 없음)\n`
        + `• 지금 로어북에 없는 uid의 메타데이터는 제거합니다\n`
        + `• summary는 있으면 그대로 둡니다\n\n계속하시겠습니까?`)) return;

    btn.dataset.busy = '1';
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        const r = rebuildLorebookMetadata(lorebookName, data);
        const summary = Object.entries(r.byCategory)
            .sort((a, b) => b[1] - a[1])
            .map(([c, n]) => `${c} ${n}`)
            .join(' · ');
        toastr.success(`[${lorebookName}] 재구축 완료 — ${summary}`
            + (r.orphans > 0 ? ` (고아 ${r.orphans}개 제거)` : ''), 'LivingLorebook', { timeOut: 10000 });
        clearSelectionCache();
        renderSelectionLorebookList(panel);
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Rebuild metadata failed:`, err);
        toastr.error(err.message || '재구축에 실패했습니다.');
        btn.innerHTML = orig;
    } finally {
        btn.dataset.busy = '';
        btn.disabled = false;
    }
}

/**
 * 특정 로어북에 대해 summary 백필 (외부 로어북도 포함).
 */
async function handleBackfillLorebook(lorebookName, btn) {
    if (!lorebookName) return;
    if (btn?.dataset.busy === '1') return;

    if (btn) {
        btn.dataset.busy = '1';
        btn.disabled = true;
        var origHTML = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }

    try {
        const result = await backfillSummaries({
            lorebookName,
            onProgress: (done, total) => {
                if (btn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${done}/${total}`;
            },
        });
        toastr.success(`[${lorebookName}] summary 백필 완료: ${result.filled}개 생성, ${result.failed}개 실패 (총 ${result.total})`);
        clearSelectionCache();
        const panel = document.querySelector('.ll-panel');
        if (panel) renderSelectionLorebookList(panel);
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Backfill failed:`, err);
        toastr.error(err.message || '백필 실패');
        if (btn) btn.innerHTML = origHTML;
    } finally {
        if (btn) {
            btn.dataset.busy = '';
            btn.disabled = false;
        }
    }
}

/**
 * 로어북별 카운트(엔트리 수, summary 있는 수) 비동기 계산.
 */
async function getLorebookSummaryStats(lorebookName) {
    const settings = getSettings();
    try {
        const data = lorebookName === settings.targetLorebook
            ? await loadTargetLorebook()
            : await loadAnyLorebook(lorebookName);
        if (!data?.entries) return { total: 0, withSummary: 0 };
        let total = 0, withSummary = 0;
        for (const [uid, entry] of Object.entries(data.entries)) {
            if (entry.disable) continue;
            total++;
            const meta = getMetadata(uid, lorebookName);
            if (meta?.summary && meta.summary.trim()) withSummary++;
        }
        return { total, withSummary };
    } catch {
        return { total: 0, withSummary: 0 };
    }
}

/**
 * Target 로어북 dropdown 채우기 — ST의 모든 로어북 + 현재값 선택.
 */
export function populateTargetLorebookDropdown(panel) {
    const settings = getSettings();
    const select = panel.querySelector('#ll_s_target_lorebook');
    if (!select) return;
    const current = settings.targetLorebook || '';
    const all = world_names || [];
    select.innerHTML = '<option value="">(선택 안 됨)</option>';
    for (const name of [...all].sort()) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === current) opt.selected = true;
        select.appendChild(opt);
    }
}

/**
 * 추가 dropdown에 ST에 등록된 로어북 채우기 (이미 추가된 건 제외).
 */
export function populateAddLorebookDropdown(panel) {
    const settings = getSettings();
    const select = panel.querySelector('#ll_s_add_lorebook');
    if (!select) return;
    const current = new Set([settings.targetLorebook, ...getChatSelectionLorebooks()]);
    const all = world_names || [];
    select.innerHTML = '<option value="">+ 추가할 로어북 선택...</option>';
    for (const name of all) {
        if (current.has(name)) continue;
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    }
}

/**
 * 선택 소스 로어북 카드 리스트 렌더. targetLorebook은 항상 첫 카드, 제거 불가.
 */
export async function renderSelectionLorebookList(panel) {
    const settings = getSettings();
    const container = panel.querySelector('#ll_s_lorebook_list');
    if (!container) return;

    const target = settings.targetLorebook;
    const extras = getChatSelectionLorebooks();
    const all = [];
    if (target) all.push({ name: target, isTarget: true });
    for (const n of extras) {
        if (n !== target) all.push({ name: n, isTarget: false });
    }

    if (all.length === 0) {
        container.innerHTML = '<div style="font-size:11px;opacity:0.6;padding:8px;text-align:center;">등록된 로어북이 없습니다. targetLorebook을 먼저 설정하거나 위에서 추가해주세요.</div>';
        return;
    }

    container.innerHTML = all.map(item => `
        <div class="ll-lb-card" data-lorebook="${escapeAttr(item.name)}" style="border:1px solid var(--SmartThemeBorderColor, #444); border-radius:6px; padding:8px; background:rgba(255,255,255,0.02);">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <i class="fa-solid ${item.isTarget ? 'fa-star' : 'fa-book'}" style="color:${item.isTarget ? '#fbbf24' : '#81e6d9'};font-size:12px;"></i>
                <span style="flex:1;font-weight:bold;font-size:12px;">${escapeHtml(item.name)}</span>
                ${item.isTarget
                    ? '<span style="font-size:10px;opacity:0.6;">target — 항상 포함</span>'
                    : '<button class="ll-lb-remove" title="제거" style="background:none;border:none;color:#f87171;cursor:pointer;padding:2px 6px;font-size:11px;"><i class="fa-solid fa-xmark"></i></button>'}
            </div>
            <div class="ll-lb-stats" style="font-size:11px;opacity:0.7;margin-bottom:6px;">
                <span class="ll-lb-stats-text">로딩 중...</span>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button class="menu_button ll-lb-backfill" style="font-size:11px;padding:3px 8px;width:unset;">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> 백필
                </button>
                <button class="menu_button ll-lb-migrate" style="font-size:11px;padding:3px 8px;width:unset;">
                    <i class="fa-solid fa-arrow-right-arrow-left"></i> <span class="ll-lb-migrate-label">전환/해제</span>
                </button>
                <button class="menu_button ll-lb-rebuild" title="로어북 파일을 밖에서 바꿨을 때(복원/임포트) 카테고리를 다시 매깁니다" style="font-size:11px;padding:3px 8px;width:unset;">
                    <i class="fa-solid fa-wrench"></i> 메타 재구축
                </button>
            </div>
        </div>
    `).join('');

    // 비동기 stats 채우기 + migrate 라벨 갱신
    for (const item of all) {
        const card = container.querySelector(`.ll-lb-card[data-lorebook="${CSS.escape(item.name)}"]`);
        if (!card) continue;
        const statsEl = card.querySelector('.ll-lb-stats-text');
        const migrateLabel = card.querySelector('.ll-lb-migrate-label');
        const migrateBtn = card.querySelector('.ll-lb-migrate');

        getLorebookSummaryStats(item.name).then(({ total, withSummary }) => {
            const managed = isManagedMode(item.name);
            const ratio = total > 0 ? Math.round((withSummary / total) * 100) : 0;
            statsEl.innerHTML = `${total}개 엔트리 · summary ${withSummary}/${total} (${ratio}%) · <span style="color:${managed ? '#10b981' : '#f59e0b'};">${managed ? 'managed ON' : 'managed OFF'}</span>`;
            if (migrateLabel) migrateLabel.textContent = managed ? 'managed 해제' : 'managed 전환';
            if (migrateBtn) migrateBtn.dataset.managed = managed ? '1' : '0';
        });
    }

    // 이벤트 위임
    container.querySelectorAll('.ll-lb-card').forEach(card => {
        const name = card.dataset.lorebook;
        const removeBtn = card.querySelector('.ll-lb-remove');
        const backfillBtn = card.querySelector('.ll-lb-backfill');
        const migrateBtn = card.querySelector('.ll-lb-migrate');

        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                if (!window.confirm(`"${name}"을 선택 소스에서 제거합니다. (로어북 자체는 삭제되지 않음)\n\n계속?`)) return;
                const next = getChatSelectionLorebooks().filter(n => n !== name);
                setChatSelectionLorebooks(next);
                renderSelectionLorebookList(panel);
                populateAddLorebookDropdown(panel);
            });
        }
        if (backfillBtn) {
            backfillBtn.addEventListener('click', () => handleBackfillLorebook(name, backfillBtn));
        }
        const rebuildBtn = card.querySelector('.ll-lb-rebuild');
        if (rebuildBtn) {
            rebuildBtn.addEventListener('click', () => handleRebuildMetadata(name, rebuildBtn, panel));
        }
        if (migrateBtn) {
            migrateBtn.addEventListener('click', () => {
                const goingTo = migrateBtn.dataset.managed !== '1';
                handleMigrateLorebook(name, goingTo, migrateBtn);
            });
        }
    });
}
