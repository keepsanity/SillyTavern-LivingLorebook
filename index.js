/**
 * Living Lorebook — AI 기반 로어북 자동 관리 확장
 *
 * 세계관 생성 + 사건/상태 단위 기억 관리 + 티어별 압축 + 연상 기억
 * tool calling 없이, 수동 트리거, WI 시스템이 주입 처리
 */

import { event_types } from '../../../events.js';
import { saveSettingsDebounced, characters, this_chid } from '../../../../script.js';
import { world_names, createNewWorldInfo } from '../../../world-info.js';
import { power_user } from '../../../power-user.js';
import { initStore, getSettings, saveSettings, loadTargetLorebook, calculateTierStats, getMetadata, DEFAULT_SETTINGS } from './lore-store.js';
import { initLLMService } from './llm-service.js';
import { generateWorld, reorganizeExisting } from './world-builder.js';
import { organize, compress } from './memory-manager.js';

// ============================================================
// Constants
// ============================================================

const EXTENSION_NAME = 'SillyTavern-LivingLorebook';
const LOG_PREFIX = '[LivingLorebook]';
const TRIGGER_POS_KEY = 'll_trigger_pos';

// Category config
const CATEGORIES = {
    character:     { icon: 'fa-solid fa-user',           label: '캐릭터',   iconChar: '🧑' },
    relationship:  { icon: 'fa-solid fa-heart',          label: '관계',     iconChar: '💕' },
    location:      { icon: 'fa-solid fa-location-dot',   label: '장소',     iconChar: '📍' },
    event:         { icon: 'fa-solid fa-bolt',           label: '사건',     iconChar: '⚡' },
    routine:       { icon: 'fa-solid fa-clock',          label: '일상',     iconChar: '🔄' },
    item:          { icon: 'fa-solid fa-gem',            label: '아이템',   iconChar: '💎' },
    fact:          { icon: 'fa-solid fa-circle-info',    label: '설정',     iconChar: 'ℹ️' },
};

// ============================================================
// State
// ============================================================

let context = null;
let settings = null;
let isProcessing = false;
let currentView = 'timeline'; // 'timeline' | 'settings'
let activeFilter = 'all';

// ============================================================
// Init
// ============================================================

async function init() {
    console.log(`${LOG_PREFIX} Initializing...`);

    context = SillyTavern.getContext();

    // Init modules
    settings = initStore(context);
    initLLMService(context);

    // Load sidebar settings
    await loadSidebarSettings();

    // Create floating trigger + panel
    createFloatingTrigger();
    createPanel();

    // Add wand menu button (채팅방 확장 버튼)
    addWandMenuButton();

    // Register events & commands
    registerEventListeners();
    registerSlashCommands();

    console.log(`${LOG_PREFIX} Initialized`);
}

// ============================================================
// Sidebar Settings (minimal)
// ============================================================

async function loadSidebarSettings() {
    const html = await context.renderExtensionTemplateAsync(
        `third-party/${EXTENSION_NAME}`,
        'settings',
    );
    $('#extensions_settings').append(html);

    const container = $('.ll_settings');

    // 활성화
    container.find('#ll_enabled')
        .prop('checked', settings.enabled)
        .on('change', function () {
            settings.enabled = $(this).prop('checked');
            saveSettings();
            $('.ll-float-trigger').toggle(settings.enabled);
        });

    // 대상 로어북
    populateLorebookDropdown();
    container.find('#ll_target_lorebook')
        .val(settings.targetLorebook || '')
        .on('change', function () {
            const val = $(this).val();
            settings.targetLorebook = val;
            saveSettings();
            refreshPanel();
        });

    // Connection Profile
    if (context.ConnectionManagerRequestService) {
        context.ConnectionManagerRequestService.handleDropdown(
            '.ll_settings .connection_profile',
            settings.profileId,
            (profile) => {
                settings.profileId = profile?.id ?? '';
                saveSettings();
            },
        );
    }

    // 패널 열기 버튼
    container.find('#ll_open_panel').on('click', () => openPanel());
}

function populateLorebookDropdown() {
    const $select = $('#ll_target_lorebook');
    $select.find('option:not(:first)').remove();

    const names = world_names || [];
    for (const name of [...names].sort()) {
        $select.append(`<option value="${name}">${name}</option>`);
    }
    $select.val(settings.targetLorebook || '');
}

/**
 * 현재 캐릭터 카드 + 페르소나 정보 수집
 */
function getCharacterContext() {
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

// ============================================================
// Floating Trigger Button
// ============================================================

function createFloatingTrigger() {
    const trigger = document.createElement('div');
    trigger.className = 'll-float-trigger';
    trigger.innerHTML = '<i class="fa-solid fa-brain"></i>';
    trigger.setAttribute('data-count', '0');
    trigger.title = 'Living Lorebook';

    if (!settings.enabled) {
        trigger.style.display = 'none';
    }

    document.body.appendChild(trigger);

    // Restore position
    const saved = localStorage.getItem(TRIGGER_POS_KEY);
    if (saved) {
        try {
            const pos = JSON.parse(saved);
            trigger.style.bottom = 'auto';
            trigger.style.right = 'auto';
            trigger.style.top = `${pos.top}px`;
            trigger.style.left = `${pos.left}px`;
        } catch { /* use default */ }
    }

    // Drag support
    let isDragging = false;
    let dragStartX, dragStartY, trigStartX, trigStartY;

    trigger.addEventListener('pointerdown', (e) => {
        isDragging = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        const rect = trigger.getBoundingClientRect();
        trigStartX = rect.left;
        trigStartY = rect.top;
        trigger.setPointerCapture(e.pointerId);
    });

    trigger.addEventListener('pointermove', (e) => {
        if (dragStartX === undefined) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        if (!isDragging && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
            isDragging = true;
        }
        if (isDragging) {
            const newLeft = Math.max(0, Math.min(window.innerWidth - 42, trigStartX + dx));
            const newTop = Math.max(0, Math.min(window.innerHeight - 42, trigStartY + dy));
            trigger.style.bottom = 'auto';
            trigger.style.right = 'auto';
            trigger.style.left = `${newLeft}px`;
            trigger.style.top = `${newTop}px`;
        }
    });

    trigger.addEventListener('pointerup', (e) => {
        if (isDragging) {
            const rect = trigger.getBoundingClientRect();
            localStorage.setItem(TRIGGER_POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
        } else {
            togglePanel();
        }
        dragStartX = undefined;
        trigger.releasePointerCapture(e.pointerId);
    });
}

// ============================================================
// Panel
// ============================================================

function createPanel() {
    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'll-panel-overlay';
    overlay.addEventListener('click', closePanel);
    document.body.appendChild(overlay);

    // Panel
    const panel = document.createElement('div');
    panel.className = 'll-panel';
    panel.innerHTML = `
        <!-- Header -->
        <div class="ll-panel-header">
            <div class="ll-panel-title">
                <i class="fa-solid fa-brain"></i>
                Living Lorebook
            </div>
            <button class="ll-panel-close ll-btn-settings" title="설정">
                <i class="fa-solid fa-gear"></i>
            </button>
            <button class="ll-panel-close ll-btn-close" title="닫기">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>

        <!-- Toolbar -->
        <div class="ll-toolbar">
            <button class="ll-toolbar-btn build" data-action="build">
                <i class="fa-solid fa-wand-magic-sparkles"></i> 세계관 생성
            </button>
            <button class="ll-toolbar-btn organize" data-action="organize">
                <i class="fa-solid fa-broom"></i> 기억 정리
            </button>
            <button class="ll-toolbar-btn compress" data-action="compress">
                <i class="fa-solid fa-compress"></i> 압축
            </button>
            <button class="ll-toolbar-btn reorganize" data-action="reorganize">
                <i class="fa-solid fa-arrows-rotate"></i> 재구성
            </button>
        </div>

        <!-- World description input (hidden by default) -->
        <div class="ll-world-input-row">
            <input class="ll-world-input" type="text" placeholder="(선택) 추가 설정: 배경은 서울, 카페가 있음..." />
            <button class="ll-toolbar-btn build" data-action="build-confirm">
                <i class="fa-solid fa-check"></i> 생성
            </button>
            <button class="ll-toolbar-btn" data-action="build-cancel">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>

        <!-- Filter bar -->
        <div class="ll-filter-bar">
            <button class="ll-filter-chip active" data-filter="all">전체</button>
            <button class="ll-filter-chip" data-filter="character"><i class="fa-solid fa-user" style="margin-right:3px;font-size:10px;"></i>캐릭터</button>
            <button class="ll-filter-chip" data-filter="relationship"><i class="fa-solid fa-heart" style="margin-right:3px;font-size:10px;"></i>관계</button>
            <button class="ll-filter-chip" data-filter="location"><i class="fa-solid fa-location-dot" style="margin-right:3px;font-size:10px;"></i>장소</button>
            <button class="ll-filter-chip" data-filter="event"><i class="fa-solid fa-bolt" style="margin-right:3px;font-size:10px;"></i>사건</button>
            <button class="ll-filter-chip" data-filter="routine"><i class="fa-solid fa-clock" style="margin-right:3px;font-size:10px;"></i>일상</button>
            <button class="ll-filter-chip" data-filter="item"><i class="fa-solid fa-gem" style="margin-right:3px;font-size:10px;"></i>아이템</button>
            <button class="ll-filter-chip" data-filter="fact"><i class="fa-solid fa-circle-info" style="margin-right:3px;font-size:10px;"></i>설정</button>
        </div>

        <!-- Timeline (main view) -->
        <div class="ll-timeline" id="ll_timeline"></div>

        <!-- Settings view (hidden by default) -->
        <div class="ll-settings-view" id="ll_settings_view">
            <div class="ll-settings-section-title">
                <i class="fa-solid fa-magnifying-glass"></i> 벡터 검색
            </div>
            <div class="ll-settings-row">
                <label>검색 결과 수 (Top K)</label>
                <input class="ll-settings-input" id="ll_s_topk" type="number" min="1" max="50" />
            </div>
            <div class="ll-settings-row">
                <label>유사도 임계값</label>
                <input class="ll-settings-input" id="ll_s_threshold" type="number" min="0" max="1" step="0.05" />
            </div>

            <div class="ll-settings-section-title">
                <i class="fa-solid fa-layer-group"></i> 압축 설정
            </div>
            <div class="ll-settings-row">
                <label>Tier 2 압축률</label>
                <input class="ll-settings-input" id="ll_s_tier2" type="number" min="10" max="90" />
                <span class="ll-settings-unit">%</span>
            </div>
            <div class="ll-settings-row">
                <label>Tier 3 압축률</label>
                <input class="ll-settings-input" id="ll_s_tier3" type="number" min="5" max="50" />
                <span class="ll-settings-unit">%</span>
            </div>

            <div class="ll-settings-section-title">
                <i class="fa-solid fa-pen-fancy"></i> 프롬프트 커스터마이즈
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;">
                <label style="font-size:12px;">세계관 생성 프롬프트</label>
                <textarea class="ll-settings-textarea" id="ll_s_world_prompt" rows="3"></textarea>
                <button class="ll-settings-reset-btn" data-reset="worldBuildPrompt"><i class="fa-solid fa-rotate-left"></i> 초기화</button>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;">
                <label style="font-size:12px;">정리 프롬프트</label>
                <textarea class="ll-settings-textarea" id="ll_s_organize_prompt" rows="3"></textarea>
                <button class="ll-settings-reset-btn" data-reset="organizePrompt"><i class="fa-solid fa-rotate-left"></i> 초기화</button>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;">
                <label style="font-size:12px;">압축 프롬프트</label>
                <textarea class="ll-settings-textarea" id="ll_s_compress_prompt" rows="3"></textarea>
                <button class="ll-settings-reset-btn" data-reset="compressPrompt"><i class="fa-solid fa-rotate-left"></i> 초기화</button>
            </div>
        </div>

        <!-- Status Bar -->
        <div class="ll-status-bar">
            <div class="ll-status-item">
                <i class="fa-solid fa-book"></i>
                <span class="ll-status-value" id="ll_stat_entries">0</span>개
            </div>
            <div class="ll-status-item">
                <i class="fa-solid fa-coins"></i>
                <span class="ll-status-value" id="ll_stat_tokens">0</span> 토큰
            </div>
            <div class="ll-status-item">
                <i class="fa-solid fa-clock"></i>
                미처리 <span class="ll-status-value" id="ll_stat_unprocessed">0</span>
            </div>
            <div class="ll-status-spacer"></div>
            <button class="ll-status-btn ll-btn-refresh" title="새로고침">
                <i class="fa-solid fa-rotate"></i>
            </button>
        </div>
    `;
    document.body.appendChild(panel);

    // Bind panel events
    bindPanelEvents(panel);
}

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

    // Settings inputs
    bindSettingsInputs(panel);
}

function bindSettingsInputs(panel) {
    const bind = (id, key, transform = Number) => {
        const el = panel.querySelector(id);
        if (!el) return;
        el.value = settings[key];
        el.addEventListener('change', () => {
            settings[key] = transform(el.value);
            saveSettings();
        });
    };

    bind('#ll_s_topk', 'vectorTopK');
    bind('#ll_s_threshold', 'vectorThreshold', v => parseFloat(v) || 0.3);
    bind('#ll_s_tier2', 'tier2TargetRatio');
    bind('#ll_s_tier3', 'tier3TargetRatio');

    // Prompt textareas
    const bindTextarea = (id, key) => {
        const el = panel.querySelector(id);
        if (!el) return;
        el.value = settings[key];
        el.addEventListener('input', () => {
            settings[key] = el.value;
            saveSettings();
        });
    };

    bindTextarea('#ll_s_world_prompt', 'worldBuildPrompt');
    bindTextarea('#ll_s_organize_prompt', 'organizePrompt');
    bindTextarea('#ll_s_compress_prompt', 'compressPrompt');

    // Reset buttons
    panel.querySelectorAll('.ll-settings-reset-btn[data-reset]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.reset;
            settings[key] = DEFAULT_SETTINGS[key];
            saveSettings();
            // Update textarea
            const textareaMap = {
                worldBuildPrompt: '#ll_s_world_prompt',
                organizePrompt: '#ll_s_organize_prompt',
                compressPrompt: '#ll_s_compress_prompt',
            };
            const ta = panel.querySelector(textareaMap[key]);
            if (ta) ta.value = settings[key];
            toastr.info('프롬프트가 초기화되었습니다.');
        });
    });
}

// ============================================================
// Panel Open / Close
// ============================================================

function togglePanel() {
    const panel = document.querySelector('.ll-panel');
    if (panel?.classList.contains('open')) {
        closePanel();
    } else {
        openPanel();
    }
}

function openPanel() {
    document.querySelector('.ll-panel-overlay')?.classList.add('open');
    document.querySelector('.ll-panel')?.classList.add('open');
    document.querySelector('.ll-float-trigger')?.classList.add('active');
    switchView('timeline');
    refreshPanel();
}

function closePanel() {
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
            settings.targetLorebook = val;
            saveSettings();
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
                settings.targetLorebook = newName;
                saveSettings();
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
        settings.targetLorebook = '';
        saveSettings();
        $('#ll_target_lorebook').val('');
        return renderTimeline();
    }

    if (!data) {
        settings.targetLorebook = '';
        saveSettings();
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

    for (const [uid, entry] of Object.entries(data.entries)) {
        const meta = getMetadata(uid);
        const category = meta?.category || 'fact';
        const cat = CATEGORIES[category] ? category : 'fact';

        if (activeFilter !== 'all' && cat !== activeFilter) continue;

        grouped[cat].push({
            uid,
            title: entry.comment || 'untitled',
            content: entry.content || '',
            keywords: meta?.keywords || entry.key || [],
            tier: meta?.tier || 1,
            disabled: !!entry.disable,
            createdAt: meta?.createdAt || 0,
            lastUpdated: meta?.lastUpdated,
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

            html += `
                <div class="ll-entry-card${disabledClass}" data-uid="${entry.uid}">
                    <div class="ll-entry-title">
                        ${escapeHtml(entry.title)}
                    </div>
                    <div class="ll-entry-content">${escapeHtml(entry.content)}</div>
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
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ============================================================
// Panel Refresh
// ============================================================

async function refreshPanel() {
    if (currentView === 'timeline') {
        await renderTimeline();
    }
    await updateStatusBar();
}

async function updateStatusBar() {
    // Unprocessed messages
    const chat = context?.chat || [];
    const lastIndex = settings.lastOrganizeMessageIndex || 0;
    const unprocessed = Math.max(0, chat.length - lastIndex);

    const unprocessedEl = document.getElementById('ll_stat_unprocessed');
    if (unprocessedEl) unprocessedEl.textContent = String(unprocessed);

    // Update floating trigger badge
    const trigger = document.querySelector('.ll-float-trigger');
    if (trigger) trigger.setAttribute('data-count', String(unprocessed));

    // Entry count & tokens
    if (!settings.targetLorebook) {
        const entriesEl = document.getElementById('ll_stat_entries');
        const tokensEl = document.getElementById('ll_stat_tokens');
        if (entriesEl) entriesEl.textContent = '0';
        if (tokensEl) tokensEl.textContent = '0';
        return;
    }

    try {
        const data = await loadTargetLorebook();
        if (!data) return;

        const stats = await calculateTierStats(data);
        const entriesEl = document.getElementById('ll_stat_entries');
        const tokensEl = document.getElementById('ll_stat_tokens');
        if (entriesEl) entriesEl.textContent = String(stats.total.count);
        if (tokensEl) tokensEl.textContent = stats.total.tokens.toLocaleString();
    } catch (err) {
        console.warn(`${LOG_PREFIX} Stats refresh failed:`, err);
    }
}

// ============================================================
// Toolbar Actions
// ============================================================

async function handleToolbarAction(action) {
    if (isProcessing) return;

    switch (action) {
        case 'build':
            // Show world description input row
            document.querySelector('.ll-world-input-row')?.classList.add('active');
            document.querySelector('.ll-world-input')?.focus();
            return;

        case 'build-confirm':
            await handleBuildWorld();
            return;

        case 'build-cancel':
            document.querySelector('.ll-world-input-row')?.classList.remove('active');
            return;

        case 'organize':
            await handleOrganize();
            return;

        case 'compress':
            await handleCompress();
            return;

        case 'reorganize':
            await handleReorganize();
            return;
    }
}

function setToolbarProcessing(processing, activeAction) {
    isProcessing = processing;
    document.querySelectorAll('.ll-toolbar-btn').forEach(btn => {
        const action = btn.dataset.action;
        if (processing) {
            if (action === activeAction) {
                btn.classList.add('processing');
            } else {
                btn.disabled = true;
                btn.style.opacity = '0.35';
                btn.style.pointerEvents = 'none';
            }
        } else {
            btn.classList.remove('processing');
            btn.disabled = false;
            btn.style.opacity = '';
            btn.style.pointerEvents = '';
        }
    });
}

async function handleBuildWorld() {
    // Auto-create lorebook if none selected
    if (!settings.targetLorebook) {
        const charName = (this_chid !== undefined && characters[this_chid])
            ? characters[this_chid].name
            : 'LivingLorebook';
        const newName = `LL_${charName}`;

        try {
            await createNewWorldInfo(newName);
            settings.targetLorebook = newName;
            saveSettings();
            populateLorebookDropdown();
            toastr.info(`로어북 "${newName}" 이 생성되었습니다.`);
        } catch (err) {
            toastr.error('로어북 생성에 실패했습니다.');
            return;
        }
    }

    const charContext = getCharacterContext();
    const extraDesc = document.querySelector('.ll-world-input')?.value?.trim() || '';

    if (!charContext && !extraDesc) {
        toastr.warning('캐릭터 카드가 없고 추가 설명도 비어있습니다.');
        return;
    }

    const fullDescription = [charContext, extraDesc].filter(Boolean).join('\n\n---\n\n');

    setToolbarProcessing(true, 'build-confirm');

    try {
        const entries = await generateWorld(fullDescription);
        toastr.success(`${entries.length}개의 엔트리가 생성되었습니다.`);
        document.querySelector('.ll-world-input-row')?.classList.remove('active');
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} World generation failed:`, err);
        toastr.error(err.message || '세계관 생성에 실패했습니다.');
    } finally {
        setToolbarProcessing(false);
    }
}

async function handleOrganize() {
    if (!settings.targetLorebook) {
        toastr.warning('대상 로어북을 먼저 선택해주세요.');
        return;
    }

    const chat = context.chat || [];
    if (chat.length === 0) {
        toastr.info('정리할 대화가 없습니다.');
        return;
    }

    setToolbarProcessing(true, 'organize');

    try {
        const result = await organize(chat);
        const parts = [];
        if (result.added > 0) parts.push(`추가 ${result.added}`);
        if (result.updated > 0) parts.push(`수정 ${result.updated}`);
        if (result.deactivated > 0) parts.push(`비활성화 ${result.deactivated}`);

        if (parts.length > 0) {
            toastr.success(`정리 완료: ${parts.join(', ')}`);
        } else {
            toastr.info('변경사항이 없습니다.');
        }

        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Organize failed:`, err);
        toastr.error(err.message || '기억 정리에 실패했습니다.');
    } finally {
        setToolbarProcessing(false);
    }
}

async function handleCompress() {
    if (!settings.targetLorebook) {
        toastr.warning('대상 로어북을 먼저 선택해주세요.');
        return;
    }

    setToolbarProcessing(true, 'compress');

    try {
        const result = await compress();
        if (result.compressed > 0) {
            toastr.success(`${result.compressed}개의 엔트리가 압축되었습니다.`);
        } else {
            toastr.info('압축할 엔트리가 없습니다.');
        }
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Compress failed:`, err);
        toastr.error(err.message || '압축에 실패했습니다.');
    } finally {
        setToolbarProcessing(false);
    }
}

async function handleReorganize() {
    if (!settings.targetLorebook) {
        toastr.warning('대상 로어북을 먼저 선택해주세요.');
        return;
    }

    setToolbarProcessing(true, 'reorganize');

    try {
        const result = await reorganizeExisting();
        toastr.success(`${result.reorganized}개의 엔트리로 재구성되었습니다.`);
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Reorganize failed:`, err);
        toastr.error(err.message || '재구성에 실패했습니다.');
    } finally {
        setToolbarProcessing(false);
    }
}

// ============================================================
// Event Listeners
// ============================================================

function registerEventListeners() {
    const eventSource = context.eventSource;

    // 채팅 변경 시 배지 업데이트
    eventSource.on(event_types.CHAT_CHANGED, () => {
        updateStatusBar();
    });

    // 메시지 수신 시 미처리 카운트 업데이트
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        updateStatusBar();
    });

    // ESC로 패널 닫기
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const panel = document.querySelector('.ll-panel');
            if (panel?.classList.contains('open')) {
                closePanel();
                e.preventDefault();
            }
        }
    });
}

// ============================================================
// Wand Menu Button (채팅방 확장 버튼)
// ============================================================

function addWandMenuButton() {
    const buttonHtml = `
        <div id="ll_wand_panel" class="list-group-item flex-container flexGap5" title="Living Lorebook">
            <div class="fa-solid fa-brain extensionsMenuExtensionButton"></div>
            <span>Living Lorebook</span>
        </div>`;

    $('#extensionsMenu').append(buttonHtml);

    $('#ll_wand_panel').on('click', () => {
        $('#extensionsMenu').css('display', 'none');
        openPanel();
    });
}

// ============================================================
// Slash Commands
// ============================================================

function registerSlashCommands() {
    try {
        const { SlashCommandParser } = SillyTavern.getContext();
        if (!SlashCommandParser) return;

        SlashCommandParser.addCommandObject({
            name: 'll-organize',
            aliases: [],
            callback: async () => { await handleOrganize(); return ''; },
            helpString: '기억 정리 — 최근 대화를 분석하여 로어북을 갱신합니다.',
        });

        SlashCommandParser.addCommandObject({
            name: 'll-compress',
            aliases: [],
            callback: async () => { await handleCompress(); return ''; },
            helpString: '기억 압축 — 오래된 엔트리를 티어에 따라 압축합니다.',
        });

        SlashCommandParser.addCommandObject({
            name: 'll-build',
            aliases: [],
            callback: async (_args, value) => {
                const input = document.querySelector('.ll-world-input');
                if (input && value) input.value = value;
                await handleBuildWorld();
                return '';
            },
            helpString: '세계관 생성 — 캐릭터 카드를 읽어 로어북 엔트리를 자동 생성합니다.',
        });

        SlashCommandParser.addCommandObject({
            name: 'll-panel',
            aliases: [],
            callback: async () => { openPanel(); return ''; },
            helpString: 'Living Lorebook 패널을 엽니다.',
        });

        console.log(`${LOG_PREFIX} Slash commands registered`);
    } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to register slash commands:`, err);
    }
}

// ============================================================
// Entry Point
// ============================================================

jQuery(async () => {
    await init();
});
