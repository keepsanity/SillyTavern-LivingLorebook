import { l } from './i18n.js';
import { getSettings, getMetadata, loadAnyLorebook, saveLorebook, stageMetadata, deleteEntry } from './lore-store.js';
import { setWIOriginalDataValue } from '../../../world-info.js';
import { readHistory, updateHistory } from './history-storage.js';

function comparableEntry(entry) {
    const copy = structuredClone(entry);
    if (copy?.extensions) {
        delete copy.extensions.livingLorebook;
        if (!Object.keys(copy.extensions).length) delete copy.extensions;
    }
    return JSON.stringify(copy);
}

export async function undoLastMemory() {
    const settings = getSettings();
    const book = settings.targetLorebook;
    const journal = [...await readHistory()].reverse().find(j => j.book === book);
    if (!journal) throw new Error(l('ll.a75f96b34e3f9c81', "No organization history to undo for this lorebook."));
    const data = await loadAnyLorebook(book);
    if (!data) throw new Error(l('ll.06f205d172716625', "Could not load the lorebook."));
    for (const c of journal.changes) {
        if (c.afterMeta !== undefined && JSON.stringify(getMetadata(c.uid, book)) !== c.afterMeta) {
            throw new Error(l('ll.0ebb4235c19b15ce', "Entry metadata was edited after organization. Undo stopped to preserve those edits."));
        }
        if (comparableEntry(data.entries[c.uid]) !== comparableEntry(JSON.parse(c.after))) throw new Error(l('ll.8c2076cee8412bb4', "This entry was edited after organization. Undo stopped to preserve those edits."));
    }
    for (const c of journal.changes) {
        if (!c.before) deleteEntry(data, c.uid, book);
        else {
            data.entries[c.uid] = structuredClone(c.before);
            for (const [key, value] of Object.entries(c.before)) setWIOriginalDataValue(data, c.uid, key, value);
            // Replace metadata, including open-loop and evidence values added by the undone operation.
            const now = getMetadata(c.uid, book) || {};
            const cleared = Object.fromEntries(Object.keys(now).map(k => [k, undefined]));
            stageMetadata(data, c.uid, { ...cleared, ...c.beforeMeta }, book);
        }
    }
    await saveLorebook(book, data);
    await updateHistory(entries => entries.filter(j => !(j.at === journal.at && j.book === journal.book && j.chatId === journal.chatId)));
    return journal;
}
