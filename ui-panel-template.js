import { lt } from './i18n.js';
/**
 * UI — 패널 HTML 템플릿.
 * createPanel()이 innerHTML로 넣는 마크업 원본. 순수 문자열(로직 없음)이라
 * index.js의 덩치를 줄이려고 분리. 구조를 바꿀 땐 bindPanelEvents/bindSettingsInputs의
 * 셀렉터(id/class)와 짝이 맞는지 확인할 것.
 */

export const PANEL_HTML = lt('ll.de3167c9f6f361c6')`
        <!-- Header -->
        <div class="ll-panel-header">
            <div class="ll-panel-title">
                <i class="fa-solid fa-brain"></i>
                Living Lorebook
            </div>
            <button class="ll-panel-close ll-btn-settings" title="Settings">
                <i class="fa-solid fa-gear"></i>
            </button>
            <button class="ll-panel-close ll-btn-close" title="Close">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>

        <!-- Toolbar -->
        <div class="ll-toolbar ll-main-toolbar">
            <button class="ll-toolbar-btn organize" data-action="organize">
                <i class="fa-solid fa-broom"></i> Organize Memories
            </button>
            <button class="ll-toolbar-btn add-entry" data-action="add-entry">
                <i class="fa-solid fa-plus"></i> New Entry
            </button>
            <button class="ll-toolbar-btn arc" data-action="arc">
                <i class="fa-solid fa-book-bookmark"></i> Story Arc
            </button>
            <details class="ll-more-actions">
                <summary title="More" aria-label="More actions"><i class="fa-solid fa-ellipsis"></i><span>More</span></summary>
                <div class="ll-more-list">
                    <button class="ll-toolbar-btn" data-action="undo-memory" title="Restore the last memory organization. Chat hiding and automatic arc updates are not included."><i class="fa-solid fa-rotate-left"></i> Undo Last Organization</button>
                    <div class="ll-more-divider"></div>
                    <button class="ll-toolbar-btn build" data-action="build"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate World</button>
                    <button class="ll-toolbar-btn reorganize" data-action="reorganize"><i class="fa-solid fa-arrows-rotate"></i> Reorganize</button>
                    <button class="ll-toolbar-btn compress" data-action="compress"><i class="fa-solid fa-layer-group"></i> Compress Memories</button>
                </div>
            </details>
        </div>

        <!-- World description input (hidden by default) -->
        <div class="ll-world-input-row">
            <input class="ll-world-input" type="text" placeholder="(Optional) Extra setting: a city apartment, a nearby café..." />
            <button class="ll-toolbar-btn build" data-action="build-confirm">
                <i class="fa-solid fa-check"></i> Create
            </button>
            <button class="ll-toolbar-btn" data-action="build-cancel">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>

        <!-- Filter bar -->
        <div class="ll-filter-bar">
            <button class="ll-filter-chip active" data-filter="all">All</button>
            <button class="ll-filter-chip" data-filter="arc"><i class="fa-solid fa-book-bookmark" style="margin-right:3px;font-size:10px;"></i>Story Arc</button>
            <button class="ll-filter-chip" data-filter="character"><i class="fa-solid fa-user" style="margin-right:3px;font-size:10px;"></i>Characters</button>
            <button class="ll-filter-chip" data-filter="relationship"><i class="fa-solid fa-heart" style="margin-right:3px;font-size:10px;"></i>Relationships</button>
            <button class="ll-filter-chip" data-filter="location"><i class="fa-solid fa-location-dot" style="margin-right:3px;font-size:10px;"></i>Locations</button>
            <button class="ll-filter-chip" data-filter="event"><i class="fa-solid fa-bolt" style="margin-right:3px;font-size:10px;"></i>Events</button>
            <button class="ll-filter-chip" data-filter="routine"><i class="fa-solid fa-clock" style="margin-right:3px;font-size:10px;"></i>Routines</button>
            <button class="ll-filter-chip" data-filter="item"><i class="fa-solid fa-gem" style="margin-right:3px;font-size:10px;"></i>Items</button>
            <button class="ll-filter-chip" data-filter="fact"><i class="fa-solid fa-circle-info" style="margin-right:3px;font-size:10px;"></i>Facts</button>
        </div>

        <!-- Timeline (main view) -->
        <div class="ll-timeline" id="ll_timeline"></div>

        <!-- Settings view (hidden by default) -->
        <div class="ll-settings-view" id="ll_settings_view">
            <div class="ll-settings-section-title">Memory Token Budget</div>
            <div class="ll-settings-row"><label>LL token cap (0 = no extra cap)</label><input class="ll-settings-input" id="ll_s_memory_budget" type="number" min="0" step="100" /></div>
            <p class="ll-memory-guide">Direct names prioritize characters, current relationships, and unresolved commitments. Semantic and lexical retrieval work without summaries.</p>
            <div class="ll-settings-section-title">
                <i class="fa-solid fa-map-pin"></i> Entry Insertion Position
            </div>
            <div class="ll-settings-row">
                <label>Position</label>
                <select class="ll-settings-input" id="ll_s_position">
                    <option value="0">↑Char (before character definition)</option>
                    <option value="1">↓Char (after character definition)</option>
                    <option value="2">↑EM (before example messages)</option>
                    <option value="3">↓EM (after example messages)</option>
                    <option value="5">↑AN (before author's note)</option>
                    <option value="6">↓AN (after author's note)</option>
                </select>
            </div>

            <div class="ll-settings-section-title">
                <i class="fa-solid fa-broom"></i> Organize Memories
            </div>
            <label class="checkbox_label"><input type="checkbox" id="ll_s_review_memories" />Review changes and sources before applying</label>
            <label class="checkbox_label">
                <input id="ll_s_auto_arc_organize" type="checkbox" />
                <span>Automatically create / update the story arc <span style="font-size:10px;opacity:0.6;">(from the first organization · before hiding)</span></span>
            </label>
            <div class="ll-settings-row">
                <label>Automatically hide processed messages</label>
                <input class="ll-settings-input" id="ll_s_hide_after" type="checkbox" style="width:auto;" />
            </div>
            <div class="ll-settings-row">
                <label>Keep the latest N messages visible</label>
                <input class="ll-settings-input" id="ll_s_hide_depth" type="number" min="0" max="1000" />
                <span class="ll-settings-unit" style="font-size:11px;opacity:0.6;">0 = hide all processed messages</span>
            </div>

            <div class="ll-settings-section-title">
                <i class="fa-solid fa-arrows-rotate"></i> Original Entries After Reorganization
            </div>
            <div class="ll-settings-row">
                <label>Handling</label>
                <select class="ll-settings-input" id="ll_s_reorg_handling">
                    <option value="hide">Hide (disable; recoverable)</option>
                    <option value="delete">Delete (permanent)</option>
                </select>
            </div>
            <div class="ll-settings-row">
                <label>Batch size</label>
                <input class="ll-settings-input" id="ll_s_reorg_batch" type="number" min="3" max="40" />
                <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">Entries per AI call. Smaller batches reduce loss risk but require more calls (suggested: 10–15).</span>
            </div>

            <div class="ll-settings-section-title">
                <i class="fa-solid fa-layer-group"></i> Compress Memories
            </div>
            <div class="ll-settings-row">
                <label>Tier 2 length retained</label>
                <input class="ll-settings-input" id="ll_s_tier2" type="number" min="10" max="90" />
                <span class="ll-settings-unit">%</span>
            </div>
            <div class="ll-settings-row">
                <label>Tier 3 length retained</label>
                <input class="ll-settings-input" id="ll_s_tier3" type="number" min="5" max="50" />
                <span class="ll-settings-unit">%</span>
            </div>

            <div class="ll-settings-section-title">
                <i class="fa-solid fa-magnifying-glass-arrow-right"></i> Summaries (retrieval hints)
            </div>
            <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;gap:6px;">
                <div style="font-size:11px;opacity:0.7;line-height:1.4;">
                    Each entry stores a "when to select" hint.
                    Use the button below to generate hints for existing entries.
                </div>
                <button class="menu_button" id="ll_s_backfill_btn" style="width:unset;white-space:nowrap;">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> Generate Missing Summaries
                </button>
                <div id="ll_s_backfill_status" style="font-size:11px;opacity:0.7;"></div>
            </div>

            <div class="ll-settings-section-title">
                <i class="fa-solid fa-link"></i> Automatic Follow-up Tasks
            </div>
            <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;gap:4px;">
                <div style="font-size:11px;opacity:0.7;line-height:1.4;margin-bottom:4px;">
                    Run additional tasks after organization / reorganization. These make additional AI calls.
                </div>
                <label class="checkbox_label">
                    <input id="ll_s_auto_backfill_organize" type="checkbox" />
                    <span>Backfill summaries after organization <span style="font-size:10px;opacity:0.6;">(managed mode only; new entries)</span></span>
                </label>
                <label class="checkbox_label">
                    <input id="ll_s_auto_arc_reorganize" type="checkbox" />
                    <span>Update the story arc after reorganization <span style="font-size:10px;opacity:0.6;">(only when an arc already exists)</span></span>
                </label>
            </div>

            <div class="ll-settings-section-title">
                <i class="fa-solid fa-microscope"></i> Memory Selection
            </div>
            <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;gap:6px;">
                <div style="font-size:11px;opacity:0.7;line-height:1.4;">
                    Select relevant memories before generation using names, meaning, and words. AI mode also uses summaries.
                    Register lorebooks under <b>Selection Sources</b>below, then use <b>Enable managed mode</b>on each book to disable native activation and avoid duplicate injection.
                </div>
            </div>

            <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;gap:8px;">
                <div style="font-weight:bold;font-size:12px;">
                    <i class="fa-solid fa-star" style="color:#fbbf24;"></i> Target Lorebook (write destination)
                </div>
                <div style="display:flex;gap:6px;align-items:center;">
                    <select class="ll-settings-input" id="ll_s_target_lorebook" style="flex:1;">
                        <option value="">(None selected)</option>
                    </select>
                    <button class="menu_button" id="ll_s_target_lorebook_clear" title="Disconnect" style="width:unset;padding:4px 8px;">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div style="font-size:10px;opacity:0.6;line-height:1.3;">
                    Organization, compression, and arcs write to this lorebook. It is always included as a source.
                </div>
            </div>

            <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;gap:8px;">
                <div style="font-weight:bold;font-size:12px;">
                    <i class="fa-solid fa-layer-group"></i> Additional Lorebooks (read sources)
                </div>
                <div style="display:flex;gap:6px;align-items:center;">
                    <select class="ll-settings-input" id="ll_s_add_lorebook" style="flex:1;">
                        <option value="">+ Select a lorebook to add...</option>
                    </select>
                    <button class="menu_button" id="ll_s_add_lorebook_btn" style="width:unset;white-space:nowrap;padding:4px 10px;">
                        <i class="fa-solid fa-plus"></i> Add
                    </button>
                </div>
                <div id="ll_s_lorebook_list" style="display:flex;flex-direction:column;gap:6px;"></div>
            </div>
            <div class="ll-settings-row">
                <label class="checkbox_label" style="flex:1;">
                    <input id="ll_s_selection_enabled" type="checkbox" />
                    <span>Enable LL selection <span style="font-size:10px;opacity:0.6;">(LL controls managed entries; native keyword triggers are disabled)</span></span>
                </label>
            </div>
            <div class="ll-settings-row">
                <label>Selection engine</label>
                <select class="ll-settings-input" id="ll_s_selection_engine" style="width:unset;flex:1;text-align:left;">
                    <option value="hybrid">Hybrid (words + meaning) — recommended</option>
                    <option value="bm25">Lexical matching (no embeddings)</option>
                    <option value="ai">AI selection (slower)</option>
                </select>
            </div>
            <!-- Native ST injection warning -->
            <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;">
                <div id="ll_s_conflict_warn" style="font-size:11px;line-height:1.4;"></div>
            </div>

            <!-- Advanced settings by engine -->
            <div class="ll-settings-section-title ll-collapsible collapsed" data-toggle="ll_s_adv_tuning">
                <i class="fa-solid fa-sliders"></i> Advanced Settings
                <span style="font-size:10px;opacity:0.5;font-weight:400;margin-left:auto;">Engine: <span id="ll_s_engine_label">Hybrid</span></span>
                <i class="fa-solid fa-chevron-down ll-collapse-chevron"></i>
            </div>
            <div class="ll-settings-group collapsed" id="ll_s_adv_tuning">
                <!-- Scan range -->
                <div class="ll-settings-row">
                    <label>Conversation scan depth</label>
                    <input class="ll-settings-input" id="ll_s_scan_depth" type="number" min="1" max="50" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">Latest N messages — all engines</span>
                </div>
                <div class="ll-settings-row ll-eng-vec">
                    <label>Vector query window</label>
                    <input class="ll-settings-input" id="ll_s_vector_scandepth" type="number" min="1" max="50" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">Latest N messages — narrower windows focus on the "current scene" (cannot exceed scan depth)</span>
                </div>

                <!-- Fast engine selection limit -->
                <div class="ll-settings-row ll-eng-fast">
                    <label>Selection limit (maxK)</label>
                    <input class="ll-settings-input" id="ll_s_vector_maxk" type="number" min="1" max="50" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">Maximum selected entries — limits "excessive retrieval" per turn</span>
                </div>
                <div class="ll-settings-row ll-eng-fast">
                    <label>Direct keyword matching</label>
                    <input class="ll-settings-input" id="ll_s_keyword_match" type="checkbox" style="width:auto;" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">Prioritize named characters and current relationships; event keywords supplement retrieval.</span>
                </div>
                <div class="ll-settings-row ll-eng-fast">
                    <label>Lexical-only result floor</label>
                    <input class="ll-settings-input" id="ll_s_vector_ratio" type="number" min="0" max="1" step="0.05" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">Ratio of the top lexical score. Used in lexical mode or vector fallback; the higher lexical floor applies. Direct name matches are handled separately.</span>
                </div>
                <div class="ll-settings-row ll-eng-fast">
                    <label>BM25 score floor</label>
                    <input class="ll-settings-input" id="ll_s_bm25_floor" type="number" min="0" max="1" step="0.05" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">Exclude results below this fraction of the top score. Raise to reduce unrelated matches (0 = off).</span>
                </div>
                <div class="ll-settings-row ll-eng-vec">
                    <label>Similarity threshold</label>
                    <input class="ll-settings-input" id="ll_s_vector_threshold" type="number" min="0" max="1" step="0.05" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">Minimum relevance. 0 = off. Inspect <code>vector N@threshold</code>in the console to tune.</span>
                </div>
                <div class="ll-settings-row ll-eng-hybrid">
                    <label>RRF weights</label>
                    <input class="ll-settings-input" id="ll_s_hybrid_wv" type="number" min="0" max="5" step="0.1" style="max-width:70px;" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">Vector (meaning)</span>
                    <input class="ll-settings-input" id="ll_s_hybrid_wb" type="number" min="0" max="5" step="0.1" style="max-width:70px;" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">BM25 (words)</span>
                </div>

                <!-- AI engine only -->
                <div class="ll-settings-row ll-eng-ai">
                    <label>AI selection count (top K)</label>
                    <input class="ll-settings-input" id="ll_s_ai_select_k" type="number" min="1" max="30" />
                </div>
                <div class="ll-settings-row ll-eng-ai">
                    <label>AI selection timeout (seconds)</label>
                    <input class="ll-settings-input" id="ll_s_timeout_sec" type="number" min="5" max="600" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">Default: 120 — use fallback after timeout</span>
                </div>
                <div class="ll-settings-row ll-eng-ai">
                    <label class="checkbox_label" style="flex:1;">
                        <input id="ll_s_bm25_prefilter_enabled" type="checkbox" />
                        <span>BM25 prefilter <span style="font-size:10px;opacity:0.6;">(recommended on; no vector dependency)</span></span>
                    </label>
                </div>
                <div class="ll-settings-row">
                    <label>BM25 prefilter Top-K</label>
                    <input class="ll-settings-input" id="ll_s_bm25_prefilter_k" type="number" min="5" max="500" />
                    <span class="ll-settings-unit" style="font-size:10px;opacity:0.6;">BM25 candidate pool size</span>
                </div>

                <!-- Vector index -->
                <div class="ll-settings-row ll-eng-vec" style="flex-direction:column;align-items:stretch;gap:6px;">
                    <div style="font-size:11px;opacity:0.7;line-height:1.4;">
                        <i class="fa-solid fa-bolt" style="color:#60a5fa;"></i> <b>Vector index.</b>
                        Embeddings follow ST's <b>Vector Storage</b> settings. After changing the source/model or many entries, use <b>Reindex</b>.
                    </div>
                    <div id="ll_s_vector_source" style="font-size:11px;opacity:0.8;"></div>
                    <button class="menu_button" id="ll_s_reindex_btn" style="width:unset;white-space:nowrap;">
                        <i class="fa-solid fa-database"></i> Reindex All Managed Lorebooks
                    </button>
                    <div id="ll_s_reindex_status" style="font-size:11px;opacity:0.7;"></div>
                </div>

                <div class="ll-settings-row">
                    <label class="checkbox_label" style="flex:1;">
                        <input id="ll_s_cache_enabled" type="checkbox" />
                        <span>Cache selections for swipes / regeneration</span>
                    </label>
                </div>
                <div class="ll-settings-row" style="flex-direction:column;align-items:stretch;gap:4px;opacity:0.6;">
                    <div style="font-size:11px;line-height:1.4;">
                        <i class="fa-solid fa-circle-info" style="color:#fbbf24;"></i>
                        <b>Insertion position/depth follows entry settings and the ST preset's World Info slots.</b>
                        LL activates entries in World Info. Change entry position/depth in the ST World Info editor.
                    </div>
                </div>
            </div>

            <div class="ll-settings-section-title ll-collapsible collapsed" data-toggle="ll_s_prompts">
                <i class="fa-solid fa-pen-fancy"></i> Customize Prompts
                <i class="fa-solid fa-chevron-down ll-collapse-chevron" style="margin-left:auto;"></i>
            </div>
            <div class="ll-settings-group collapsed" id="ll_s_prompts">
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <label style="font-size:12px;">World generation prompt</label>
                    <textarea class="ll-settings-textarea" id="ll_s_world_prompt" rows="3"></textarea>
                    <button class="ll-settings-reset-btn" data-reset="worldBuildPrompt"><i class="fa-solid fa-rotate-left"></i> Reset</button>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <label style="font-size:12px;">Organization prompt</label>
                    <textarea class="ll-settings-textarea" id="ll_s_organize_prompt" rows="3"></textarea>
                    <button class="ll-settings-reset-btn" data-reset="organizePrompt"><i class="fa-solid fa-rotate-left"></i> Reset</button>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <label style="font-size:12px;">Compression prompt</label>
                    <textarea class="ll-settings-textarea" id="ll_s_compress_prompt" rows="3"></textarea>
                    <button class="ll-settings-reset-btn" data-reset="compressPrompt"><i class="fa-solid fa-rotate-left"></i> Reset</button>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <label style="font-size:12px;">Summary backfill prompt</label>
                    <textarea class="ll-settings-textarea" id="ll_s_summary_backfill_prompt" rows="3"></textarea>
                    <button class="ll-settings-reset-btn" data-reset="summaryBackfillPrompt"><i class="fa-solid fa-rotate-left"></i> Reset</button>
                </div>
            </div>
        </div>

        <!-- Status Bar -->
        <div class="ll-status-bar">
            <div class="ll-status-item" id="ll_stat_entries_box">
                <span class="ll-status-value" id="ll_stat_entries">0</span><span class="ll-status-label">entries</span>
            </div>
            <div class="ll-status-item ll-stat-storage" id="ll_stat_storage_box" title="Stored tokens across active source entries — click for a per-book breakdown">
                <span class="ll-status-label">Stored</span>
                <span class="ll-status-value" id="ll_stat_storage">0</span>
            </div>
            <div class="ll-status-item ll-stat-inject" id="ll_stat_inject_box" title="Selected memory tokens — click for selection reasons and WI activation results">
                <span class="ll-status-label">Selected</span>
                <span class="ll-status-value" id="ll_stat_inject">—</span>
                <span class="ll-stat-ratio" id="ll_stat_ratio"></span>
            </div>
            <div class="ll-status-item">
                <span class="ll-status-label">Unprocessed</span> <span class="ll-status-value" id="ll_stat_unprocessed">0</span>
            </div>
            <div class="ll-status-spacer"></div>
            <button class="ll-status-btn ll-btn-refresh" title="Refresh">
                <i class="fa-solid fa-rotate"></i>
            </button>
        </div>
`;
