/** Review is the commit boundary, not an extra model call. All model text uses textContent. */
export function reviewMemories(proposal) {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog');
        dialog.className = 'll-memory-review';
        const heading = document.createElement('h3');
        heading.textContent = '기억 변경 검토';
        dialog.append(heading);
        const note = document.createElement('p');
        note.textContent = `${proposal.operation.book} · 추가 ${proposal.changes.filter(c => c.type === 'add').length} · 갱신 ${proposal.changes.filter(c => c.type === 'update').length}. 관계 해석과 빠진 사실을 확인해주세요.`;
        dialog.append(note);
        for (const warning of proposal.warnings) {
            const p = document.createElement('p'); p.className = 'll-review-warning'; p.textContent = warning; dialog.append(p);
        }
        const list = document.createElement('div'); list.className = 'll-review-list'; dialog.append(list);
        for (const change of proposal.changes) {
            const section = document.createElement('section');
            const title = document.createElement('h4');
            title.textContent = `${change.type === 'add' ? '추가' : '갱신'} · ${change.title || proposal.data.entries[change.uid]?.comment}`;
            section.append(title);
            if (change.type === 'update') {
                const before = document.createElement('pre');
                before.textContent = `변경 전\n${proposal.data.entries[change.uid].content}`;
                before.className = 'll-review-before'; section.append(before);
            }
            const after = document.createElement('pre');
            after.textContent = `변경 후\n${change.content || change.newContent}`; section.append(after);
            const oldMeta = proposal.metadata?.[change.uid] || {};
            const fields = [];
            if (change.type === 'add') fields.push(`LIVE: ${change.live ? '갱신 허용' : '고정 기록'}`);
            if (change.openLoop !== undefined) fields.push(`미해결 표시: ${change.type === 'update' ? (oldMeta.openLoop ? '열림' : '닫힘') + ' → ' : ''}${change.openLoop ? '열림' : '닫힘'}`);
            if (change.aliases !== undefined) fields.push(`별칭: ${change.type === 'update' ? (oldMeta.aliases || []).join(', ') + ' → ' : ''}${change.aliases.join(', ') || '(없음)'}`);
            if (change.summary !== undefined) fields.push(`검색 요약: ${change.summary}`);
            if (fields.length) {
                const metadata = document.createElement('pre'); metadata.textContent = fields.join('\n'); section.append(metadata);
            }
            const evidence = document.createElement('p');
            evidence.textContent = `근거 메시지: ${change.sourceMessages.join(', ')}${change.reason ? ' · ' + change.reason : ''}`;
            section.append(evidence);
            if (proposal.sources) {
                const details = document.createElement('details');
                const summary = document.createElement('summary'); summary.textContent = '근거 원문 보기'; details.append(summary);
                for (const id of change.sourceMessages) {
                    const source = document.createElement('pre'); source.textContent = `[${id}] ${proposal.sources[id] || ''}`; details.append(source);
                }
                section.append(details);
            }
            list.append(section);
        }
        if (!proposal.changes.length) { const p = document.createElement('p'); p.textContent = '새로 저장할 변경이 없습니다. 원문을 숨기지 않습니다.'; list.append(p); }
        const footer = document.createElement('footer');
        const cancel = document.createElement('button'); cancel.textContent = '취소 · 원문 유지';
        const apply = document.createElement('button'); apply.textContent = '검토 완료 · 적용';
        apply.disabled = !proposal.changes.length;
        footer.append(cancel, apply); dialog.append(footer);
        let done = false;
        const finish = accepted => { if (done) return; done = true; dialog.close(); dialog.remove(); resolve(accepted); };
        cancel.addEventListener('click', () => finish(false));
        apply.addEventListener('click', () => finish(true));
        dialog.addEventListener('cancel', e => { e.preventDefault(); finish(false); });
        document.body.append(dialog); dialog.showModal();
    });
}
