/**
 * UI — 패널 HTML 템플릿.
 * createPanel()이 innerHTML로 넣는 마크업 원본. 순수 문자열(로직 없음)이라
 * index.js의 덩치를 줄이려고 분리. 구조를 바꿀 땐 bindPanelEvents/bindSettingsInputs의
 * 셀렉터(id/class)와 짝이 맞는지 확인할 것.
 */

export const PANEL_HTML = `
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
            <button class="ll-toolbar-btn add-entry" data-action="add-entry">
                <i class="fa-solid fa-plus"></i> 새 엔트리
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
                    <span>LL 자동 주입 사용 <span style="font-size:10px;opacity:0.6;">(마스터 — 켜면 LL이 통제, ST 키워드 off)</span></span>
                </label>
            </div>
            <div class="ll-settings-row">
                <label>선택 엔진</label>
                <select class="ll-settings-input" id="ll_s_selection_engine" style="width:unset;flex:1;text-align:left;">
                    <option value="hybrid">스마트 (단어+의미) — 기본 권장</option>
                    <option value="bm25">단어 매칭 (임베딩 불필요·무료)</option>
                    <option value="ai">AI 정밀 선택 (느림)</option>
                </select>
            </div>
            <!-- ST 이중주입 경고 — 엔진 무관하게 항상 노출 (managed 로어북에 ST 벡터가 얹힐 수 있음) -->
            <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;">
                <div id="ll_s_conflict_warn" style="font-size:11px;line-height:1.4;"></div>
            </div>

            <!-- 고급 튜닝 (접이식, 엔진별 표시) -->
            <div class="ll-settings-section-title ll-collapsible collapsed" data-toggle="ll_s_adv_tuning">
                <i class="fa-solid fa-sliders"></i> 고급 튜닝
                <span style="font-size:10px;opacity:0.5;font-weight:400;margin-left:auto;">엔진: <span id="ll_s_engine_label">스마트</span></span>
                <i class="fa-solid fa-chevron-down ll-collapse-chevron"></i>
            </div>
            <div class="ll-settings-group collapsed" id="ll_s_adv_tuning">
                <!-- 스캔 범위 -->
                <div class="ll-settings-row">
                    <label>채팅 스캔 깊이</label>
                    <input class="ll-settings-input" id="ll_s_scan_depth" type="number" min="1" max="50" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">최근 N msg — 전 엔진 공통</span>
                </div>
                <div class="ll-settings-row ll-eng-vec">
                    <label>벡터 쿼리 범위</label>
                    <input class="ll-settings-input" id="ll_s_vector_scandepth" type="number" min="1" max="50" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">최근 N개 — 좁을수록 "지금 장면" 집중 (채팅 깊이 이하)</span>
                </div>

                <!-- 주입량 (fast 엔진) -->
                <div class="ll-settings-row ll-eng-fast">
                    <label>주입 상한 (maxK)</label>
                    <input class="ll-settings-input" id="ll_s_vector_maxk" type="number" min="1" max="50" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">최대 주입 개수 — "다 들어오는" 걸 막는 주 손잡이</span>
                </div>
                <div class="ll-settings-row ll-eng-fast">
                    <label>상대 컷오프 비율</label>
                    <input class="ll-settings-input" id="ll_s_vector_ratio" type="number" min="0" max="1" step="0.05" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">0 = 끔(권장). 올리면 1등 대비 낮은 꼬리 컷</span>
                </div>
                <div class="ll-settings-row ll-eng-vec">
                    <label>유사도 하한 (threshold)</label>
                    <input class="ll-settings-input" id="ll_s_vector_threshold" type="number" min="0" max="1" step="0.05" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">관련도 바닥선. 0=끔. 콘솔 <code>vector N@값</code>으로 조절</span>
                </div>
                <div class="ll-settings-row ll-eng-hybrid">
                    <label>RRF 가중치</label>
                    <input class="ll-settings-input" id="ll_s_hybrid_wv" type="number" min="0" max="5" step="0.1" style="max-width:70px;" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">벡터(의미)</span>
                    <input class="ll-settings-input" id="ll_s_hybrid_wb" type="number" min="0" max="5" step="0.1" style="max-width:70px;" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">BM25(단어)</span>
                </div>

                <!-- AI 엔진 전용 -->
                <div class="ll-settings-row ll-eng-ai">
                    <label>AI 선택 결과 (top K)</label>
                    <input class="ll-settings-input" id="ll_s_ai_select_k" type="number" min="1" max="30" />
                </div>
                <div class="ll-settings-row ll-eng-ai">
                    <label>AI 선택 timeout (초)</label>
                    <input class="ll-settings-input" id="ll_s_timeout_sec" type="number" min="5" max="600" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">기본 120 — 넘으면 폴백</span>
                </div>
                <div class="ll-settings-row ll-eng-ai">
                    <label class="checkbox_label" style="flex:1;">
                        <input id="ll_s_bm25_prefilter_enabled" type="checkbox" />
                        <span>BM25 prefilter <span style="font-size:10px;opacity:0.6;">(권장 ON — vector 의존성 0)</span></span>
                    </label>
                </div>
                <div class="ll-settings-row">
                    <label>BM25 prefilter Top-K</label>
                    <input class="ll-settings-input" id="ll_s_bm25_prefilter_k" type="number" min="5" max="500" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">BM25 후보 풀 크기</span>
                </div>

                <!-- 벡터 인덱스 (벡터 엔진) -->
                <div class="ll-settings-row ll-eng-vec" style="flex-direction:column;align-items:stretch;gap:6px;">
                    <div style="font-size:11px;opacity:0.7;line-height:1.4;">
                        <i class="fa-solid fa-bolt" style="color:#60a5fa;"></i> <b>벡터 인덱스.</b>
                        임베딩 소스는 ST <b>Vector Storage</b> 설정을 따라갑니다. 소스/모델을 바꿨거나 엔트리를 많이 고쳤으면 <b>재색인</b>.
                    </div>
                    <div id="ll_s_vector_source" style="font-size:11px;opacity:0.8;"></div>
                    <button class="menu_button" id="ll_s_reindex_btn" style="width:unset;white-space:nowrap;">
                        <i class="fa-solid fa-database"></i> 벡터 재색인 (managed 전체)
                    </button>
                    <div id="ll_s_reindex_status" style="font-size:11px;opacity:0.7;"></div>
                </div>

                <div class="ll-settings-row">
                    <label class="checkbox_label" style="flex:1;">
                        <input id="ll_s_cache_enabled" type="checkbox" />
                        <span>선택 결과 캐싱 (스와이프/리젠 비용 0)</span>
                    </label>
                </div>
                <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;gap:4px;opacity:0.6;">
                    <div style="font-size:11px;line-height:1.4;">
                        <i class="fa-solid fa-circle-info" style="color:#fbbf24;"></i>
                        <b>주입 위치/깊이는 entry별 옵션 + ST 프리셋의 World Info 슬롯을 따름.</b>
                        LL은 entry를 ST WI에 강제 활성화만 함. 위치는 ST 월드 인포 에디터에서 entry의 position/depth로 수정.
                    </div>
                </div>
            </div>

            <div class="ll-settings-section-title ll-collapsible collapsed" data-toggle="ll_s_prompts">
                <i class="fa-solid fa-pen-fancy"></i> 프롬프트 커스터마이즈
                <i class="fa-solid fa-chevron-down ll-collapse-chevron" style="margin-left:auto;"></i>
            </div>
            <div class="ll-settings-group collapsed" id="ll_s_prompts">
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
