import { l, lt } from './i18n.js';
/**
 * UI — 기억 정리 범위 선택 모달.
 * 전체 정리 vs 메시지 ID 구간 지정. 실제 정리 실행은 호출자가 넘긴 onConfirm 콜백이 담당
 * (index의 runOrganize를 직접 부르지 않아 순환 의존 없음).
 */

/**
 * @param {number} chatLength - 현재 채팅 메시지 수
 * @param {(options: {rangeStart?: number, rangeEnd?: number}) => void} onConfirm
 */
export function openOrganizeRangeModal(chatLength, onConfirm) {
    // 이미 있으면 제거
    document.querySelector('dialog.ll-range-modal')?.remove();

    const modal = document.createElement('dialog');
    modal.className = 'll-range-modal';
    modal.innerHTML = lt('ll.b19ad2f48878119c')`
        <div class="ll-range-header">
            <div class="ll-range-title"><i class="fa-solid fa-broom"></i> Organize Memories</div>
            <button class="ll-range-close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="ll-range-body">
            <div class="ll-range-option">
                <label class="ll-range-radio-label">
                    <input type="radio" name="ll_range_mode" value="all" checked />
                    <span>Entire conversation</span>
                    <small>Analyze all eligible messages in this chat</small>
                </label>
            </div>
            <div class="ll-range-option">
                <label class="ll-range-radio-label">
                    <input type="radio" name="ll_range_mode" value="range" />
                    <span>Choose a range</span>
                    <small>Analyze a range of message IDs (0– ${chatLength - 1})</small>
                </label>
                <div class="ll-range-inputs">
                    <input type="number" id="ll_range_start" min="0" max="${chatLength - 1}" placeholder="Start ID" />
                    <span>~</span>
                    <input type="number" id="ll_range_end" min="0" max="${chatLength - 1}" placeholder="End ID" value="${chatLength - 1}" />
                </div>
            </div>
            <div class="ll-range-hint">
                * Message IDs are the numbers shown in chat, starting at 0.
            </div>
        </div>
        <div class="ll-range-footer">
            <button class="ll-range-btn ll-range-cancel">Cancel</button>
            <button class="ll-range-btn ll-range-confirm">Organize</button>
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
                toastr.warning(l('ll.98e03f213d46805e', "Enter a valid range."));
                return;
            }
            options = { rangeStart: start, rangeEnd: end };
        }
        close();
        onConfirm(options);
    });
}
