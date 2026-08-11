/**
 * Living Lorebook — AI 기반 로어북 자동 관리 확장
 *
 * 세계관 생성 + 사건/상태 단위 기억 관리 + 티어별 압축 + 연상 기억
 * 수동 트리거, WI 시스템이 주입 처리
 */

import { event_types } from '../../../events.js';
import { chat_metadata, setExtensionPrompt } from '../../../../script.js';
import { initStore, saveSettings } from './lore-store.js';
import { initLLMService } from './llm-service.js';
import { populateLorebookDropdown } from './ui-shared.js';
import { createSuggestModal } from './ui-suggest.js';
import { setChatLorebook, restoreChatMetadata } from './chat-meta.js';
import { renderSelectionLorebookList, populateTargetLorebookDropdown, populateAddLorebookDropdown } from './ui-lorebooks.js';
import { refreshVectorStatus } from './ui-settings.js';
import { createPanel, openPanel, closePanel, togglePanel, refreshPanel, updateStatusBar, refreshInjectChip } from './ui-panel.js';
import { handleBuildWorld, handleOrganize, handleCompress } from './ui-toolbar.js';
import { selectEntries, clearSelectionCache, autoReindexStaleLorebooks } from './summary-retrieval.js';

// ============================================================
// Constants
// ============================================================

const EXTENSION_NAME = 'SillyTavern-LivingLorebook';
const LOG_PREFIX = '[LivingLorebook]';
const TRIGGER_POS_KEY = 'll_trigger_pos';

// ============================================================
// State
// ============================================================

let context = null;
let settings = null;

// 채팅 메타데이터(target/선택 로어북) get/set + restore는 chat-meta.js로 분리됨.

// ============================================================
// Init
// ============================================================

async function init() {
    console.log(`${LOG_PREFIX} Initializing...`);

    context = SillyTavern.getContext();

    // Init modules
    settings = initStore(context);
    initLLMService(context);

    // chat_metadata가 이미 ST에 로드된 상태면 즉시 복원 (init 후 CHAT_CHANGED가 안 발화할 수도 있음)
    if (chat_metadata && Object.keys(chat_metadata).length > 0) {
        restoreChatMetadata();
    }

    // Load sidebar settings
    await loadSidebarSettings();

    // Create floating trigger + panel
    createFloatingTrigger();
    createPanel();
    createSuggestModal();

    // Add wand menu button (채팅방 확장 버튼)
    addWandMenuButton();

    // (refreshPanel 레지스트리 등록은 ui-panel.js가 모듈 로드 시 자체적으로 처리)

    // Register events & commands
    registerEventListeners();
    registerSlashCommands();

    // 첫 채팅/ST 재시작 시엔 CHAT_CHANGED가 안 튈 수 있음 → 여기서도 한 번 자동 재색인 점검
    maybeAutoReindex();

    console.log(`${LOG_PREFIX} Initialized`);
}

/**
 * 현재 채팅의 LL 메타데이터 → settings 복원.
 * init 시점, CHAT_CHANGED 시점 둘 다 호출.
 *
 * 정책: 채팅별 strict.
 * - chat_metadata에 LL 데이터 있음 → 그 값으로 settings 복원
 * - 없음 → settings를 명시적으로 비움 (다른 채팅의 selection이 leak되지 않게)
 */
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
            setChatLorebook(val);
            refreshPanel();
        });

    // Connection Profile (organize/compress/backfill)
    if (context.ConnectionManagerRequestService) {
        context.ConnectionManagerRequestService.handleDropdown(
            '.ll_settings .connection_profile',
            settings.profileId,
            (profile) => {
                settings.profileId = profile?.id ?? '';
                saveSettings();
            },
        );

        // Connection Profile (AI 선택 전용 — 비우면 organize용 fallback)
        try {
            context.ConnectionManagerRequestService.handleDropdown(
                '.ll_settings .ll_selection_profile',
                settings.selectionProfileId,
                (profile) => {
                    settings.selectionProfileId = profile?.id ?? '';
                    saveSettings();
                    clearSelectionCache();
                },
            );
        } catch (err) {
            console.warn(`${LOG_PREFIX} Selection profile dropdown init failed:`, err.message);
        }
    }

    // 패널 열기 버튼
    container.find('#ll_open_panel').on('click', () => openPanel());
}


/**
 * 현재 캐릭터 카드 + 페르소나 정보 수집
 */
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

// 패널 본체(생성/뷰전환/타임라인/상태바)는 ui-panel.js로 분리됨

// 채팅 열 때 이 채팅의 managed 로어북이 아직 색인 안 됐으면 조용히 자동 재색인.
// 이미 같은 임베더로 색인된 로어북은 스킵(비용 0). CHAT_CHANGED가 연속 발화해도 1개만.
let _autoReindexInflight = false;
async function maybeAutoReindex() {
    if (_autoReindexInflight) return;
    _autoReindexInflight = true;
    try {
        const res = await autoReindexStaleLorebooks();
        if (res) {
            clearSelectionCache();
            toastr.info(
                `벡터 자동 재색인: ${res.reindexed.length}개 로어북 · ${res.entries}개 엔트리`,
                'LivingLorebook', { timeOut: 3500 },
            );
            const panel = document.querySelector('.ll-panel');
            if (panel?.classList.contains('open')) refreshPanel();
        }
    } catch (err) {
        console.warn(`${LOG_PREFIX} auto-reindex failed (non-critical):`, err);
    } finally {
        _autoReindexInflight = false;
    }
}


// 툴바 작업(세계관/정리/압축/줄거리/재구성)은 ui-toolbar.js로 분리됨

// ============================================================
// Event Listeners
// ============================================================

// ============================================================
// Generation Hook — Summary 기반 AI 선택 + setExtensionPrompt 주입
// ============================================================

const INJECTION_KEY = 'LivingLorebook_selection';

/**
 * 매 generation 직전 호출. 활성 후보 중 AI가 고른 top-N을 prompt에 주입.
 * dryRun / skipWIAN / 토글 OFF 시 skip.
 */
/**
 * 사전계산 — 사용자 메시지 직후 selectEntries 호출.
 * GENERATION_AFTER_COMMANDS와 inflight dedup으로 LLM 호출 1번만 발생.
 *
 * 중요: setTimeout 사용 안 함. 즉시 호출해야 selectEntries 내부의 _selectInflight가
 * 동기적으로 채워지고 곧이어 발화하는 GENERATION_AFTER_COMMANDS hook이 dedup 가능.
 * fire-and-forget — 실패해도 generation 막지 않음.
 */
let _precomputeInflight = false;
function precomputeSelection(source) {
    if (_precomputeInflight) return; // 중복 호출 방지
    if (!settings.enabled || !settings.summarySelectionEnabled) return;

    _precomputeInflight = true;
    const t0 = performance.now();

    // 즉시 호출 (setTimeout X) — _selectInflight 동기 set → 후속 hook dedup 가능
    (async () => {
        try {
            const chat = context.chat || [];
            const result = await selectEntries(chat);
            const dt = (performance.now() - t0).toFixed(0);
            console.log(`${LOG_PREFIX} Precompute (${source}) ${dt}ms: ${result.entries.length} entries (${result.stage})`);
        } catch (err) {
            console.warn(`${LOG_PREFIX} Precompute (${source}) failed:`, err.message);
        } finally {
            _precomputeInflight = false;
        }
    })();
}

async function onGenerationBeforeWI(type, options, dryRun) {
    if (dryRun) return;
    // 이전 setExtensionPrompt 잔여가 있으면 항상 비움 (구버전 호환)
    setExtensionPrompt(INJECTION_KEY, '', 1, 4, false, 0);

    if (!settings.enabled) return;
    if (!settings.summarySelectionEnabled) return;
    if (options?.skipWIAN) return;

    const t0 = performance.now();
    try {
        const chat = context.chat || [];
        // selectEntries 자체가 managed mode 아닌 lorebook은 후보에서 제외함 — 이중주입 안전
        const result = await selectEntries(chat);
        const dt = (performance.now() - t0).toFixed(0);

        if (!result.entries || result.entries.length === 0) {
            console.log(`${LOG_PREFIX} Inject empty (${dt}ms, ${result.stage})`);
            return;
        }

        // ST 평소 WI 흐름에 강제 활성화 — 프리셋 World Info 슬롯에 자연스럽게 들어감
        // entry의 position/depth/role/order 등 모두 ST가 평소처럼 처리
        const entriesToActivate = result.entries.map(e => {
            const raw = e.rawEntry || {};
            return {
                ...raw,
                world: e.lorebookName,
                uid: raw.uid !== undefined ? raw.uid : (Number.isFinite(Number(e.uid)) ? Number(e.uid) : e.uid),
            };
        });
        await context.eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, entriesToActivate);

        const cacheTag = result.fromCache ? ' [CACHED]' : '';
        console.log(`${LOG_PREFIX} Force-activated ${entriesToActivate.length} entries in ${dt}ms${cacheTag} (${result.stage})`);

        // 주입 칩 즉시 갱신
        try { refreshInjectChip(); } catch { /* ignore */ }
    } catch (err) {
        console.error(`${LOG_PREFIX} Selection injection failed:`, err);
    }
}

function registerEventListeners() {
    const eventSource = context.eventSource;

    // 채팅 변경 시 배지 업데이트 + 선택 캐시 무효화
    eventSource.on(event_types.CHAT_CHANGED, () => {
        // 채팅별 LL 메타데이터 복원 (target + selection)
        restoreChatMetadata();
        $('#ll_target_lorebook').val(settings.targetLorebook || '');

        updateStatusBar();
        clearSelectionCache();

        // 패널 열려있으면 카드 리스트 + dropdown들 다시 렌더 — stale 상태 회피
        const panel = document.querySelector('.ll-panel');
        if (panel?.classList.contains('open')) {
            renderSelectionLorebookList(panel);
            populateAddLorebookDropdown(panel);
            populateTargetLorebookDropdown(panel);
            refreshVectorStatus();   // 벡터 상태줄도 현재 채팅 로어북 기준으로 갱신
        }

        // 이 채팅의 로어북이 아직 색인 안 됐으면 조용히 자동 재색인 (이미 된 건 스킵)
        maybeAutoReindex();
    });

    // Generation hook — WI 처리 전에 우리 주입 슬롯 채움 (캐시 적중이면 즉시)
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationBeforeWI);

    // 메시지 수신 시 미처리 카운트 업데이트
    // (precompute는 MESSAGE_SENT만 사용 — MESSAGE_RECEIVED는 같은 캐시 키라 중복 호출)
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        updateStatusBar();
    });

    // 사용자 메시지 보낸 직후 사전계산 — 이 캐시가 스와이프/리젠/다음 generation 모두 커버
    eventSource.on(event_types.MESSAGE_SENT, () => {
        precomputeSelection('MESSAGE_SENT');
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
