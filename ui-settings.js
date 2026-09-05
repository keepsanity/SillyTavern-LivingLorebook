/**
 * UI — 설정 뷰 (패널의 톱니 아이콘). 입력 바인딩 + 로어북 선택 소스 관리 + 벡터 인덱스 상태.
 *
 * 패널 갱신은 ui-shared의 refreshPanel 레지스트리로 (ui-panel과 순환 의존 회피).
 * 벡터 상태줄은 채팅이 바뀔 때도 다시 그려야 해서 refreshVectorStatus()로 밖에 노출한다.
 */

import { chat_metadata } from '../../../../script.js';
import { world_names } from '../../../world-info.js';
import { refreshPanel, escapeHtml } from './ui-shared.js';
import {
    getSettings, saveSettings, DEFAULT_SETTINGS,
    getEffectiveSelectionLorebooks, isManagedMode, describeChatScope,
} from './lore-store.js';
import { clearSelectionCache, reindexManagedLorebooks } from './summary-retrieval.js';
import { backfillSummaries } from './memory-manager.js';
import { getVectorSourceInfo } from './vector-service.js';
import { LL_TARGET_KEY, LL_SELECTION_KEY, setChatLorebook, getChatSelectionLorebooks, setChatSelectionLorebooks } from './chat-meta.js';
import { renderSelectionLorebookList, populateTargetLorebookDropdown, populateAddLorebookDropdown } from './ui-lorebooks.js';

const LOG_PREFIX = '[LivingLorebook]';

// bindSettingsInputs 내부 클로저를 밖에서 부르기 위한 참조 (채팅 전환 시 상태줄 갱신)
let _refreshVectorSourceStatus = null;

/** 벡터 인덱스 상태줄을 현재 채팅의 managed 로어북 기준으로 다시 그림 */
export function refreshVectorStatus() {
    _refreshVectorSourceStatus?.();
}

async function handleBackfillSummaries(btn, statusEl) {
    const settings = getSettings();
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

export function bindSettingsInputs(panel) {
    const settings = getSettings();
    const bind = (id, key, transform = Number) => {
        const el = panel.querySelector(id);
        if (!el) return;
        el.value = settings[key];
        el.addEventListener('change', () => {
            settings[key] = transform(el.value);
            saveSettings();
        });
    };

    // textarea를 내용 높이에 맞춰 자동 확장 (최대 60vh, 넘으면 스크롤)
    // 숨겨진(접힌) 상태에선 scrollHeight가 0이라 스킵 → 펼칠 때 다시 계산
    function autoGrowTextarea(el) {
        if (!el || el.offsetParent === null) return;
        el.style.height = 'auto';
        const cap = Math.floor(window.innerHeight * 0.6);
        const needed = el.scrollHeight + 2;
        el.style.height = Math.min(needed, cap) + 'px';
        el.style.overflowY = needed > cap ? 'auto' : 'hidden';
    }

    // 접이식 섹션 (고급 튜닝 / 프롬프트) — 헤더 클릭 시 본문 토글
    panel.querySelectorAll('.ll-settings-section-title.ll-collapsible').forEach(title => {
        title.addEventListener('click', () => {
            const content = panel.querySelector('#' + title.dataset.toggle);
            title.classList.toggle('collapsed');
            content?.classList.toggle('collapsed');
            // 펼친 직후: 숨어있던 textarea 높이를 내용에 맞춰 다시 계산
            if (content && !content.classList.contains('collapsed')) {
                content.querySelectorAll('textarea').forEach(autoGrowTextarea);
            }
        });
    });

    // 선택 엔진에 따라 고급 튜닝 파라미터 표시/숨김
    const ENGINE_SHORT = { hybrid: '스마트', bm25: '단어 매칭', ai: 'AI 정밀' };
    function updateEngineVisibility(engine) {
        const show = {
            '.ll-eng-fast':   engine !== 'ai',        // maxK / 컷오프
            '.ll-eng-vec':    engine === 'hybrid',    // 벡터 범위/하한/재색인 (하이브리드만)
            '.ll-eng-hybrid': engine === 'hybrid',    // RRF 가중치
            '.ll-eng-ai':     engine === 'ai',        // AI K / timeout / prefilter 토글
        };
        for (const [sel, visible] of Object.entries(show)) {
            panel.querySelectorAll(sel).forEach(el => { el.style.display = visible ? '' : 'none'; });
        }
        const lbl = panel.querySelector('#ll_s_engine_label');
        if (lbl) lbl.textContent = ENGINE_SHORT[engine] || engine;
    }

    bind('#ll_s_position', 'entryPosition');
    bind('#ll_s_hide_depth', 'hideAfterOrganizeDepth');

    // Checkbox bind (hideAfterOrganize)
    const hideAfterEl = panel.querySelector('#ll_s_hide_after');
    if (hideAfterEl) {
        hideAfterEl.checked = !!settings.hideAfterOrganize;
        hideAfterEl.addEventListener('change', () => {
            settings.hideAfterOrganize = hideAfterEl.checked;
            saveSettings();
        });
    }

    bind('#ll_s_reorg_batch', 'reorganizeBatchSize', v => {
        const n = parseInt(v, 10);
        return (Number.isFinite(n) && n >= 3 && n <= 40) ? n : 12;
    });

    // Select bind (reorganizeOldHandling)
    const reorgEl = panel.querySelector('#ll_s_reorg_handling');
    if (reorgEl) {
        reorgEl.value = settings.reorganizeOldHandling || 'hide';
        reorgEl.addEventListener('change', () => {
            settings.reorganizeOldHandling = reorgEl.value;
            saveSettings();
        });
    }

    bind('#ll_s_tier2', 'tier2TargetRatio');
    bind('#ll_s_tier3', 'tier3TargetRatio');

    // Prompt textareas
    const bindTextarea = (id, key) => {
        const el = panel.querySelector(id);
        if (!el) return;
        el.value = settings[key];
        autoGrowTextarea(el);   // 초기 높이 (펼쳐져 있으면 즉시, 접혀있으면 펼칠 때 재계산)
        el.addEventListener('input', () => {
            settings[key] = el.value;
            saveSettings();
            autoGrowTextarea(el);
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

    // 선택 엔진 + 벡터 파라미터
    const ENGINE_LABELS = {
        hybrid: '스마트 (단어+의미)',
        bm25: '단어 매칭 (임베딩 불필요)',
        ai: 'AI 정밀 선택',
    };
    /** 이 엔진이 벡터 인덱스를 필요로 하는가 */
    const needsVector = (engine) => engine === 'hybrid' || engine === 'vector';

    /**
     * ST 자체 Vector Storage가 같은 로어북을 **따로** 주입하고 있는지 감지.
     *
     * managed 전환은 엔트리의 `vectorized`를 false로 내려 ST의 WI 벡터 활성화를 피하는데,
     * ST 설정의 "Enabled for all entries"(enabled_for_all)가 켜져 있으면 그 플래그를 무시하고
     * 전부 벡터화한다 → LL이 고른 것 위에 ST가 top-N을 얹어 이중 주입이 된다.
     * 조용히 일어나서 원인 찾기가 매우 어려우므로 패널에 상시 경고한다.
     */
    function refreshConflictWarning() {
        const el = panel.querySelector('#ll_s_conflict_warn');
        if (!el) return;
        const v = SillyTavern.getContext().extensionSettings?.vectors || {};
        if (!settings.summarySelectionEnabled || !v.enabled_world_info) {
            el.innerHTML = '';
            return;
        }
        const forAll = !!v.enabled_for_all;
        el.innerHTML = `<span style="color:#f87171;">⚠ ST Vector Storage의 <b>"Enable for World Info"</b>가 켜져 있습니다`
            + (forAll ? ` (+ <b>"Enabled for all entries"</b>) — managed 엔트리의 vectorized=false가 무시되어 <b>LL과 별개로 최대 ${v.max_entries ?? 5}개가 더 주입</b>됩니다.` : ' — LL이 통제하지 않는 엔트리가 따로 주입될 수 있습니다.')
            + ` LL이 같은 일을 하므로 <b>끄시는 걸 권합니다.</b></span>`;
    }

    /** 현재 임베딩 소스 + 인덱스 시그니처 일치 여부를 패널에 표시 */
    function refreshVectorSourceStatus() {
        refreshConflictWarning();
        // 카드 리스트도 같이 다시 그린다. 예전엔 카드는 옛 chat_metadata, 상태줄은 새 chat_metadata를
        // 보여줘서 "카드엔 2개 managed ON인데 상태줄은 0개"라는 모순이 났다. 같은 시점을 보게 강제.
        renderSelectionLorebookList(panel);
        const el = panel.querySelector('#ll_s_vector_source');
        if (!el) return;
        const { source, model } = getVectorSourceInfo();
        const current = `${source}:${model}`;
        const indexed = settings.vectorIndexSignature || '';
        const label = `임베딩 소스: <b>${source}</b>${model ? ` / ${model}` : ''}`;

        // managed 로어북이 하나도 없으면 인덱스 상태를 따질 것도 없다 —
        // LL은 managed 로어북만 읽으므로 선택도 재색인도 대상이 0개다.
        const effective = getEffectiveSelectionLorebooks();
        const managedCount = effective.filter(name => isManagedMode(name)).length;
        if (managedCount === 0) {
            // 0개인 이유를 **화면에 그대로** 찍는다. 카드 리스트는 chat_metadata를 직접 읽고
            // 여기는 getEffectiveSelectionLorebooks()를 쓰는데, 둘이 어긋나면 추측할 방법이 없었다.
            const cmTarget = chat_metadata?.[LL_TARGET_KEY];
            const cmSel = chat_metadata?.[LL_SELECTION_KEY];
            const claimed = [];
            if (typeof cmTarget === 'string' && cmTarget) claimed.push(cmTarget);
            try {
                const parsed = JSON.parse(cmSel || '[]');
                if (Array.isArray(parsed)) claimed.push(...parsed);
            } catch { /* 깨진 값 */ }
            const names = world_names || [];
            const invalid = claimed.filter(n => !names.includes(n));
            const notManaged = effective.filter(n => !isManagedMode(n));

            const scope = describeChatScope();
            const dump = {
                '스코프 출처': scope,
                'chat_metadata 키 전체': chat_metadata ? Object.keys(chat_metadata) : null,
                'chat_metadata.target': cmTarget,
                'chat_metadata.selection': cmSel,
                'settings.targetLorebook': settings.targetLorebook,
                'settings.selectionLorebooks': settings.selectionLorebooks,
                'chat_metadata가 주장하는 로어북': claimed,
                'effective(=유효성 통과)': effective,
                'world_names 개수': names.length,
                'world_names에 없어서 탈락': invalid,
                'managed 아님': notManaged,
                'perLorebookMigrated': settings.perLorebookMigrated,
            };
            console.warn(`${LOG_PREFIX} managed 0개 진단`, dump);

            // 화면 문구 — 원인별로 갈라서 **구체적으로**
            let why;
            if (!scope.chatId) {
                // ST에 열린 채팅이 없다 (this_chid undefined). 로어북이 없는 게 당연하다.
                why = `<b>열린 채팅이 없습니다.</b> 채팅을 열면 그 채팅의 로어북을 읽습니다`;
            } else if (claimed.length === 0) {
                why = `<b>이 채팅에 지정된 로어북이 없습니다.</b> 위 <b>선택 소스 로어북</b>에서 target을 고르세요 (로어북은 <u>채팅마다 따로</u> 기억됩니다)`;
            } else if (invalid.length > 0) {
                // 이름은 있는데 ST의 로어북 목록에 없음 — 유니코드 표기 차이(NFC/NFD)나 이름 변경
                why = `<b>이름이 ST 로어북 목록과 안 맞습니다</b> — ${invalid.map(n => `"${escapeHtml(n)}"`).join(', ')} (world_names ${names.length}개 중 없음). 로어북을 <b>다시 선택</b>해주세요`;
            } else if (notManaged.length > 0) {
                why = `로어북 ${notManaged.length}개가 <b>managed가 아닙니다</b> (${escapeHtml(notManaged.join(', '))}) — 카드의 <b>managed 전환</b>을 눌러주세요`;
            } else {
                why = `원인 불명 — chat_metadata=[${claimed.map(escapeHtml).join(', ')}] / effective=[${effective.map(escapeHtml).join(', ')}]. 콘솔의 <b>managed 0개 진단</b>을 확인해주세요`;
            }
            el.innerHTML = `${label} · <span style="color:#f87171;">${why}</span>`;
            return;
        }

        // ── 현재 채팅의 managed 로어북 기준으로 per-lorebook 상태 표시 ──
        // (글로벌 vectorIndexCount는 "마지막 재색인한 것들의 합"이라 다른 채팅 값이 남아 헷갈림.
        //  지문 map[name] = "임베더|엔트리수|내용해시" 에서 이 로어북의 실제 수를 뽑아 쓴다)
        const map = (settings.vectorIndexByLorebook && typeof settings.vectorIndexByLorebook === 'object')
            ? settings.vectorIndexByLorebook : {};
        const managedNames = getEffectiveSelectionLorebooks().filter(name => isManagedMode(name));
        const perLb = managedNames.map(name => {
            const fp = map[name];
            if (!fp) return { name, indexed: false, count: 0, sigMatch: false };
            const parts = String(fp).split('|');       // [임베더, 수, 해시]
            return { name, indexed: true, count: parseInt(parts[1], 10) || 0, sigMatch: parts[0] === current };
        });
        const notIndexed = perLb.filter(p => !p.indexed || p.count === 0);
        const wrongSig = perLb.filter(p => p.indexed && p.count > 0 && !p.sigMatch);

        if (notIndexed.length) {
            el.innerHTML = `${label} · <span style="opacity:0.7;">아직 색인 안 됨: <b>${notIndexed.map(p => p.name).join(', ')}</b> — 채팅 열면 자동 색인되거나, 재색인 버튼</span>`;
        } else if (wrongSig.length) {
            el.innerHTML = `${label} · <span style="color:#f87171;">임베딩 소스가 바뀜 — 재색인 필요: <b>${wrongSig.map(p => p.name).join(', ')}</b></span>`;
        } else {
            const per = perLb.map(p => `${p.name} ${p.count}개`).join(' · ');
            el.innerHTML = `${label} · <span style="color:#4ade80;">인덱스 일치 (${per})</span>`;
        }
    }
    // 채팅 바뀔 때 밖(CHAT_CHANGED)에서도 이 상태줄을 다시 그릴 수 있게 참조 노출
    _refreshVectorSourceStatus = refreshVectorSourceStatus;

    const engineEl = panel.querySelector('#ll_s_selection_engine');
    if (engineEl) {
        // '벡터만'(vector) 옵션 제거됨 — 기존 저장값은 hybrid로 승격 (하이브리드가 벡터를 포함)
        if (settings.selectionEngine === 'vector') {
            settings.selectionEngine = 'hybrid';
            saveSettings();
        }
        engineEl.value = settings.selectionEngine || 'hybrid';
        updateEngineVisibility(engineEl.value);   // 초기 표시 상태
        engineEl.addEventListener('change', () => {
            settings.selectionEngine = engineEl.value;
            saveSettings();
            clearSelectionCache();
            updateEngineVisibility(engineEl.value);
            toastr.info(`선택 엔진: ${ENGINE_LABELS[engineEl.value] || engineEl.value}`);
            // 벡터를 쓰는 엔진 + 마스터 ON + 아직 색인 없음이면 자동 재색인 1회.
            // (이미 색인돼 있으면 사용자가 명시적으로 누를 때만 — 큰 로어북에서 임베딩 비용이 든다)
            if (needsVector(engineEl.value) && settings.summarySelectionEnabled && !settings.vectorIndexSignature) {
                const anyManaged = getEffectiveSelectionLorebooks().some(name => isManagedMode(name));
                if (anyManaged) performReindex({ silent: true });
            }
            refreshVectorSourceStatus();
        });
    }
    const kwEl = panel.querySelector('#ll_s_keyword_match');
    if (kwEl) {
        kwEl.checked = settings.keywordMatchEnabled !== false;
        kwEl.addEventListener('change', () => {
            settings.keywordMatchEnabled = kwEl.checked;
            saveSettings();
            clearSelectionCache();
            toastr.info(kwEl.checked ? '키워드 직격 ON — 키워드 일치 시 컷오프 면제' : '키워드 직격 OFF — 점수만으로 선택');
        });
    }

    bind('#ll_s_bm25_floor', 'bm25MinScoreRatio', v => {
        const n = parseFloat(v);
        return (Number.isFinite(n) && n >= 0 && n <= 1) ? n : 0.35;
    });
    bind('#ll_s_vector_ratio', 'vectorCutoffRatio', v => {
        const n = parseFloat(v);
        return (Number.isFinite(n) && n >= 0 && n <= 1) ? n : 0;
    });
    bind('#ll_s_vector_maxk', 'vectorSelectMaxK', v => Math.max(1, Math.min(50, Number(v) || 12)));
    bind('#ll_s_vector_scandepth', 'vectorScanDepth', v => Math.max(1, Math.min(50, Number(v) || 4)));
    bind('#ll_s_vector_threshold', 'vectorScoreThreshold', v => {
        const n = parseFloat(v);
        return (Number.isFinite(n) && n >= 0 && n < 1) ? n : 0.6;
    });
    bind('#ll_s_hybrid_wv', 'hybridVectorWeight', v => {
        const n = parseFloat(v);
        return (Number.isFinite(n) && n >= 0) ? n : 1;
    });
    bind('#ll_s_hybrid_wb', 'hybridBm25Weight', v => {
        const n = parseFloat(v);
        return (Number.isFinite(n) && n >= 0) ? n : 1;
    });
    refreshVectorSourceStatus();

    // 벡터 재색인 — 버튼 클릭 + 엔진 켤 때 자동 트리거 공용.
    // silent=true면 자동 트리거(작은 info 토스트), false면 수동 버튼(success 토스트).
    let _reindexInflight = false;
    async function performReindex({ silent = false } = {}) {
        if (_reindexInflight) return;          // 자동+수동 동시 호출 방지
        _reindexInflight = true;
        const btn = panel.querySelector('#ll_s_reindex_btn');
        const status = panel.querySelector('#ll_s_reindex_status');
        if (btn) btn.disabled = true;
        if (status) status.textContent = '재색인 중…';
        try {
            const { lorebooks, entries, signature } = await reindexManagedLorebooks();
            if (entries === 0) {
                // managed 로어북이 없으면 색인할 게 없다 — 성공으로 위장하지 않는다
                const warn = 'managed 로어북이 없어 색인할 게 없습니다. 위 목록에서 "managed 전환"을 누르세요.';
                if (status) status.textContent = warn;
                toastr.warning(warn, 'LivingLorebook', { timeOut: 6000 });
            } else {
                const msg = `재색인 완료: ${lorebooks}개 로어북 · ${entries}개 엔트리 (${signature})`;
                if (status) status.textContent = msg;
                if (silent) toastr.info(msg, 'LivingLorebook', { timeOut: 2500 });
                else toastr.success(msg, 'LivingLorebook');
            }
            refreshVectorSourceStatus();
        } catch (err) {
            console.error('[LivingLorebook] reindex failed:', err);
            if (status) status.textContent = `실패: ${err.message}`;
            toastr.error(`재색인 실패: ${err.message}`, 'LivingLorebook');
        } finally {
            if (btn) btn.disabled = false;
            _reindexInflight = false;
        }
    }

    // 벡터 재색인 버튼 (수동)
    const reindexBtn = panel.querySelector('#ll_s_reindex_btn');
    if (reindexBtn) {
        reindexBtn.addEventListener('click', () => performReindex({ silent: false }));
    }

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
            const engine = settings.selectionEngine || 'hybrid';
            toastr.info(`LL 자동 주입: ${settings.summarySelectionEnabled ? `ON (${ENGINE_LABELS[engine] || engine})` : 'OFF'}`);
            // 켜면서 벡터를 쓰는 엔진인데 아직 색인이 없으면 자동 재색인 1회
            if (settings.summarySelectionEnabled && needsVector(engine) && !settings.vectorIndexSignature) {
                performReindex({ silent: true });
            }
            refreshVectorSourceStatus();   // ST 이중주입 경고가 이 토글에 달려 있음
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
            refreshPanel();
            refreshPanel();
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
            refreshPanel();
            refreshPanel();
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
            const current = getChatSelectionLorebooks();
            console.log(`${LOG_PREFIX} Add attempt:`, {
                val,
                target: settings.targetLorebook,
                current_from_chat_metadata: current,
                chat_metadata_raw: chat_metadata?.[LL_SELECTION_KEY],
                settings_selection: settings.selectionLorebooks,
            });
            if (val === settings.targetLorebook) {
                toastr.info(`"${val}"은 이미 target 로어북입니다 (자동 포함).`);
                populateAddLorebookDropdown(panel);
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
