import { l, lt } from './i18n.js';
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
        ? lt('ll.1765460038ff665f')`"${lorebookName}"will switch to managed mode.\n\n• Native keyword/vector activation will be disabled for entries with LL metadata.\n• LL will select entries through World Info.\n• External entries without metadata remain unchanged.\n\nContinue?`
        : lt('ll.2636188eb747e799')`"${lorebookName}"will leave managed mode.\n\n• Native ST activation will be restored for LL entries.\n• Summaries will be retained.\n\nContinue?`;

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
            ? lt('ll.3beced3b9b70ff8c')`[${lorebookName}] ${result.converted}switched${result.skipped > 0 ? lt('ll.a831b397e1460c7a')` (external: ${result.skipped}preserved)` : ''}`
            : lt('ll.fca73e1ede6654ec')`[${lorebookName}] ${result.converted}restored`;
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
                toastr.info(l('ll.8c824ce3f6a4151b', "Automatic selection was disabled because no managed lorebooks remain."));
            }
        }

        clearSelectionCache();
        const panel = document.querySelector('.ll-panel');
        if (panel) renderSelectionLorebookList(panel);
    } catch (err) {
        console.error(`${LOG_PREFIX} Migrate failed:`, err);
        toastr.error(err.message || l('ll.6f7d7047fcb559d4', "Could not switch mode."));
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
        toastr.error(lt('ll.5a1b112120659992')`Lorebook "${lorebookName}"could not be loaded.`);
        return;
    }

    const count = Object.keys(data.entries).length;
    if (!window.confirm(lt('ll.90c22ae55529b915')`"${lorebookName}"will have its LL metadata rebuilt from ${count}current entries.\n\n`
        + lt('ll.574a6eadc8b764ea')`• Categories are inferred from titles (no AI call).\n`
        + lt('ll.d9ccf7b29556bee9')`• Metadata for missing UIDs is removed.\n`
        + lt('ll.794c3ddddcfdbcd0')`• Existing summaries are preserved.\n\nContinue?`)) return;

    btn.dataset.busy = '1';
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        const r = await rebuildLorebookMetadata(lorebookName, data);
        const summary = Object.entries(r.byCategory)
            .sort((a, b) => b[1] - a[1])
            .map(([c, n]) => `${c} ${n}`)
            .join(' · ');
        toastr.success(lt('ll.7ec288b2230ef255')`[${lorebookName}] Metadata rebuilt — ${summary}`
            + (r.orphans > 0 ? lt('ll.cf9e656e334a8fdf')` (orphaned: ${r.orphans}removed)` : ''), 'LivingLorebook', { timeOut: 10000 });
        clearSelectionCache();
        renderSelectionLorebookList(panel);
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Rebuild metadata failed:`, err);
        toastr.error(err.message || l('ll.718eb8cafbd4601d', "Metadata rebuild failed."));
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
        toastr.success(lt('ll.c5168303a497dcd8')`[${lorebookName}] Summary backfill complete: ${result.filled}created, ${result.failed}failed (total: ${result.total})`);
        clearSelectionCache();
        const panel = document.querySelector('.ll-panel');
        if (panel) renderSelectionLorebookList(panel);
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Backfill failed:`, err);
        toastr.error(err.message || l('ll.07442e1b0f9d91d5', "Backfill failed"));
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
    select.innerHTML = l('ll.b7368af3e52a457c', "<option value=\"\">(None selected)</option>");
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
    select.innerHTML = l('ll.b6931a694d939984', "<option value=\"\">+ Select a lorebook to add...</option>");
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
        container.innerHTML = l('ll.18a41569e21983db', "<div style=\"font-size:11px;opacity:0.6;padding:8px;text-align:center;\">No lorebooks registered. Select a target lorebook or add one above.</div>");
        return;
    }

    container.innerHTML = all.map(item => lt('ll.e7c9adb295026a4f')`
        <div class="ll-lb-card" data-lorebook="${escapeAttr(item.name)}" style="border:1px solid var(--SmartThemeBorderColor, #444); border-radius:6px; padding:8px; background:rgba(255,255,255,0.02);">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <i class="fa-solid ${item.isTarget ? 'fa-star' : 'fa-book'}" style="color:${item.isTarget ? '#fbbf24' : '#81e6d9'};font-size:12px;"></i>
                <span style="flex:1;font-weight:bold;font-size:12px;">${escapeHtml(item.name)}</span>
                ${item.isTarget
                    ? l('ll.240ea96b434b8e51', "<span style=\"font-size:10px;opacity:0.6;\">target — always included</span>")
                    : l('ll.9e0401d4e55f5111', "<button class=\"ll-lb-remove\" title=\"Remove\" style=\"background:none;border:none;color:#f87171;cursor:pointer;padding:2px 6px;font-size:11px;\"><i class=\"fa-solid fa-xmark\"></i></button>")}
            </div>
            <div class="ll-lb-stats" style="font-size:11px;opacity:0.7;margin-bottom:6px;">
                <span class="ll-lb-stats-text">Loading...</span>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button class="menu_button ll-lb-backfill" style="font-size:11px;padding:3px 8px;width:unset;">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> Backfill
                </button>
                <button class="menu_button ll-lb-migrate" style="font-size:11px;padding:3px 8px;width:unset;">
                    <i class="fa-solid fa-arrow-right-arrow-left"></i> <span class="ll-lb-migrate-label">Switch mode</span>
                </button>
                <button class="menu_button ll-lb-rebuild" title="Rebuild categories after restoring or importing a lorebook file" style="font-size:11px;padding:3px 8px;width:unset;">
                    <i class="fa-solid fa-wrench"></i> Rebuild metadata
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
            statsEl.innerHTML = lt('ll.8939e3c90f198a28')`${total}entries · summaries: ${withSummary}/${total} (${ratio}%) · <span style="color:${managed ? '#10b981' : '#f59e0b'};">${managed ? 'managed ON' : 'managed OFF'}</span>`;
            if (migrateLabel) migrateLabel.textContent = managed ? l('ll.fdf5133d1c772116', "Disable managed mode") : l('ll.76b8c1616f40a701', "Enable managed mode");
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
                if (!window.confirm(lt('ll.9066a4ba9ebb5777')`"${name}"will be removed from selection sources. The lorebook itself will not be deleted.\n\nContinue?`)) return;
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
