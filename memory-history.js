import { getSettings, getMetadata, loadAnyLorebook, saveLorebook, stageMetadata, deleteEntry, saveSettings } from './lore-store.js';
import { setWIOriginalDataValue } from '../../../world-info.js';

export async function undoLastMemory() {
    const settings = getSettings();
    const book = settings.targetLorebook;
    const journal = [...(settings.memoryJournal || [])].reverse().find(j => j.book === book);
    if (!journal) throw new Error('이 로어북의 되돌릴 기억 정리 기록이 없습니다.');
    const data = await loadAnyLorebook(book);
    if (!data) throw new Error('로어북을 불러올 수 없습니다.');
    for (const c of journal.changes) {
        if (JSON.stringify(data.entries[c.uid]) !== c.after) throw new Error('정리 이후 엔트리가 편집됐습니다. 덮어쓰지 않고 중단했습니다.');
        if (c.afterMeta !== undefined && JSON.stringify(getMetadata(c.uid, book)) !== c.afterMeta) {
            throw new Error('정리 이후 별칭·LIVE·약속 상태 등 메타데이터가 편집됐습니다. 덮어쓰지 않고 중단했습니다.');
        }
    }
    for (const c of journal.changes) {
        if (!c.before) deleteEntry(data, c.uid, book);
        else {
            data.entries[c.uid] = structuredClone(c.before);
            for (const [key, value] of Object.entries(c.before)) setWIOriginalDataValue(data, c.uid, key, value);
            // Replace metadata, including open-loop and evidence values added by the undone operation.
            const now = getSettings().entryMetadata[`${book}:${c.uid}`] || {};
            const cleared = Object.fromEntries(Object.keys(now).map(k => [k, undefined]));
            stageMetadata(data, c.uid, { ...cleared, ...c.beforeMeta }, book);
        }
    }
    await saveLorebook(book, data);
    settings.memoryJournal = settings.memoryJournal.filter(j => j !== journal);
    saveSettings();
    return journal;
}
