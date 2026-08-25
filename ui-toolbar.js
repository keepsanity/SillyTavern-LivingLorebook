/**
 * UI — 툴바 작업 (세계관 생성 / 기억 정리 / 압축 / 줄거리 / 재구성).
 * 실행 중 상태(isProcessing)를 여기서 소유하고, 버튼 disable/스피너까지 처리한다.
 * 패널 갱신은 ui-shared의 refreshPanel 레지스트리로 (ui-panel과 순환 의존 회피).
 */

import { characters, this_chid } from '../../../../script.js';
import { createNewWorldInfo } from '../../../world-info.js';
import { refreshPanel, getCharacterContext, populateLorebookDropdown } from './ui-shared.js';
import { getSettings } from './lore-store.js';
import { clearSelectionCache } from './summary-retrieval.js';
import { organize, compress, generateStoryArc } from './memory-manager.js';
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

export async function handleOrganize() {
    const settings = getSettings();
    if (!settings.targetLorebook) {
        toastr.warning('대상 로어북을 먼저 선택해주세요.');
        return;
    }

    const chat = SillyTavern.getContext().chat || [];
    if (chat.length === 0) {
        toastr.info('정리할 대화가 없습니다.');
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
    const settings = getSettings();
    const chat = SillyTavern.getContext().chat || [];
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


// 로어북 관리(카드 리스트/managed 전환/백필/dropdown)는 ui-lorebooks.js로 분리됨

export async function handleCompress() {
    const settings = getSettings();
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
    const settings = getSettings();
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
    const settings = getSettings();
    if (!settings.targetLorebook) {
        toastr.warning('대상 로어북을 먼저 선택해주세요.');
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
            `${result.reorganized}개의 엔트리로 재구성되었습니다. `
            + `(배치 ${result.batches}회 · 분량 ${kept}% 유지 · 기존 엔트리는 ${result.handling === 'delete' ? '삭제' : '하이드'})`
            + (result.truncated > 0 ? ` ⚠ 응답 잘림 ${result.truncated}배치 — 배치 크기를 줄여 다시 시도하세요` : ''),
            'LivingLorebook', { timeOut: 8000 },
        );
        if (result.arcUpdated) {
            toastr.info('📖 줄거리도 업데이트됨', '자동 체인', { timeOut: 4000 });
        }
        await refreshPanel();
    } catch (err) {
        console.error(`${LOG_PREFIX} Reorganize failed:`, err);
        toastr.error(err.message || '재구성에 실패했습니다.');
    } finally {
        if (btn && btnHTML !== undefined) btn.innerHTML = btnHTML;
        setToolbarProcessing(false);
    }
}
