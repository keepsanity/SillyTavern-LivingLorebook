import { l, lt } from './i18n.js';
/**
 * UI — 툴바 작업 (세계관 생성 / 기억 정리 / 압축 / 줄거리 / 재구성).
 * 실행 중 상태(isProcessing)를 여기서 소유하고, 버튼 disable/스피너까지 처리한다.
 * 패널 갱신은 ui-shared의 refreshPanel 레지스트리로 (ui-panel과 순환 의존 회피).
 */

import { characters, this_chid } from '../../../../script.js';
import { createNewWorldInfo } from '../../../world-info.js';
import { refreshPanel, getCharacterContext, populateLorebookDropdown } from './ui-shared.js';
import { getSettings, isOperationCurrent } from './lore-store.js';
import { finishOrganize } from './organize-followup.js';
import { reviewMemories } from './ui-review.js';
import { undoLastMemory } from './memory-history.js';
import { clearSelectionCache } from './summary-retrieval.js';
import { organize, compress, generateStoryArc, backfillSummaries } from './memory-manager.js';
import { generateWorld, reorganizeExisting } from './world-builder.js';
import { setChatLorebook } from './chat-meta.js';
import { openSuggestModal } from './ui-suggest.js';
import { openNewEntryModal } from './ui-newentry.js';
import { openOrganizeRangeModal } from './ui-organize-range.js';

const LOG_PREFIX = '[LivingLorebook]';

/** 툴바 작업이 진행 중인지 — 중복 실행 방지 */
let isProcessing = false;

export async function handleToolbarAction(action) {
    if (isProcessing) return;

    switch (action) {
        case 'undo-memory':
            try {
                await undoLastMemory();
                clearSelectionCache();
                await refreshPanel();
                toastr.info(l('ll.aeb0488bb88c21b0', "Last organization undone. Unhide source messages separately in chat if needed."));
            } catch (err) { toastr.warning(err.message); }
            return;
        case 'build':
            // 새 워크플로우: 제안 모달 열기
            openSuggestModal();
            return;

        case 'add-entry':
            openNewEntryModal();
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

export async function handleBuildWorld() {
    const settings = getSettings();
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
            toastr.info(lt('ll.aaee532ee7551ea0')`Lorebook "${newName}" created.`);
        } catch (err) {
            toastr.error(l('ll.74c8a7f620b71703', "Lorebook creation failed."));
            return;
        }
    }

    const charContext = getCharacterContext();
    const extraDesc = document.querySelector('.ll-world-input')?.value?.trim() || '';

    if (!charContext && !extraDesc) {
        toastr.warning(l('ll.c3571d4f1f20c598', "No character card or additional description is available."));
        return;
    }

    const fullDescription = [charContext, extraDesc].filter(Boolean).join('\n\n---\n\n');

    setToolbarProcessing(true, 'build-confirm');

    try {
        const entries = await generateWorld(fullDescription);
        toastr.success(lt('ll.12f2f7ea0eb9e8fc')`${entries.length}entries created.`);
        document.querySelector('.ll-world-input-row')?.classList.remove('active');
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} World generation failed:`, err);
        toastr.error(err.message || l('ll.c787df5732485b9a', "World generation failed."));
    } finally {
        setToolbarProcessing(false);
    }
}

export async function handleOrganize() {
    const settings = getSettings();
    if (!settings.targetLorebook) {
        toastr.warning(l('ll.1c7e28934a4ba644', "Select a target lorebook first."));
        return;
    }

    const chat = SillyTavern.getContext().chat || [];
    if (chat.length === 0) {
        toastr.info(l('ll.f2fab7c8a7a53b55', "No conversation to organize."));
        return;
    }

    // 범위 지정 팝업 띄우기
    openOrganizeRangeModal(chat.length, (options) => runOrganize(options));
}

// ============================================================
// Organize Range Modal
// ============================================================

// 정리 범위 모달은 ui-organize-range.js로 분리됨 (openOrganizeRangeModal import)

async function runOrganize(options = {}) {
    if (isProcessing) return;
    const settings = structuredClone(getSettings());
    const chat = SillyTavern.getContext().chat || [];
    setToolbarProcessing(true, 'organize');

    try {
        const result = await organize(chat, getCharacterContext(), { ...options, review: reviewMemories });
        if (result.cancelled) return;
        clearSelectionCache();
        if (result.warnings?.length) toastr.warning(result.warnings.join(' / '));
        const parts = [];
        if (result.added > 0) parts.push(lt('ll.7e045f2e6ade37e8')`Add ${result.added}`);
        if (result.updated > 0) parts.push(lt('ll.22da3acb51ca5c74')`updated ${result.updated}`);
        if (result.deactivated > 0) parts.push(lt('ll.d25f3fd40b12385f')`disabled ${result.deactivated}`);

        if (parts.length > 0) {
            toastr.success(lt('ll.e84cf142d7283a47')`Organization complete: ${parts.join(', ')}`);
        } else {
            toastr.info(l('ll.b6443eb6b8501dc9', "No changes."));
        }

        // 자동 체인 결과 알림 (backfill / arc)
        const chain = await finishOrganize(result, settings, {
            isCurrent: isOperationCurrent, backfill: backfillSummaries, arc: generateStoryArc,
        });
        if (chain) {
            const chainParts = [];
            if (chain.backfilled > 0) chainParts.push(lt('ll.3f1386211d529a7a')`🔍 summary ${chain.backfilled}backfilled`);
            if (chain.arcCreated) chainParts.push(l('ll.cdb6548d4a689ff9', "📖 First story arc created"));
            else if (chain.arcUpdated) chainParts.push(l('ll.a15c043533dfcffb', "📖 Story arc updated"));
            if (chainParts.length > 0) {
                toastr.info(chainParts.join(' · '), l('ll.d4f5067df750b455', "Automatic Follow-up Tasks"), { timeOut: 4000 });
            }
            if (chain.errors && chain.errors.length > 0) {
                toastr.warning(lt('ll.59b091aedc286f12')`Some follow-up tasks failed: ${chain.errors.join(' / ')}`, 'LivingLorebook', { timeOut: 6000 });
            }
        }

        if (!chain.allowHide && chain.errors.length) {
            toastr.warning(l('ll.1f5f5dbfdaf52673', "The story arc could not be completed, so source messages remain visible. Memories were saved. Retry with Story Arc."), 'LivingLorebook', { timeOut: 8000 });
        }

        // 자동 하이드
        if (chain.allowHide && isOperationCurrent(result.operation) && settings.hideAfterOrganize && Array.isArray(result.processedIndices) && result.processedIndices.length > 0) {
            try {
                const { hideChatMessageRange } = await import('../../../chats.js');
                const assertScope = () => {
                    if (!isOperationCurrent(result.operation)) throw new Error(l('ll.476a1c7a09e0a682', "The chat changed. Message hiding was cancelled."));
                    if (result.processedIndices.some(i => JSON.stringify([chat[i]?.is_user, chat[i]?.name, chat[i]?.mes]) !== result.sourceSignatures[i])) {
                        throw new Error(l('ll.46ebf404ab8d0a7c', "The conversation changed after organization. Message hiding was cancelled."));
                    }
                };
                assertScope();
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
                        assertScope();
                        await hideChatMessageRange(rangeStart, prev, false);
                        rangeStart = targetIndices[i];
                        prev = rangeStart;
                    }
                    assertScope();
                    await hideChatMessageRange(rangeStart, prev, false);
                    toastr.info(lt('ll.747538167139c221')`${targetIndices.length}messages hidden.`);
                }
            } catch (err) {
                console.warn(`${LOG_PREFIX} Auto-hide failed:`, err);
            }
        }

        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Organize failed:`, err);
        toastr.error(err.message || l('ll.039801dcf3a0738b', "Memory organization failed."));
    } finally {
        setToolbarProcessing(false);
    }
}


// 로어북 관리(카드 리스트/managed 전환/백필/dropdown)는 ui-lorebooks.js로 분리됨

export async function handleCompress() {
    const settings = getSettings();
    if (!settings.targetLorebook) {
        toastr.warning(l('ll.1c7e28934a4ba644', "Select a target lorebook first."));
        return;
    }

    setToolbarProcessing(true, 'compress');

    try {
        const result = await compress();
        if (result.compressed > 0) {
            toastr.success(lt('ll.0955fa49e69fb1dc')`${result.compressed}entries compressed.`);
        } else {
            toastr.info(l('ll.1e8ec4c0aa31dc95', "No entries to compress."));
        }
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Compress failed:`, err);
        toastr.error(err.message || l('ll.7a39ab78d2aaec0b', "Compression failed."));
    } finally {
        setToolbarProcessing(false);
    }
}

async function handleGenerateArc() {
    const settings = getSettings();
    if (!settings.targetLorebook) {
        toastr.warning(l('ll.1c7e28934a4ba644', "Select a target lorebook first."));
        return;
    }

    setToolbarProcessing(true, 'arc');

    try {
        const result = await generateStoryArc();
        const verb = result.created ? l('ll.167eff2736c371d0', "Create") : l('ll.9ea9bd59e20c2e51', "updated");
        toastr.success(lt('ll.568ad3c9a00fd6ff')`📖 Story Arc ${verb}(${result.tokens.toLocaleString()} tokens; pinned)`);
        clearSelectionCache();
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Story Arc generation failed:`, err);
        toastr.error(err.message || l('ll.9d318cf2e987ae7d', "Story arc generation failed."));
    } finally {
        setToolbarProcessing(false);
    }
}

async function handleReorganize() {
    const settings = getSettings();
    if (!settings.targetLorebook) {
        toastr.warning(l('ll.1c7e28934a4ba644', "Select a target lorebook first."));
        return;
    }

    setToolbarProcessing(true, 'reorganize');

    // 배치 진행률을 버튼에 표시한다. setToolbarProcessing은 클래스만 건드리므로
    // innerHTML은 여기서 직접 저장/복원해야 라벨이 안 날아간다.
    const btn = document.querySelector('[data-action="reorganize"]');
    const btnHTML = btn?.innerHTML;

    try {
        const result = await reorganizeExisting({
            onProgress: (done, total) => {
                if (btn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${done}/${total}`;
            },
        });
        const kept = Math.round((result.keepRatio ?? 1) * 100);
        toastr.success(
            lt('ll.7ac5e48ee2d1c389')`${result.reorganized}entries after reorganization. `
            + lt('ll.226991c4fae71033')`(batches: ${result.batches}· retained: ${kept}% · original entries: ${result.handling === 'delete' ? l('ll.6139b6c3ed73cd4a', "Delete") : l('ll.afa4bc3d67e162b2', "Hide")})`
            + (result.truncated > 0 ? lt('ll.61a0cb349003dee9')` ⚠ Truncated response in ${result.truncated}batches — reduce the batch size and retry` : ''),
            'LivingLorebook', { timeOut: 8000 },
        );
        if (result.arcUpdated) {
            toastr.info(l('ll.3cd30593651f616b', "📖 Story arc also updated"), l('ll.d4f5067df750b455', "Automatic Follow-up Tasks"), { timeOut: 4000 });
        }
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Reorganize failed:`, err);
        toastr.error(err.message || l('ll.c2e5d9d966837ad9', "Reorganization failed."));
    } finally {
        if (btn && btnHTML !== undefined) btn.innerHTML = btnHTML;
        setToolbarProcessing(false);
    }
}
