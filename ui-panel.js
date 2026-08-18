/**
 * UI — 패널 본체: 생성/열고닫기/뷰 전환 + 타임라인 렌더 + 상태바.
 *
 * 패널 뷰 상태(currentView/activeFilter)를 여기서 소유한다.
 * refreshPanel은 다른 UI 모듈이 순환 import 없이 쓸 수 있게 ui-shared 레지스트리에 등록한다.
 */

import { characters, this_chid } from '../../../../script.js';
import { world_names, createNewWorldInfo } from '../../../world-info.js';
import { CATEGORIES, escapeHtml, escapeAttr, registerRefreshPanel, populateLorebookDropdown } from './ui-shared.js';
import {
    getSettings, loadTargetLorebook, getMetadata, CATEGORY_TAGS,
    calculateSelectionStorage, getEffectiveSelectionLorebooks,
} from './lore-store.js';
import { getLastInjectionStats } from './summary-retrieval.js';
import { refreshVectorStatus } from './ui-settings.js';
import { setChatLorebook } from './chat-meta.js';
import { PANEL_HTML } from './ui-panel-template.js';
import { bindSettingsInputs } from './ui-settings.js';
import { handleToolbarAction } from './ui-toolbar.js';
import { populateTargetLorebookDropdown, populateAddLorebookDropdown } from './ui-lorebooks.js';
import { openInlineEditor, handleEntryHideToggle, handleEntryLiveToggle, handleEntryPinToggle, handleEntryDelete } from './ui-entry.js';

const LOG_PREFIX = '[LivingLorebook]';

// 패널 뷰 상태
let currentView = 'timeline'; // 'timeline' | 'settings'
let activeFilter = 'all';

// ============================================================
// Panel
// ============================================================

export function createPanel() {
    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'll-panel-overlay';
    overlay.addEventListener('click', closePanel);
    document.body.appendChild(overlay);

    // Panel
    const panel = document.createElement('div');
    panel.className = 'll-panel';
    panel.innerHTML = PANEL_HTML;
    document.body.appendChild(panel);

    // Bind panel events
    bindPanelEvents(panel);
}

// 세계관 제안 모달 UI는 ui-suggest.js로 분리됨 (createSuggestModal / openSuggestModal import)

function bindPanelEvents(panel) {
    // Close
    panel.querySelector('.ll-btn-close').addEventListener('click', closePanel);

    // Settings toggle
    panel.querySelector('.ll-btn-settings').addEventListener('click', () => {
        if (currentView === 'settings') {
            switchView('timeline');
        } else {
            switchView('settings');
        }
    });

    // Toolbar actions
    panel.querySelectorAll('.ll-toolbar-btn[data-action]').forEach(btn => {
        btn.addEventListener('click', () => handleToolbarAction(btn.dataset.action));
    });

    // Filter chips
    panel.querySelectorAll('.ll-filter-chip[data-filter]').forEach(chip => {
        chip.addEventListener('click', () => {
            panel.querySelectorAll('.ll-filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            activeFilter = chip.dataset.filter;
            renderTimeline();
        });
    });

    // Refresh
    panel.querySelector('.ll-btn-refresh').addEventListener('click', () => refreshPanel());

    // Storage / Inject 칩 클릭 → breakdown 토스트
    panel.querySelector('#ll_stat_storage_box')?.addEventListener('click', showStorageBreakdown);
    panel.querySelector('#ll_stat_inject_box')?.addEventListener('click', showInjectBreakdown);

    // Settings inputs
    bindSettingsInputs(panel);
}

// 설정 뷰 바인딩은 ui-settings.js로 분리됨 (bindSettingsInputs / refreshVectorStatus import)

// ============================================================
// Panel Open / Close
// ============================================================

export function togglePanel() {
    const panel = document.querySelector('.ll-panel');
    if (panel?.classList.contains('open')) {
        closePanel();
    } else {
        openPanel();
    }
}

export function openPanel() {
    document.querySelector('.ll-panel-overlay')?.classList.add('open');
    document.querySelector('.ll-panel')?.classList.add('open');
    document.querySelector('.ll-float-trigger')?.classList.add('active');
    switchView('timeline');
    refreshPanel();
}

export function closePanel() {
    document.querySelector('.ll-panel-overlay')?.classList.remove('open');
    document.querySelector('.ll-panel')?.classList.remove('open');
    document.querySelector('.ll-float-trigger')?.classList.remove('active');
    // Hide world input
    document.querySelector('.ll-world-input-row')?.classList.remove('active');
}

function switchView(view) {
    currentView = view;
    const timeline = document.getElementById('ll_timeline');
    const settingsView = document.getElementById('ll_settings_view');
    const filterBar = document.querySelector('.ll-filter-bar');
    const toolbar = document.querySelector('.ll-toolbar');
    const settingsBtn = document.querySelector('.ll-btn-settings i');

    if (view === 'settings') {
        timeline.style.display = 'none';
        filterBar.style.display = 'none';
        toolbar.style.display = 'none';
        settingsView.classList.add('active');
        settingsBtn.className = 'fa-solid fa-arrow-left';
        // 매 settings view 진입 시 전부 재렌더 (stale 방지).
        // ⚠️ 상태줄(refreshVectorStatus)도 반드시 같이 — 안 그러면 페이지 로드 직후
        // (채팅 복원 전, getCurrentChatId()=undefined)에 그려진 "열린 채팅 없음" 텍스트가
        // 남아서, 카드는 현재 채팅인데 상태줄은 옛 시점인 모순 화면이 된다.
        // (refreshVectorStatus가 내부에서 카드 리스트도 다시 그린다)
        const panel = document.querySelector('.ll-panel');
        if (panel) {
            populateAddLorebookDropdown(panel);
            populateTargetLorebookDropdown(panel);
            refreshVectorStatus();
        }
    } else {
        timeline.style.display = '';
        filterBar.style.display = '';
        toolbar.style.display = '';
        settingsView.classList.remove('active');
        settingsBtn.className = 'fa-solid fa-gear';
        renderTimeline();
    }
}

// ============================================================
// Timeline Rendering
// ============================================================

async function renderTimeline() {
    const settings = getSettings();
    const container = document.getElementById('ll_timeline');
    if (!container) return;

    if (!settings.targetLorebook) {
        // 로어북 드롭다운 옵션 생성
        const names = world_names || [];
        const options = [...names].sort().map(n => `<option value="${n}">${n}</option>`).join('');

        container.innerHTML = `
            <div class="ll-empty">
                <i class="fa-solid fa-book-open"></i>
                <span>대상 로어북을 선택해주세요</span>
                <div class="ll-empty-actions">
                    <select class="ll-empty-select" id="ll_empty_lorebook">
                        <option value="">-- 기존 로어북 선택 --</option>
                        ${options}
                    </select>
                    <button class="ll-empty-btn" id="ll_empty_create">
                        <i class="fa-solid fa-plus"></i> 새 로어북 자동 생성
                    </button>
                </div>
            </div>`;

        // 기존 로어북 선택
        container.querySelector('#ll_empty_lorebook')?.addEventListener('change', (e) => {
            const val = e.target.value;
            if (!val) return;
            setChatLorebook(val);
            // 사이드바 드롭다운도 동기화
            $('#ll_target_lorebook').val(val);
            renderTimeline();
            updateStatusBar();
            toastr.success(`로어북 "${val}" 이 연결되었습니다.`);
        });

        // 새 로어북 자동 생성
        container.querySelector('#ll_empty_create')?.addEventListener('click', async () => {
            const charName = (this_chid !== undefined && characters[this_chid])
                ? characters[this_chid].name
                : 'LivingLorebook';
            const newName = `LL_${charName}`;
            try {
                await createNewWorldInfo(newName);
                setChatLorebook(newName);
                populateLorebookDropdown();
                $('#ll_target_lorebook').val(newName);
                toastr.success(`로어북 "${newName}" 이 생성되었습니다.`);
                renderTimeline();
                updateStatusBar();
            } catch (err) {
                toastr.error('로어북 생성에 실패했습니다.');
            }
        });

        return;
    }

    let data;
    try {
        data = await loadTargetLorebook();
    } catch {
        // 로어북이 삭제됐거나 로드 실패 → 연결 해제 후 선택 UI 표시
        setChatLorebook('');
        $('#ll_target_lorebook').val('');
        return renderTimeline();
    }

    if (!data) {
        setChatLorebook('');
        $('#ll_target_lorebook').val('');
        return renderTimeline();
    }

    if (!data?.entries || Object.keys(data.entries).length === 0) {
        container.innerHTML = `
            <div class="ll-empty">
                <i class="fa-solid fa-brain"></i>
                <span>엔트리가 없습니다. "세계관 생성"으로 시작해보세요!</span>
            </div>`;
        return;
    }

    // Collect entries by category
    const grouped = {};
    for (const cat of Object.keys(CATEGORIES)) {
        grouped[cat] = [];
    }

    // content의 XML 태그에서 카테고리 역추적 — 태그 이름의 원본은 lore-store.CATEGORY_TAGS.
    // (여기에 따로 적어두면 카테고리를 추가할 때 한쪽만 고치는 사고가 난다)
    const TAG_TO_CATEGORY = Object.fromEntries(
        Object.entries(CATEGORY_TAGS).map(([cat, tag]) => [tag, cat]),
    );
    const TAG_RE = new RegExp(`<(${Object.values(CATEGORY_TAGS).join('|')})>`);

    for (const [uid, entry] of Object.entries(data.entries)) {
        const meta = getMetadata(uid, settings.targetLorebook);
        // content 태그에서 카테고리 우선 판별 (로어북 간 uid 충돌 방지)
        let category = meta?.category || 'fact';
        const content = entry.content || '';
        const tagMatch = content.match(TAG_RE);
        if (tagMatch) {
            category = TAG_TO_CATEGORY[tagMatch[1]];
        }
        const cat = CATEGORIES[category] ? category : 'fact';

        if (activeFilter !== 'all' && cat !== activeFilter) continue;

        grouped[cat].push({
            uid,
            title: entry.comment || 'untitled',
            content: entry.content || '',
            keywords: Array.isArray(entry.key) && entry.key.length > 0 ? entry.key : (meta?.keywords || []),
            tier: meta?.tier || 1,
            disabled: !!entry.disable,
            pinned: !!entry.constant,
            live: !!meta?.live,
            createdAt: meta?.createdAt || 0,
            lastUpdated: meta?.lastUpdated,
            summary: meta?.summary || '',
        });
    }

    // Sort each group by creation time (oldest first = chronological)
    for (const cat of Object.keys(grouped)) {
        grouped[cat].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    }

    // Render
    let html = '';
    for (const [cat, entries] of Object.entries(grouped)) {
        if (entries.length === 0) continue;

        const catInfo = CATEGORIES[cat];
        html += `
            <div class="ll-category-group ll-cat-${cat}">
                <div class="ll-category-header">
                    <div class="ll-category-icon"><i class="${catInfo.icon}"></i></div>
                    <span class="ll-category-label">${catInfo.label}</span>
                    <span class="ll-category-count">${entries.length}</span>
                </div>`;

        for (const entry of entries) {
            const disabledClass = entry.disabled ? ' disabled' : '';

            const keywordsHtml = entry.keywords.slice(0, 5).map(k =>
                `<span class="ll-entry-keyword">${escapeHtml(k)}</span>`,
            ).join('');

            // content에서 XML 태그 + ## 제목 헤더 제거한 순수 본문 추출 (편집용)
            let rawContent = (entry.content || '')
                .replace(/<(character_info|relationship_info|location_info|event_log|routine_info|item_info|world_setting)>\s*(?:\[[^\]]*\]\s*)?/i, '')
                .replace(/\s*<\/(character_info|relationship_info|location_info|event_log|routine_info|item_info|world_setting)>\s*$/i, '')
                .trim();
            // ## 제목 헤더 제거 (저장 시 자동으로 다시 붙음)
            rawContent = rawContent.replace(/^##\s+.*\r?\n/, '').trim();

            const pinnedClass = entry.pinned ? ' ll-entry-pinned' : '';
            const pinBadge = entry.pinned ? ' <span class="ll-entry-pin-badge" title="핀됨 — 항상 inject"><i class="fa-solid fa-thumbtack"></i></span>' : '';
            const liveBadge = entry.live ? ' <span class="ll-entry-live-badge" title="업데이트 대상 — 기억 정리 때 이 엔트리를 풀 내용으로 보내 갱신"><i class="fa-solid fa-rotate"></i> LIVE</span>' : '';
            html += `
                <div class="ll-entry-card${disabledClass}${pinnedClass}" data-uid="${entry.uid}" data-category="${cat}" data-pinned="${entry.pinned ? '1' : '0'}" data-live="${entry.live ? '1' : '0'}">
                    <div class="ll-entry-header">
                        <div class="ll-entry-title">${escapeHtml(entry.title)}${pinBadge}${liveBadge}${entry.disabled ? ' <span class="ll-entry-hide-badge">HIDE</span>' : ''}</div>
                        <div class="ll-entry-actions">
                            <button class="ll-entry-btn ll-entry-live${entry.live ? ' ll-entry-live-on' : ''}" title="${entry.live ? '업데이트 대상 해제' : '업데이트 대상 지정 (기억 정리 때 갱신)'}"><i class="fa-solid fa-rotate"></i></button>
                            <button class="ll-entry-btn ll-entry-pin${entry.pinned ? ' ll-entry-pin-on' : ''}" title="${entry.pinned ? '핀 해제' : '핀 (항상 inject)'}"><i class="fa-solid fa-thumbtack"></i></button>
                            <button class="ll-entry-btn ll-entry-edit" title="편집"><i class="fa-solid fa-pen"></i></button>
                            <button class="ll-entry-btn ll-entry-hide" title="${entry.disabled ? '재활성화' : '하이드'}"><i class="fa-solid fa-${entry.disabled ? 'eye-slash' : 'eye'}"></i></button>
                            <button class="ll-entry-btn ll-entry-delete" title="삭제"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>
                    ${entry.summary ? `<div class="ll-entry-summary" title="검색 힌트 (AI 선택용)"><i class="fa-solid fa-magnifying-glass-arrow-right"></i> ${escapeHtml(entry.summary)}</div>` : '<div class="ll-entry-summary ll-summary-missing" title="아직 summary가 없습니다. 설정 > Summary 일괄 생성 버튼을 눌러주세요."><i class="fa-solid fa-circle-exclamation"></i> summary 없음</div>'}
                    <div class="ll-entry-content" data-raw="${escapeAttr(rawContent)}">${escapeHtml(rawContent)}</div>
                    ${keywordsHtml ? `<div class="ll-entry-keywords">${keywordsHtml}</div>` : ''}
                </div>`;
        }

        html += '</div>';
    }

    if (!html) {
        html = `
            <div class="ll-empty">
                <i class="fa-solid fa-filter"></i>
                <span>이 카테고리에 해당하는 엔트리가 없습니다</span>
            </div>`;
    }

    container.innerHTML = html;

    // 엔트리 카드 버튼 이벤트 바인딩
    container.querySelectorAll('.ll-entry-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const card = btn.closest('.ll-entry-card');
            const uid = card?.dataset?.uid;
            if (!uid) return;

            if (btn.classList.contains('ll-entry-live')) {
                const currentlyLive = card?.dataset?.live === '1';
                handleEntryLiveToggle(uid, !currentlyLive);
            } else if (btn.classList.contains('ll-entry-pin')) {
                const currentlyPinned = card?.dataset?.pinned === '1';
                handleEntryPinToggle(uid, !currentlyPinned);
            } else if (btn.classList.contains('ll-entry-edit')) {
                openInlineEditor(card, uid);
            } else if (btn.classList.contains('ll-entry-hide')) {
                handleEntryHideToggle(uid);
            } else if (btn.classList.contains('ll-entry-delete')) {
                handleEntryDelete(uid);
            }
        });
    });
}

// 엔트리 편집/토글/삭제 액션은 ui-entry.js로 분리됨 (openInlineEditor / handleEntry* import)

// ============================================================
// Panel Refresh
// ============================================================

export async function refreshPanel() {
    if (currentView === 'timeline') {
        await renderTimeline();
    }
    await updateStatusBar();
}


/**
 * 주입 칩만 즉시 갱신 — selectEntries 끝날 때마다 호출 (값은 메모리에 이미 있음).
 */
export function refreshInjectChip() {
    const settings = getSettings();
    const inj = getLastInjectionStats();
    const injEl = document.getElementById('ll_stat_inject');
    const ratioEl = document.getElementById('ll_stat_ratio');
    if (!injEl) return;

    if (!settings.summarySelectionEnabled) {
        injEl.textContent = '—';
        if (ratioEl) ratioEl.textContent = '(off)';
        return;
    }

    if (inj.entryCount === 0) {
        injEl.textContent = '0';
        if (ratioEl) ratioEl.textContent = '';
        return;
    }

    injEl.textContent = inj.totalTokens.toLocaleString();
    if (ratioEl) {
        // 저장 토큰을 알면 비율 표시
        const storageEl = document.getElementById('ll_stat_storage');
        const storageVal = storageEl ? Number(storageEl.dataset.raw || 0) : 0;
        if (storageVal > 0) {
            const pct = Math.round((inj.totalTokens / storageVal) * 100);
            ratioEl.textContent = `(${pct}%)`;
            ratioEl.style.color = pct < 30 ? '#10b981' : pct < 60 ? '#fbbf24' : '#f87171';
        } else {
            ratioEl.textContent = '';
        }
    }
}

export async function updateStatusBar() {
    const settings = getSettings();
    // Unprocessed messages
    const chat = SillyTavern.getContext()?.chat || [];
    const lastIndex = settings.lastOrganizeMessageIndex || 0;
    const unprocessed = Math.max(0, chat.length - lastIndex);

    const unprocessedEl = document.getElementById('ll_stat_unprocessed');
    if (unprocessedEl) unprocessedEl.textContent = String(unprocessed);

    // Update floating trigger badge
    const trigger = document.querySelector('.ll-float-trigger');
    if (trigger) trigger.setAttribute('data-count', String(unprocessed));

    // Inject chip 즉시 갱신 (캐시된 값)
    refreshInjectChip();

    // Storage chip — 멀티 로어북, 비용 큼
    const entriesEl = document.getElementById('ll_stat_entries');
    const storageEl = document.getElementById('ll_stat_storage');
    if (!settings.targetLorebook) {
        if (entriesEl) entriesEl.textContent = '0';
        if (storageEl) {
            storageEl.textContent = '0';
            storageEl.dataset.raw = '0';
        }
        return;
    }

    try {
        if (storageEl) storageEl.textContent = '...';
        const stats = await calculateSelectionStorage();
        if (entriesEl) entriesEl.textContent = String(stats.total.count);
        if (storageEl) {
            storageEl.textContent = stats.total.tokens.toLocaleString();
            storageEl.dataset.raw = String(stats.total.tokens);
        }
        // storage 갱신 후 inject chip의 비율 다시 계산
        refreshInjectChip();
    } catch (err) {
        console.warn(`${LOG_PREFIX} Stats refresh failed:`, err);
        if (storageEl) storageEl.textContent = '?';
    }
}

/**
 * 칩 클릭 시 breakdown 토스트.
 */
function showStorageBreakdown() {
    const lorebooks = getEffectiveSelectionLorebooks();
    if (lorebooks.length === 0) {
        toastr.info('등록된 selection 로어북이 없습니다.');
        return;
    }
    calculateSelectionStorage().then(stats => {
        const lines = lorebooks.map(name => {
            const s = stats.perLorebook[name] || { count: 0, tokens: 0, managed: false };
            const tag = s.managed ? '🟢' : '🟡';
            return `${tag} ${name}: ${s.count}개 / ${s.tokens.toLocaleString()} 토큰`;
        });
        toastr.info(lines.join('<br>') + `<br><b>총 ${stats.total.count}개 / ${stats.total.tokens.toLocaleString()} 토큰</b>`,
            '저장 토큰 breakdown', { escapeHtml: false, timeOut: 8000 });
    });
}

function showInjectBreakdown() {
    const inj = getLastInjectionStats();
    if (inj.entryCount === 0) {
        toastr.info('아직 주입된 엔트리가 없습니다 (또는 AI 선택 OFF).');
        return;
    }
    const lines = Object.entries(inj.perLorebook).map(([name, s]) =>
        `📥 ${name}: ${s.count}개 / ${s.tokens.toLocaleString()} 토큰`,
    );
    const ts = new Date(inj.timestamp).toLocaleTimeString();
    const cacheTag = inj.fromCache ? ' (캐시)' : '';
    toastr.info(lines.join('<br>') + `<br><b>총 ${inj.entryCount}개 / ${inj.totalTokens.toLocaleString()} 토큰</b><br><span style="font-size:10px;opacity:0.7;">갱신: ${ts}${cacheTag}</span>`,
        '주입 토큰 breakdown', { escapeHtml: false, timeOut: 8000 });
}

// 다른 UI 모듈이 순환 import 없이 패널을 새로고침할 수 있게 등록 (모듈 로드 시 1회)
registerRefreshPanel(refreshPanel);
