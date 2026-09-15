import { l, lt } from './i18n.js';
/** Review is the commit boundary, not an extra model call. All model text uses textContent. */
export function reviewMemories(proposal) {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog');
        dialog.className = 'll-memory-review';
        const heading = document.createElement('h3');
        heading.textContent = l('ll.61c6b52cfb2f0b06', "Review Memory Changes");
        dialog.append(heading);
        const note = document.createElement('p');
        note.textContent = lt('ll.2efb1c402f5612fc')`${proposal.operation.book} · added ${proposal.changes.filter(c => c.type === 'add').length} · updated ${proposal.changes.filter(c => c.type === 'update').length}. Check relationship interpretations and missing facts.`;
        dialog.append(note);
        for (const warning of proposal.warnings) {
            const p = document.createElement('p'); p.className = 'll-review-warning'; p.textContent = warning; dialog.append(p);
        }
        const list = document.createElement('div'); list.className = 'll-review-list'; dialog.append(list);
        for (const change of proposal.changes) {
            const section = document.createElement('section');
            const title = document.createElement('h4');
            title.textContent = `${change.type === 'add' ? l('ll.b73accca8a4a51d3', "Add") : l('ll.ec1c4499c89f577f', "updated")} · ${change.title || proposal.data.entries[change.uid]?.comment}`;
            section.append(title);
            if (change.type === 'update') {
                const before = document.createElement('pre');
                before.textContent = lt('ll.335492966df2006d')`Before\n${proposal.data.entries[change.uid].content}`;
                before.className = 'll-review-before'; section.append(before);
            }
            const after = document.createElement('pre');
            after.textContent = lt('ll.f3b08d20bd672cc9')`After\n${change.content || change.newContent}`; section.append(after);
            const oldMeta = proposal.metadata?.[change.uid] || {};
            const fields = [];
            if (change.type === 'add') fields.push(`LIVE: ${change.live ? l('ll.159ca2f3743cf319', "Updates allowed") : l('ll.3ab3aafc65a920da', "Fixed record")}`);
            if (change.openLoop !== undefined) fields.push(lt('ll.d26dd83bf8f36e14')`Unresolved: ${change.type === 'update' ? (oldMeta.openLoop ? l('ll.486398f327dc16e9', "Open") : l('ll.cae274fd0b78a5a0', "Closed")) + ' → ' : ''}${change.openLoop ? l('ll.486398f327dc16e9', "Open") : l('ll.cae274fd0b78a5a0', "Closed")}`);
            if (change.aliases !== undefined) fields.push(lt('ll.ac9af2dc74c48d4f')`Aliases: ${change.type === 'update' ? (oldMeta.aliases || []).join(', ') + ' → ' : ''}${change.aliases.join(', ') || l('ll.2c5539adbf825ee1', "(None)")}`);
            if (change.summary !== undefined) fields.push(lt('ll.fff9ec7ab24d63e2')`Retrieval summary: ${change.summary}`);
            if (fields.length) {
                const metadata = document.createElement('pre'); metadata.textContent = fields.join('\n'); section.append(metadata);
            }
            const evidence = document.createElement('p');
            evidence.textContent = lt('ll.524baca2011fcac0')`Source messages: ${change.sourceMessages.join(', ')}${change.reason ? ' · ' + change.reason : ''}`;
            section.append(evidence);
            if (proposal.sources) {
                const details = document.createElement('details');
                const summary = document.createElement('summary'); summary.textContent = l('ll.fb9b5641a096e129', "View Source Messages"); details.append(summary);
                for (const id of change.sourceMessages) {
                    const source = document.createElement('pre'); source.textContent = `[${id}] ${proposal.sources[id] || ''}`; details.append(source);
                }
                section.append(details);
            }
            list.append(section);
        }
        if (!proposal.changes.length) { const p = document.createElement('p'); p.textContent = l('ll.433c859ab893fbc2', "No new changes to save. Source messages will remain visible."); list.append(p); }
        const footer = document.createElement('footer');
        const cancel = document.createElement('button'); cancel.textContent = l('ll.6fa2b238c0df209e', "Cancel · Keep Sources");
        const apply = document.createElement('button'); apply.textContent = l('ll.7b1b5a00bb06a505', "Apply Changes");
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
