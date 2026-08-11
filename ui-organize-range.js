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
        onConfirm(options);
    });
}
