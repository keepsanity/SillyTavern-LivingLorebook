import { l } from './i18n.js';
import { getSettings, loadAnyLorebook, getMetadata, stageMetadata, createEntry, updateEntryContent,
    saveLorebook, operationContext, isOperationCurrent, saveSettings } from './lore-store.js';
import { callLLM } from './llm-service.js';
import { name1, name2, chat_metadata, saveMetadata } from '../../../../script.js';
import { MEMORY_POLICY, ORGANIZE_SCHEMA, continuityThreads, validateProposal } from './memory-policy.js';
import { buildBM25 } from './bm25.js';
import { updateHistory } from './history-storage.js';

const running = new Set();
const messageSignature = m => JSON.stringify([m?.is_user, m?.name, m?.mes]);

export async function organizeMemories(chat, characterContext = '', options = {}) {
    const op = operationContext();
    if (!op.book) throw new Error(l('ll.1c7e28934a4ba644', "Select a target lorebook first."));
    if (running.has(op.book)) throw new Error(l('ll.b7a99b0fd2236d64', "Memory organization is already running for this lorebook."));
    running.add(op.book);
    try {
        const settings = structuredClone(getSettings());
        const data = await loadAnyLorebook(op.book);
        if (!data) throw new Error(l('ll.06f205d172716625', "Could not load the lorebook."));
        const start = Math.max(0, options.rangeStart ?? 0);
        const end = Math.min(chat.length - 1, options.rangeEnd ?? chat.length - 1);
        const indices = [];
        const messages = [];
        const signatures = {};
        for (let i = start; i <= end; i++) {
            if (!chat[i] || chat[i].is_system || chat[i].is_hidden) continue;
            indices.push(i);
            signatures[i] = messageSignature(chat[i]);
            messages.push(`[message:${i}] ${chat[i].name || (chat[i].is_user ? 'User' : 'Character')}: ${chat[i].mes}`);
        }
        if (!indices.length) return { added: 0, updated: 0, deactivated: 0, processedIndices: [], operation: op };
        const metadata = {};
        const entryLines = [];
        const staticCandidates = Object.entries(data.entries || {}).filter(([uid, e]) => !e.disable && !getMetadata(uid, op.book)?.live && getMetadata(uid, op.book)?.category !== 'direction')
            .map(([uid, e]) => ({ uid, title: e.comment, content: e.content }));
        const nearby = new Set(buildBM25(staticCandidates, { textOf: e => `${e.title} ${e.content}` })
            .search(messages.join('\n'), 24).map(r => r.entry.uid));
        for (const [uid, e] of Object.entries(data.entries || {})) {
            metadata[uid] = structuredClone(getMetadata(uid, op.book) || {});
            // 연출 노트는 앞으로의 계획이라 기억 정리에 섞지 않는다
            if (e.disable || metadata[uid].category === 'direction') continue;
            // Read full LIVE state and relevant static memories; retain all other titles as an index.
            const full = metadata[uid].live || nearby.has(uid);
            const meta = metadata[uid];
            const identity = JSON.stringify({ category: meta.category || 'fact', aliases: meta.aliases || [],
                openLoop: !!meta.openLoop, lastEvidence: meta.lastEvidence ? { chatId: meta.lastEvidence.chatId, index: meta.lastEvidence.index } : null });
            entryLines.push(`[uid:${uid}] ${meta.live ? 'UPDATABLE' : 'READ ONLY'} ${e.comment}\nMetadata: ${identity}\n${full ? e.content : '(title index only; do not infer its details)'}`);
        }
        const prompt = settings.organizePrompt.replace('{{currentEntries}}', entryLines.join('\n\n'))
            .replace('{{conversation}}', messages.join('\n\n'));
        const charName = name2 || 'Character';
        const userName = name1 || 'User';
        const mentions = (text, name) => String(text || '').toLowerCase().includes(String(name).toLowerCase());
        // The pair's LIVE relationship entry, if one already exists, is updated rather than re-added.
        const pairUid = Object.entries(data.entries || {}).find(([uid, e]) => !e.disable && metadata[uid]?.live
            && metadata[uid]?.category === 'relationship' && mentions(e.comment, charName) && mentions(e.comment, userName))?.[0] ?? null;
        const systemPrompt = `${MEMORY_POLICY}\n${ORGANIZE_SCHEMA}\n${continuityThreads(charName, userName, pairUid)}\nCharacter/persona already supplied to RP:\n${characterContext}`;
        let proposal;
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!isOperationCurrent(op) || indices.some(i => messageSignature(chat[i]) !== signatures[i])) {
                throw new Error(l('ll.05359fcc3600ab28', 'The chat or target lorebook changed. Applying changes was cancelled.'));
            }
            const raw = await callLLM(systemPrompt, prompt + (attempt ? '\n\nThe previous response could not be parsed. Return exactly ONE complete JSON object with add, update, deactivate arrays. No explanation or markdown. Escape quotes and newlines within strings. Preserve the requested facts; do not return an incomplete object.' : ''),
                settings.organizeMaxTokens, settings);
            try { proposal = validateProposal(raw, data, metadata, indices); break; }
            catch (error) {
                if (error.code !== 'LL_INVALID_JSON' || attempt) throw error;
                globalThis.toastr?.info?.(l('ll.organize.retryJSON', 'The AI returned unreadable JSON. Retrying once automatically.'));
            }
        }
        for (const change of proposal.changes) {
            if (change.type !== 'update') continue;
            const previous = metadata[String(change.uid)].lastEvidence;
            // A branch shares its parent's history: the same source message at the same index proves it.
            const sharedHistory = previous?.signature && messageSignature(chat[previous.index]) === previous.signature;
            if (previous && previous.chatId !== op.chatId && !sharedHistory) {
                throw new Error(l('ll.7f7ef01274c0e0de', "This LIVE memory was updated in another chat. Use separate lorebooks for branches or review it manually."));
            }
            if (previous && Math.max(...change.sourceMessages) < previous.index) {
                throw new Error(l('ll.6b4058edeadcbede', "Older messages cannot rewind the latest LIVE state. Add a historical event or edit manually."));
            }
            if (previous?.signature && messageSignature(chat[previous.index]) !== previous.signature) {
                throw new Error(l('ll.28230dd0160b0468', "The previous source conversation for this LIVE memory was edited. Review its state manually."));
            }
        }
        const assertCurrent = () => {
            if (!isOperationCurrent(op)) throw new Error(l('ll.05359fcc3600ab28', "The chat or target lorebook changed. Applying changes was cancelled."));
            const changed = indices.filter(i => messageSignature(chat[i]) !== signatures[i]);
            if (changed.length) {
                const diag = { at: new Date().toISOString(), chatLength: chat.length, changed: changed.map(i => ({ i, before: signatures[i], after: messageSignature(chat[i]) })) };
                console.warn('[LivingLorebook] changed during analysis:', diag);
                try { chat_metadata.ll_last_error = diag; saveMetadata(); } catch (e) { console.warn('[LivingLorebook] could not save diag', e); }
                throw new Error(l('ll.923264e0c75da77a', "The conversation changed during analysis. Applying changes was cancelled.") + ` [#${changed.slice(0, 8).join(', #')}${changed.length > 8 ? '…' : ''} / ${chat.length}]`);
            }
            for (const change of proposal.changes.filter(c => c.type === 'update')) {
                if (JSON.stringify(getMetadata(change.uid, op.book) || {}) !== JSON.stringify(metadata[change.uid])) {
                    throw new Error(l('ll.1f9c24cea7ee95c6', "LIVE settings or memory metadata changed during analysis. Organize again."));
                }
            }
        };
        assertCurrent();
        if (settings.reviewMemories !== false) {
            if (typeof options.review !== 'function') throw new Error(l('ll.2fc378cb2604eeec', "Run memory organization through the review interface."));
            const sources = Object.fromEntries(indices.map(i => [i, chat[i].mes]));
            const accepted = await options.review({ ...proposal, data, metadata, operation: op, indices, sources });
            if (!accepted) return { cancelled: true, added: 0, updated: 0, deactivated: 0, processedIndices: [], operation: op };
        }
        assertCurrent();
        const journal = { at: Date.now(), book: op.book, chatId: op.chatId, changes: [] };
        let added = 0;
        let updated = 0;
        for (const change of proposal.changes) {
            let uid;
            let before = null;
            let beforeMeta = null;
            if (change.type === 'add') {
                const entry = await createEntry(op.book, data, change);
                if (!entry) throw new Error(l('ll.fc1065f3fa7265d7', "Entry creation failed."));
                uid = String(entry.uid);
                added++;
            } else {
                uid = String(change.uid);
                before = structuredClone(data.entries[uid]);
                beforeMeta = metadata[uid];
                updateEntryContent(data, uid, change.newContent, op.book);
                updated++;
            }
            const patch = {
                sourceMessages: change.sourceMessages, sourceChatId: op.chatId,
                lastEvidence: { chatId: op.chatId, index: Math.max(...change.sourceMessages), signature: signatures[Math.max(...change.sourceMessages)] },
                lastUpdated: Date.now(),
            };
            if (change.type === 'add') patch.live = change.live;
            if (change.aliases !== undefined) patch.aliases = change.aliases;
            if (change.openLoop !== undefined) patch.openLoop = change.openLoop;
            if (typeof change.summary === 'string') patch.summary = change.summary;
            stageMetadata(data, uid, patch, op.book);
            journal.changes.push({ uid, before, beforeMeta, after: JSON.stringify(data.entries[uid]) });
        }
        assertCurrent();
        if (proposal.changes.length) await saveLorebook(op.book, data);
        for (const change of journal.changes) {
            change.after = JSON.stringify(data.entries[change.uid]);
            change.afterMeta = JSON.stringify(getMetadata(change.uid, op.book));
        }
        const current = getSettings();
        if (journal.changes.length) {
            // Bounded operation history. Each operation preserves all its affected entries.
            try { await updateHistory(entries => [...entries, journal]); }
            catch (error) { throw new Error(l('ll.storage.historyFailed', 'Memories were saved, but undo history could not be saved. Source messages were not hidden.') + ' ' + error.message); }
        }
        current.organizeByChat ||= {};
        current.organizeByChat[op.chatId] = { index: end + 1, at: Date.now() };
        saveSettings();
        // Hide only a reviewed, nonempty, warning-free complete operation.
        return { added, updated, deactivated: 0, warnings: proposal.warnings,
            processedRange: [start, end], processedIndices: proposal.changes.length && !proposal.warnings.length ? indices : [],
            operation: op, sourceSignatures: signatures, createdUids: journal.changes.filter(c => !c.before).map(c => c.uid) };
    } finally { running.delete(op.book); }
}
