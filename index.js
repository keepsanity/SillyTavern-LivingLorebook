/**
 * Living Lorebook — AI 기반 로어북 자동 관리 확장
 *
 * 세계관 생성 + 사건/상태 단위 기억 관리 + 티어별 압축 + 연상 기억
 * tool calling 없이, 수동 트리거, WI 시스템이 주입 처리
 */

import { event_types } from '../../../events.js';
import { saveSettingsDebounced, characters, this_chid, chat_metadata, saveMetadata, setExtensionPrompt } from '../../../../script.js';
import { world_names, createNewWorldInfo } from '../../../world-info.js';
import { power_user } from '../../../power-user.js';
import { initStore, getSettings, saveSettings, loadTargetLorebook, loadAnyLorebook, calculateTierStats, calculateSelectionStorage, getMetadata, DEFAULT_SETTINGS, updateEntryFields, enableEntry, deactivateEntry, deleteEntry, setEntryPinned, saveLorebook, refreshEditor, migrateToManagedMode, getEffectiveSelectionLorebooks, isManagedMode } from './lore-store.js';
import { initLLMService } from './llm-service.js';
import { generateWorld, reorganizeExisting, suggestWorldEntries, generateFromSuggestions } from './world-builder.js';
import { organize, compress, backfillSummaries, generateStoryArc } from './memory-manager.js';
import { selectEntries, clearSelectionCache, getLastInjectionStats } from './summary-retrieval.js';

// ============================================================
// Constants
// ============================================================

const EXTENSION_NAME = 'SillyTavern-LivingLorebook';
const LOG_PREFIX = '[LivingLorebook]';
const TRIGGER_POS_KEY = 'll_trigger_pos';

// Category config
const CATEGORIES = {
    arc:           { icon: 'fa-solid fa-book-bookmark',  label: '줄거리',   iconChar: '📖' },
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

const METADATA_KEY = 'living_lorebook';

/**
 * 현재 채팅의 로어북 이름을 chat_metadata에서 읽기
 */
function getChatLorebook() {
    return chat_metadata?.[METADATA_KEY]?.targetLorebook || '';
}

/**
 * 현재 채팅에 로어북 연결 (chat_metadata에 저장)
 */
function setChatLorebook(lorebookName) {
    if (!chat_metadata) return;
    if (!chat_metadata[METADATA_KEY]) chat_metadata[METADATA_KEY] = {};
    chat_metadata[METADATA_KEY].targetLorebook = lorebookName;
    settings.targetLorebook = lorebookName;
    saveSettings();
    saveMetadata();
}

/**
 * 현재 채팅의 selection 로어북 추가분 (targetLorebook 외 로어북들).
 * targetLorebook은 항상 자동 포함됨 (lore-store 쪽에서 처리).
 *
 * 정책: 채팅별 strict. chat_metadata에 없으면 빈 배열 (다른 채팅 selection 절대 leak 안 됨).
 */
function getChatSelectionLorebooks() {
    const arr = chat_metadata?.[METADATA_KEY]?.selectionLorebooks;
    return Array.isArray(arr) ? arr : [];
}

function setChatSelectionLorebooks(arr) {
    if (!chat_metadata) return;
    if (!chat_metadata[METADATA_KEY]) chat_metadata[METADATA_KEY] = {};
    const cleaned = Array.isArray(arr) ? arr.filter(n => typeof n === 'string' && n.length > 0) : [];
    chat_metadata[METADATA_KEY].selectionLorebooks = cleaned;
    settings.selectionLorebooks = cleaned;
    saveSettings();
    saveMetadata();
    clearSelectionCache();
}

// ============================================================
// Init
// ============================================================

async function init() {
    console.log(`${LOG_PREFIX} Initializing...`);

    context = SillyTavern.getContext();

    // Init modules
    settings = initStore(context);
    initLLMService(context);

    // chat_metadata 복원 — 패널 만들기 전에 settings가 정확한 상태여야 카드 첫 렌더가 맞음
    restoreChatMetadata();

    // Load sidebar settings
    await loadSidebarSettings();

    // Create floating trigger + panel
    createFloatingTrigger();
    createPanel();
    createSuggestModal();

    // Add wand menu button (채팅방 확장 버튼)
    addWandMenuButton();

    // Register events & commands
    registerEventListeners();
    registerSlashCommands();

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
function restoreChatMetadata() {
    const stored = chat_metadata?.[METADATA_KEY];

    if (!stored) {
        // 새 채팅 / LL 데이터 없는 채팅 — strict reset
        settings.targetLorebook = '';
        settings.selectionLorebooks = [];
        return;
    }

    settings.targetLorebook = typeof stored.targetLorebook === 'string' ? stored.targetLorebook : '';
    settings.selectionLorebooks = Array.isArray(stored.selectionLorebooks)
        ? [...stored.selectionLorebooks]
        : [];
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
            <button class="ll-toolbar-btn arc" data-action="arc">
                <i class="fa-solid fa-book-bookmark"></i> 줄거리 생성/업데이트
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
            <button class="ll-filter-chip" data-filter="arc"><i class="fa-solid fa-book-bookmark" style="margin-right:3px;font-size:10px;"></i>줄거리</button>
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
                <i class="fa-solid fa-map-pin"></i> 엔트리 삽입 위치
            </div>
            <div class="ll-settings-row">
                <label>위치</label>
                <select class="ll-settings-input" id="ll_s_position">
                    <option value="0">↑Char (캐릭터 정의 전)</option>
                    <option value="1">↓Char (캐릭터 정의 후)</option>
                    <option value="2">↑EM (예시 메시지 전)</option>
                    <option value="3">↓EM (예시 메시지 후)</option>
                    <option value="5">↑AN (작가노트 전)</option>
                    <option value="6">↓AN (작가노트 후)</option>
                </select>
            </div>

            <div class="ll-settings-section-title">
                <i class="fa-solid fa-broom"></i> 기억 정리 후 동작
            </div>
            <div class="ll-settings-row">
                <label>분석한 메시지 자동 하이드</label>
                <input class="ll-settings-input" id="ll_s_hide_after" type="checkbox" style="width:auto;" />
            </div>
            <div class="ll-settings-row">
                <label>최근 N개 메시지 유지</label>
                <input class="ll-settings-input" id="ll_s_hide_depth" type="number" min="0" max="1000" />
                <span class="ll-settings-unit" style="font-size:11px;opacity:0.6;">0=전부</span>
            </div>

            <div class="ll-settings-section-title">
                <i class="fa-solid fa-arrows-rotate"></i> 재구성 시 기존 엔트리
            </div>
            <div class="ll-settings-row">
                <label>처리 방식</label>
                <select class="ll-settings-input" id="ll_s_reorg_handling">
                    <option value="hide">하이드 (비활성화, 복구 가능)</option>
                    <option value="delete">삭제 (완전 제거)</option>
                </select>
            </div>

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
                <i class="fa-solid fa-magnifying-glass-arrow-right"></i> Summary (검색 힌트)
            </div>
            <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;gap:6px;">
                <div style="font-size:11px;opacity:0.7;line-height:1.4;">
                    엔트리마다 "언제 이 엔트리를 골라야 하는지" 한 줄 힌트를 저장합니다.
                    기존 엔트리에 일괄 생성하려면 아래 버튼 클릭.
                </div>
                <button class="menu_button" id="ll_s_backfill_btn" style="width:unset;white-space:nowrap;">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> 기존 엔트리에 Summary 일괄 생성
                </button>
                <div id="ll_s_backfill_status" style="font-size:11px;opacity:0.7;"></div>
            </div>

            <div class="ll-settings-section-title">
                <i class="fa-solid fa-link"></i> 자동 체인
            </div>
            <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;gap:4px;">
                <div style="font-size:11px;opacity:0.7;line-height:1.4;margin-bottom:4px;">
                    기억 정리 / 재구성 끝나면 추가 작업 자동 실행. 매 호출에 LLM 1~2번 추가.
                </div>
                <label class="checkbox_label">
                    <input id="ll_s_auto_backfill_organize" type="checkbox" />
                    <span>기억 정리 후 자동 Summary 백필 <span style="font-size:10px;opacity:0.6;">(managed mode 한정, 새 entries만)</span></span>
                </label>
                <label class="checkbox_label">
                    <input id="ll_s_auto_arc_organize" type="checkbox" />
                    <span>기억 정리 후 자동 줄거리 업데이트 <span style="font-size:10px;opacity:0.6;">(기존 arc 있을 때만)</span></span>
                </label>
                <label class="checkbox_label">
                    <input id="ll_s_auto_arc_reorganize" type="checkbox" />
                    <span>재구성 후 자동 줄거리 업데이트 <span style="font-size:10px;opacity:0.6;">(기존 arc 있을 때만)</span></span>
                </label>
            </div>

            <div class="ll-settings-section-title">
                <i class="fa-solid fa-microscope"></i> AI 선택 주입
            </div>
            <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;gap:6px;">
                <div style="font-size:11px;opacity:0.7;line-height:1.4;">
                    매 generation 직전 AI가 summary 보고 적절한 엔트리만 골라 주입.
                    아래 <b>선택 소스 로어북</b>에서 통제할 로어북을 등록하고, 각 로어북마다 <b>managed mode 전환</b>을 눌러 ST 자동 활성화를 끕니다 (이중 주입 방지).
                </div>
            </div>

            <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;gap:8px;">
                <div style="font-weight:bold;font-size:12px;">
                    <i class="fa-solid fa-star" style="color:#fbbf24;"></i> Target 로어북 (쓰기 대상)
                </div>
                <div style="display:flex;gap:6px;align-items:center;">
                    <select class="ll-settings-input" id="ll_s_target_lorebook" style="flex:1;">
                        <option value="">(선택 안 됨)</option>
                    </select>
                    <button class="menu_button" id="ll_s_target_lorebook_clear" title="연결 해제" style="width:unset;padding:4px 8px;">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div style="font-size:10px;opacity:0.6;line-height:1.3;">
                    organize / compress / arc가 새 entry를 만들 로어북. 항상 자동 포함됨.
                </div>
            </div>

            <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;gap:8px;">
                <div style="font-weight:bold;font-size:12px;">
                    <i class="fa-solid fa-layer-group"></i> 선택 소스 로어북 (읽기 대상 — 추가)
                </div>
                <div style="display:flex;gap:6px;align-items:center;">
                    <select class="ll-settings-input" id="ll_s_add_lorebook" style="flex:1;">
                        <option value="">+ 추가할 로어북 선택...</option>
                    </select>
                    <button class="menu_button" id="ll_s_add_lorebook_btn" style="width:unset;white-space:nowrap;padding:4px 10px;">
                        <i class="fa-solid fa-plus"></i> 추가
                    </button>
                </div>
                <div id="ll_s_lorebook_list" style="display:flex;flex-direction:column;gap:6px;"></div>
            </div>
            <div class="ll-settings-row">
                <label class="checkbox_label" style="flex:1;">
                    <input id="ll_s_selection_enabled" type="checkbox" />
                    <span>Summary 기반 AI 선택 사용</span>
                </label>
            </div>
            <div class="ll-settings-row">
                <label>AI 선택 결과 (top K)</label>
                <input class="ll-settings-input" id="ll_s_ai_select_k" type="number" min="1" max="30" />
            </div>
            <div class="ll-settings-row">
                <label class="checkbox_label" style="flex:1;">
                    <input id="ll_s_bm25_prefilter_enabled" type="checkbox" />
                    <span>BM25 텍스트 매칭 prefilter <span style="font-size:10px;opacity:0.6;">(권장 ON — vector 의존성 0, ~50ms)</span></span>
                </label>
            </div>
            <div class="ll-settings-row">
                <label>BM25 prefilter Top-K</label>
                <input class="ll-settings-input" id="ll_s_bm25_prefilter_k" type="number" min="5" max="500" />
                <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">후보 > K일 때만 작동</span>
            </div>
            <div class="ll-settings-row">
                <label>채팅 스캔 깊이</label>
                <input class="ll-settings-input" id="ll_s_scan_depth" type="number" min="1" max="50" />
                <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">최근 N msg</span>
            </div>
            <div class="ll-settings-row">
                <label>AI 선택 timeout (초)</label>
                <input class="ll-settings-input" id="ll_s_timeout_sec" type="number" min="5" max="600" />
                <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">기본 120 — 이 시간 넘으면 폴백</span>
            </div>
            <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;gap:4px;opacity:0.6;">
                <div style="font-size:11px;line-height:1.4;">
                    <i class="fa-solid fa-circle-info" style="color:#fbbf24;"></i>
                    <b>주입 위치/깊이는 entry별 옵션 + ST 프리셋의 World Info 슬롯에 따름.</b>
                    LL은 entry를 ST WI 시스템에 강제 활성화만 함. 위치 변경하려면 ST 월드 인포 에디터에서 entry의 position/depth 직접 수정하거나 프리셋의 WI 슬롯 위치 조정.
                </div>
            </div>
            <div class="ll-settings-row">
                <label class="checkbox_label" style="flex:1;">
                    <input id="ll_s_cache_enabled" type="checkbox" />
                    <span>선택 결과 캐싱 (스와이프/리젠 비용 0)</span>
                </label>
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
            <div style="display:flex;flex-direction:column;gap:4px;">
                <label style="font-size:12px;">Summary 백필 프롬프트</label>
                <textarea class="ll-settings-textarea" id="ll_s_summary_backfill_prompt" rows="3"></textarea>
                <button class="ll-settings-reset-btn" data-reset="summaryBackfillPrompt"><i class="fa-solid fa-rotate-left"></i> 초기화</button>
            </div>
        </div>

        <!-- Status Bar -->
        <div class="ll-status-bar">
            <div class="ll-status-item" id="ll_stat_entries_box">
                <i class="fa-solid fa-book"></i>
                <span class="ll-status-value" id="ll_stat_entries">0</span>개
            </div>
            <div class="ll-status-item ll-stat-storage" id="ll_stat_storage_box" title="저장 토큰 (selection 로어북의 활성 엔트리 합) — 클릭하면 로어북별 breakdown">
                <i class="fa-solid fa-database"></i>
                <span style="font-size:10px;opacity:0.7;">저장</span>
                <span class="ll-status-value" id="ll_stat_storage">0</span>
            </div>
            <div class="ll-status-item ll-stat-inject" id="ll_stat_inject_box" title="실제 주입 토큰 (마지막 generation 기준) — 클릭하면 breakdown">
                <i class="fa-solid fa-arrow-down-to-bracket"></i>
                <span style="font-size:10px;opacity:0.7;">주입</span>
                <span class="ll-status-value" id="ll_stat_inject">—</span>
                <span class="ll-stat-ratio" id="ll_stat_ratio" style="font-size:10px;opacity:0.6;"></span>
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

// ============================================================
// Suggest Modal
// ============================================================

let suggestState = {
    suggestions: [],
    userRequirements: '',
    characterContext: '',
};

function createSuggestModal() {
    if (document.querySelector('dialog.ll-suggest-modal')) return;

    const modal = document.createElement('dialog');
    modal.className = 'll-suggest-modal';
    modal.innerHTML = `
        <div class="ll-suggest-header">
            <div class="ll-suggest-title">
                <i class="fa-solid fa-wand-magic-sparkles"></i> 세계관 제안
            </div>
            <button class="ll-suggest-close" title="닫기">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>

        <div class="ll-suggest-body">
            <div class="ll-suggest-section">
                <label class="ll-suggest-label">내가 넣고싶은 설정 (선택)</label>
                <textarea class="ll-suggest-req" id="ll_suggest_req" rows="4"
                    placeholder="예시: 주인공 집은 원룸이고, 친구는 한국계 2세야. 동네에 있는 카페 2개 정도 넣어줘..."></textarea>
                <div class="ll-suggest-actions-top">
                    <button class="ll-suggest-btn ll-suggest-btn-secondary" id="ll_suggest_regen">
                        <i class="fa-solid fa-arrows-rotate"></i> 제안 받기 / 다시 받기
                    </button>
                </div>
            </div>

            <div class="ll-suggest-section">
                <div class="ll-suggest-list-header">
                    <label class="ll-suggest-label">제안된 엔트리</label>
                    <div class="ll-suggest-list-controls">
                        <button class="ll-suggest-mini-btn" id="ll_suggest_all">전체 선택</button>
                        <button class="ll-suggest-mini-btn" id="ll_suggest_none">전체 해제</button>
                    </div>
                </div>
                <div class="ll-suggest-list" id="ll_suggest_list">
                    <div class="ll-suggest-empty">
                        아직 제안이 없습니다. 위의 "제안 받기" 버튼을 눌러주세요.
                    </div>
                </div>
            </div>
        </div>

        <div class="ll-suggest-footer">
            <button class="ll-suggest-btn ll-suggest-btn-cancel" id="ll_suggest_cancel">취소</button>
            <button class="ll-suggest-btn ll-suggest-btn-primary" id="ll_suggest_generate">
                <i class="fa-solid fa-check"></i> 선택한 항목 생성
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

function openSuggestModal() {
    if (!settings.targetLorebook) {
        toastr.warning('대상 로어북을 먼저 선택해주세요.');
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
        list.innerHTML = `<div class="ll-suggest-empty">아직 제안이 없습니다. 위의 "제안 받기" 버튼을 눌러주세요.</div>`;
        return;
    }

    const catLabels = {
        arc: '줄거리',
        character: '캐릭터', relationship: '관계', location: '장소',
        event: '사건', routine: '일상', item: '아이템', fact: '설정',
    };

    list.innerHTML = suggestState.suggestions.map((s, i) => `
        <div class="ll-suggest-item" data-idx="${i}">
            <label class="ll-suggest-item-head">
                <input type="checkbox" class="ll-suggest-item-check" checked />
                <select class="ll-suggest-item-cat">
                    ${Object.entries(catLabels).map(([k, v]) =>
                        `<option value="${k}"${s.category === k ? ' selected' : ''}>${v}</option>`,
                    ).join('')}
                </select>
                <input type="text" class="ll-suggest-item-title" value="${escapeAttr(s.title || '')}" placeholder="제목" />
            </label>
            <div class="ll-suggest-item-reason">${escapeHtml(s.reason || '')}</div>
            <textarea class="ll-suggest-item-draft" rows="2" placeholder="추가 메모 / 초안 (선택)">${escapeHtml(s.content || '')}</textarea>
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
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 제안 생성 중...';
    list.innerHTML = `<div class="ll-suggest-empty"><i class="fa-solid fa-spinner fa-spin"></i> AI 분석 중...</div>`;

    try {
        const suggestions = await suggestWorldEntries(
            suggestState.characterContext,
            suggestState.userRequirements,
        );
        suggestState.suggestions = suggestions;
        renderSuggestList();
        toastr.success(`${suggestions.length}개의 제안을 받았습니다.`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Suggest failed:`, err);
        toastr.error(err.message || '제안 받기에 실패했습니다.');
        list.innerHTML = `<div class="ll-suggest-empty">제안 받기 실패. 다시 시도해주세요.</div>`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> 제안 받기 / 다시 받기';
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
        toastr.warning('선택된 항목이 없습니다.');
        return;
    }

    const btn = document.getElementById('ll_suggest_generate');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 생성 중...';
    }

    try {
        const userReq = document.getElementById('ll_suggest_req')?.value || '';
        const created = await generateFromSuggestions(items, suggestState.characterContext, userReq);
        toastr.success(`${created.length}개의 엔트리가 생성되었습니다.`);
        closeSuggestModal();
        refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Generate from suggestions failed:`, err);
        toastr.error(err.message || '엔트리 생성에 실패했습니다.');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-check"></i> 선택한 항목 생성';
        }
    }
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

    // Storage / Inject 칩 클릭 → breakdown 토스트
    panel.querySelector('#ll_stat_storage_box')?.addEventListener('click', showStorageBreakdown);
    panel.querySelector('#ll_stat_inject_box')?.addEventListener('click', showInjectBreakdown);

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

    bind('#ll_s_position', 'entryPosition');
    bind('#ll_s_hide_depth', 'hideAfterOrganizeDepth');
    bind('#ll_s_topk', 'vectorTopK');

    // Checkbox bind (hideAfterOrganize)
    const hideAfterEl = panel.querySelector('#ll_s_hide_after');
    if (hideAfterEl) {
        hideAfterEl.checked = !!settings.hideAfterOrganize;
        hideAfterEl.addEventListener('change', () => {
            settings.hideAfterOrganize = hideAfterEl.checked;
            saveSettings();
        });
    }

    // Select bind (reorganizeOldHandling)
    const reorgEl = panel.querySelector('#ll_s_reorg_handling');
    if (reorgEl) {
        reorgEl.value = settings.reorganizeOldHandling || 'hide';
        reorgEl.addEventListener('change', () => {
            settings.reorganizeOldHandling = reorgEl.value;
            saveSettings();
        });
    }

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
    bindTextarea('#ll_s_summary_backfill_prompt', 'summaryBackfillPrompt');

    // Backfill 버튼
    const backfillBtn = panel.querySelector('#ll_s_backfill_btn');
    const backfillStatus = panel.querySelector('#ll_s_backfill_status');
    if (backfillBtn) {
        backfillBtn.addEventListener('click', () => handleBackfillSummaries(backfillBtn, backfillStatus));
    }

    // 자동 체인 토글 3개
    [
        ['#ll_s_auto_backfill_organize', 'autoBackfillOnOrganize'],
        ['#ll_s_auto_arc_organize', 'autoArcOnOrganize'],
        ['#ll_s_auto_arc_reorganize', 'autoArcOnReorganize'],
    ].forEach(([sel, key]) => {
        const el = panel.querySelector(sel);
        if (!el) return;
        el.checked = settings[key] !== false;
        el.addEventListener('change', () => {
            settings[key] = el.checked;
            saveSettings();
        });
    });

    // AI 선택 주입 설정 binding
    bind('#ll_s_ai_select_k', 'aiSelectK');
    bind('#ll_s_bm25_prefilter_k', 'bm25PrefilterK');

    // Timeout 인풋 (초 ↔ ms)
    const timeoutEl = panel.querySelector('#ll_s_timeout_sec');
    if (timeoutEl) {
        timeoutEl.value = String(Math.round((settings.selectionTimeoutMs || 120000) / 1000));
        timeoutEl.addEventListener('change', () => {
            const sec = Math.max(5, Math.min(600, Number(timeoutEl.value) || 120));
            settings.selectionTimeoutMs = sec * 1000;
            saveSettings();
        });
    }

    const bm25EnabledEl = panel.querySelector('#ll_s_bm25_prefilter_enabled');
    if (bm25EnabledEl) {
        bm25EnabledEl.checked = settings.bm25PrefilterEnabled !== false;
        bm25EnabledEl.addEventListener('change', () => {
            settings.bm25PrefilterEnabled = bm25EnabledEl.checked;
            saveSettings();
            clearSelectionCache();
        });
    }
    bind('#ll_s_scan_depth', 'selectionScanDepth');
    // 주입 깊이/역할 입력은 제거됨 (WORLDINFO_FORCE_ACTIVATE로 변경 후 entry별 옵션 + ST WI 슬롯 사용)

    const selectionEnabledEl = panel.querySelector('#ll_s_selection_enabled');
    if (selectionEnabledEl) {
        selectionEnabledEl.checked = !!settings.summarySelectionEnabled;
        selectionEnabledEl.addEventListener('change', () => {
            if (selectionEnabledEl.checked) {
                const lbs = getEffectiveSelectionLorebooks();
                const anyManaged = lbs.some(name => isManagedMode(name));
                if (!anyManaged) {
                    toastr.warning('먼저 어떤 로어북이든 하나는 "managed 전환"을 실행해주세요. 안 그러면 우리 모듈이 주입할 후보가 없습니다.');
                    selectionEnabledEl.checked = false;
                    return;
                }
            }
            settings.summarySelectionEnabled = selectionEnabledEl.checked;
            saveSettings();
            clearSelectionCache();
            toastr.info(`AI 선택 주입: ${settings.summarySelectionEnabled ? 'ON' : 'OFF'}`);
        });
    }

    const cacheEnabledEl = panel.querySelector('#ll_s_cache_enabled');
    if (cacheEnabledEl) {
        cacheEnabledEl.checked = settings.selectionCacheEnabled !== false;
        cacheEnabledEl.addEventListener('change', () => {
            settings.selectionCacheEnabled = cacheEnabledEl.checked;
            saveSettings();
            if (!cacheEnabledEl.checked) clearSelectionCache();
        });
    }

    // Target 로어북 변경 dropdown
    populateTargetLorebookDropdown(panel);
    const targetSelect = panel.querySelector('#ll_s_target_lorebook');
    const targetClearBtn = panel.querySelector('#ll_s_target_lorebook_clear');
    if (targetSelect) {
        targetSelect.addEventListener('change', () => {
            const val = targetSelect.value;
            // 항상 setChatLorebook 호출 — chat_metadata 저장 보장
            // (같은 값 선택했더라도 stale 글로벌 settings를 chat_metadata에 저장하는 의미)
            setChatLorebook(val);
            // 사이드바 dropdown 동기화
            $('#ll_target_lorebook').val(val || '');
            clearSelectionCache();
            renderSelectionLorebookList(panel);
            populateAddLorebookDropdown(panel);
            populateTargetLorebookDropdown(panel);
            updateStatusBar();
            renderTimeline();
            toastr.info(val ? `Target → "${val}" (chat에 저장됨)` : 'Target 해제됨', 'LivingLorebook');
        });
    }
    if (targetClearBtn) {
        targetClearBtn.addEventListener('click', () => {
            if (!settings.targetLorebook) return;
            if (!window.confirm(`Target 로어북 "${settings.targetLorebook}" 연결을 해제합니다.\n\n로어북 자체는 삭제되지 않습니다. 계속?`)) return;
            setChatLorebook('');
            $('#ll_target_lorebook').val('');
            clearSelectionCache();
            renderSelectionLorebookList(panel);
            populateAddLorebookDropdown(panel);
            populateTargetLorebookDropdown(panel);
            updateStatusBar();
            renderTimeline();
            toastr.info('Target 해제됨');
        });
    }

    // 선택 소스 로어북 추가/카드 리스트 렌더
    renderSelectionLorebookList(panel);
    populateAddLorebookDropdown(panel);
    const addBtn = panel.querySelector('#ll_s_add_lorebook_btn');
    const addSelect = panel.querySelector('#ll_s_add_lorebook');
    if (addBtn && addSelect) {
        addBtn.addEventListener('click', () => {
            const val = addSelect.value;
            if (!val) {
                toastr.warning('추가할 로어북을 선택해주세요.');
                return;
            }
            // chat_metadata 우선 (settings는 stale일 수 있음)
            const current = getChatSelectionLorebooks();
            if (val === settings.targetLorebook) {
                toastr.info(`"${val}"은 이미 target 로어북입니다 (자동 포함).`);
                populateAddLorebookDropdown(panel); // 옛날 옵션 정리
                return;
            }
            if (current.includes(val)) {
                toastr.info(`"${val}"은 이미 selection 리스트에 있습니다.`);
                populateAddLorebookDropdown(panel);
                return;
            }
            setChatSelectionLorebooks([...current, val]);
            renderSelectionLorebookList(panel);
            populateAddLorebookDropdown(panel);
            toastr.success(`"${val}" 추가됨`);
        });
    }

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
                summaryBackfillPrompt: '#ll_s_summary_backfill_prompt',
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

    // content의 XML 태그에서 카테고리 역추적
    const TAG_TO_CATEGORY = {
        story_arc: 'arc',
        character_info: 'character',
        relationship_info: 'relationship',
        location_info: 'location',
        event_log: 'event',
        routine_info: 'routine',
        item_info: 'item',
        world_setting: 'fact',
    };

    for (const [uid, entry] of Object.entries(data.entries)) {
        const meta = getMetadata(uid, settings.targetLorebook);
        // content 태그에서 카테고리 우선 판별 (로어북 간 uid 충돌 방지)
        let category = meta?.category || 'fact';
        const content = entry.content || '';
        const tagMatch = content.match(/<(story_arc|character_info|relationship_info|location_info|event_log|routine_info|item_info|world_setting)>/);
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
            html += `
                <div class="ll-entry-card${disabledClass}${pinnedClass}" data-uid="${entry.uid}" data-category="${cat}" data-pinned="${entry.pinned ? '1' : '0'}">
                    <div class="ll-entry-header">
                        <div class="ll-entry-title">${escapeHtml(entry.title)}${pinBadge}${entry.disabled ? ' <span class="ll-entry-hide-badge">HIDE</span>' : ''}</div>
                        <div class="ll-entry-actions">
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

            if (btn.classList.contains('ll-entry-pin')) {
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

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escapeAttr(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ============================================================
// Entry Edit / Hide / Delete
// ============================================================

const CATEGORY_LABELS = {
    arc: '줄거리',
    character: '캐릭터', relationship: '관계', location: '장소',
    event: '사건', routine: '일상', item: '아이템', fact: '설정',
};

function openInlineEditor(card, uid) {
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
        await renderTimeline();
    } catch (err) {
        console.error(`${LOG_PREFIX} Edit save failed:`, err);
        toastr.error(err.message || '저장에 실패했습니다.');
    }
}

async function handleEntryHideToggle(uid) {
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
        await renderTimeline();
    } catch (err) {
        console.error(`${LOG_PREFIX} Hide toggle failed:`, err);
        toastr.error(err.message || '처리에 실패했습니다.');
    }
}

async function handleEntryPinToggle(uid, pinned) {
    try {
        const data = await loadTargetLorebook();
        if (!data?.entries?.[uid]) throw new Error('엔트리를 찾을 수 없습니다');

        setEntryPinned(data, uid, pinned);
        await saveLorebook(settings.targetLorebook, data);
        refreshEditor();
        clearSelectionCache();
        await renderTimeline();
        toastr.info(pinned ? '📌 핀됨 — 항상 inject됩니다.' : '핀 해제됨.');
    } catch (err) {
        console.error(`${LOG_PREFIX} Pin toggle failed:`, err);
        toastr.error(err.message || '처리에 실패했습니다.');
    }
}

async function handleEntryDelete(uid) {
    if (!confirm('이 엔트리를 완전히 삭제하시겠습니까? 되돌릴 수 없습니다.')) return;

    try {
        const data = await loadTargetLorebook();
        if (!data?.entries?.[uid]) throw new Error('엔트리를 찾을 수 없습니다');

        deleteEntry(data, uid, settings.targetLorebook);
        await saveLorebook(settings.targetLorebook, data);
        refreshEditor();
        toastr.success('삭제되었습니다.');
        await renderTimeline();
    } catch (err) {
        console.error(`${LOG_PREFIX} Delete failed:`, err);
        toastr.error(err.message || '삭제에 실패했습니다.');
    }
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

/**
 * 주입 칩만 즉시 갱신 — selectEntries 끝날 때마다 호출 (값은 메모리에 이미 있음).
 */
function refreshInjectChip() {
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

// ============================================================
// Toolbar Actions
// ============================================================

async function handleToolbarAction(action) {
    if (isProcessing) return;

    switch (action) {
        case 'build':
            // 새 워크플로우: 제안 모달 열기
            openSuggestModal();
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

        case 'arc':
            await handleGenerateArc();
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
            setChatLorebook(newName);
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

    // 범위 지정 팝업 띄우기
    openOrganizeRangeModal(chat.length);
}

// ============================================================
// Organize Range Modal
// ============================================================

function openOrganizeRangeModal(chatLength) {
    // 이미 있으면 제거
    document.querySelector('dialog.ll-range-modal')?.remove();

    const modal = document.createElement('dialog');
    modal.className = 'll-range-modal';
    modal.innerHTML = `
        <div class="ll-range-header">
            <div class="ll-range-title"><i class="fa-solid fa-broom"></i> 기억 정리 범위</div>
            <button class="ll-range-close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="ll-range-body">
            <div class="ll-range-option">
                <label class="ll-range-radio-label">
                    <input type="radio" name="ll_range_mode" value="all" checked />
                    <span>전체 대화 정리</span>
                    <small>현재 채팅의 모든 메시지를 분석</small>
                </label>
            </div>
            <div class="ll-range-option">
                <label class="ll-range-radio-label">
                    <input type="radio" name="ll_range_mode" value="range" />
                    <span>범위 지정</span>
                    <small>특정 메시지 ID 구간만 분석 (0 ~ ${chatLength - 1})</small>
                </label>
                <div class="ll-range-inputs">
                    <input type="number" id="ll_range_start" min="0" max="${chatLength - 1}" placeholder="시작 ID" />
                    <span>~</span>
                    <input type="number" id="ll_range_end" min="0" max="${chatLength - 1}" placeholder="끝 ID" value="${chatLength - 1}" />
                </div>
            </div>
            <div class="ll-range-hint">
                * 메시지 ID는 채팅창의 메시지 번호 (0부터 시작)
            </div>
        </div>
        <div class="ll-range-footer">
            <button class="ll-range-btn ll-range-cancel">취소</button>
            <button class="ll-range-btn ll-range-confirm">정리 실행</button>
        </div>
    `;

    document.body.appendChild(modal);
    modal.showModal();

    const close = () => { modal.close(); modal.remove(); };

    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('.ll-range-close').addEventListener('click', close);
    modal.querySelector('.ll-range-cancel').addEventListener('click', close);

    // 범위 라디오 선택 시 입력 활성화
    const rangeRadio = modal.querySelector('input[value="range"]');
    const allRadio = modal.querySelector('input[value="all"]');
    const inputs = modal.querySelector('.ll-range-inputs');

    rangeRadio.addEventListener('change', () => inputs.classList.add('active'));
    allRadio.addEventListener('change', () => inputs.classList.remove('active'));

    modal.querySelector('.ll-range-confirm').addEventListener('click', () => {
        const mode = modal.querySelector('input[name="ll_range_mode"]:checked')?.value;
        let options = {};
        if (mode === 'range') {
            const start = parseInt(modal.querySelector('#ll_range_start')?.value, 10);
            const end = parseInt(modal.querySelector('#ll_range_end')?.value, 10);
            if (isNaN(start) || isNaN(end) || start > end) {
                toastr.warning('유효한 범위를 입력해주세요.');
                return;
            }
            options = { rangeStart: start, rangeEnd: end };
        }
        close();
        runOrganize(options);
    });
}

async function runOrganize(options = {}) {
    const chat = context.chat || [];
    setToolbarProcessing(true, 'organize');

    try {
        const result = await organize(chat, getCharacterContext(), options);
        const parts = [];
        if (result.added > 0) parts.push(`추가 ${result.added}`);
        if (result.updated > 0) parts.push(`수정 ${result.updated}`);
        if (result.deactivated > 0) parts.push(`비활성화 ${result.deactivated}`);

        if (parts.length > 0) {
            toastr.success(`정리 완료: ${parts.join(', ')}`);
        } else {
            toastr.info('변경사항이 없습니다.');
        }

        // 자동 체인 결과 알림 (backfill / arc)
        const chain = result.chain;
        if (chain) {
            const chainParts = [];
            if (chain.backfilled > 0) chainParts.push(`🔍 summary ${chain.backfilled}개 백필`);
            if (chain.arcUpdated) chainParts.push('📖 줄거리 업데이트');
            if (chainParts.length > 0) {
                toastr.info(chainParts.join(' · '), '자동 체인', { timeOut: 4000 });
            }
            if (chain.errors && chain.errors.length > 0) {
                toastr.warning(`자동 체인 일부 실패: ${chain.errors.join(' / ')}`, 'LivingLorebook', { timeOut: 6000 });
            }
        }

        // 자동 하이드
        if (settings.hideAfterOrganize && Array.isArray(result.processedIndices) && result.processedIndices.length > 0) {
            try {
                const { hideChatMessageRange } = await import('../../../chats.js');
                const depth = Math.max(0, Number(settings.hideAfterOrganizeDepth) || 0);
                // depth만큼 최근 메시지는 제외 (chat.length - 1 부터 depth개는 건드리지 않음)
                const keepFromIdx = chat.length - depth;
                const targetIndices = result.processedIndices.filter(i => i < keepFromIdx);

                if (targetIndices.length > 0) {
                    // 연속 구간 병합 후 hideChatMessageRange 호출
                    targetIndices.sort((a, b) => a - b);
                    let rangeStart = targetIndices[0];
                    let prev = rangeStart;
                    for (let i = 1; i < targetIndices.length; i++) {
                        if (targetIndices[i] === prev + 1) {
                            prev = targetIndices[i];
                            continue;
                        }
                        await hideChatMessageRange(rangeStart, prev, false);
                        rangeStart = targetIndices[i];
                        prev = rangeStart;
                    }
                    await hideChatMessageRange(rangeStart, prev, false);
                    toastr.info(`${targetIndices.length}개의 메시지가 하이드 처리되었습니다.`);
                }
            } catch (err) {
                console.warn(`${LOG_PREFIX} Auto-hide failed:`, err);
            }
        }

        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Organize failed:`, err);
        toastr.error(err.message || '기억 정리에 실패했습니다.');
    } finally {
        setToolbarProcessing(false);
    }
}

async function handleBackfillSummaries(btn, statusEl) {
    if (!settings.targetLorebook) {
        toastr.warning('대상 로어북을 먼저 선택해주세요.');
        return;
    }
    if (btn.dataset.busy === '1') return;

    btn.dataset.busy = '1';
    btn.disabled = true;
    const origLabel = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 생성 중...';
    if (statusEl) statusEl.textContent = '시작...';

    try {
        const result = await backfillSummaries({
            onProgress: (done, total) => {
                if (statusEl) statusEl.textContent = `${done} / ${total} 처리됨`;
            },
        });

        if (result.total === 0) {
            toastr.info('Summary가 필요한 엔트리가 없습니다.');
            if (statusEl) statusEl.textContent = '대상 없음 (모든 엔트리에 이미 summary 있음)';
        } else {
            const msg = `${result.filled}/${result.total}개 summary 생성 완료${result.failed > 0 ? ` (실패 ${result.failed})` : ''}`;
            toastr.success(msg);
            if (statusEl) statusEl.textContent = msg;
        }
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Backfill failed:`, err);
        toastr.error(err.message || 'Summary 생성에 실패했습니다.');
        if (statusEl) statusEl.textContent = `실패: ${err.message || '알 수 없는 오류'}`;
    } finally {
        btn.dataset.busy = '';
        btn.disabled = false;
        btn.innerHTML = origLabel;
    }
}

/**
 * 특정 로어북에 대해 managed mode 전환/해제.
 */
async function handleMigrateLorebook(lorebookName, goingToManaged, btn) {
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
        await renderTimeline();
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
function populateTargetLorebookDropdown(panel) {
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
function populateAddLorebookDropdown(panel) {
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
async function renderSelectionLorebookList(panel) {
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
        if (migrateBtn) {
            migrateBtn.addEventListener('click', () => {
                const goingTo = migrateBtn.dataset.managed !== '1';
                handleMigrateLorebook(name, goingTo, migrateBtn);
            });
        }
    });
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

async function handleGenerateArc() {
    if (!settings.targetLorebook) {
        toastr.warning('대상 로어북을 먼저 선택해주세요.');
        return;
    }

    setToolbarProcessing(true, 'arc');

    try {
        const result = await generateStoryArc();
        const verb = result.created ? '생성' : '업데이트';
        toastr.success(`📖 Story Arc ${verb}됨 (${result.tokens.toLocaleString()} 토큰, 항상 inject)`);
        clearSelectionCache();
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Story Arc generation failed:`, err);
        toastr.error(err.message || 'Story Arc 생성에 실패했습니다.');
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
        if (result.arcUpdated) {
            toastr.info('📖 줄거리도 업데이트됨', '자동 체인', { timeOut: 4000 });
        }
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
        }
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
