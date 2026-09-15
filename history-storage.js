import { getRequestHeaders } from '../../../../script.js';
import { l } from './i18n.js';
let getSettings;
let saveSettings;
export function initHistoryStorage(readSettings, persistSettings) {
    getSettings = readSettings;
    saveSettings = persistSettings;
}

const HISTORY_FILE = 'livinglorebook-history-v1.json';
let pending = Promise.resolve();

export async function writeArchive(name, data) {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const response = await fetch('/api/files/upload', {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name, data: btoa(binary) }),
    });
    if (!response.ok) throw new Error(l('ll.storage.archive', 'Living Lorebook archive could not be saved. Source data was retained.'));
    return '/user/files/' + name;
}

async function read() {
    const response = await fetch('/user/files/' + HISTORY_FILE, { cache: 'no-store' });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(l('ll.storage.read', 'Living Lorebook history could not be loaded.'));
    const data = await response.json();
    if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error(l('ll.storage.format', 'Unsupported Living Lorebook history format.'));
    return data.entries;
}

function locked(work) {
    const job = pending.then(work);
    pending = job.catch(() => {});
    return job;
}

export function updateHistory(transform = entries => entries) {
    return locked(async () => {
        const settings = getSettings();
        const legacy = settings.memoryJournal || [];
        const entries = await read();
        for (const record of legacy) {
            if (!entries.some(e => e.at === record.at && e.book === record.book && e.chatId === record.chatId)) entries.push(record);
        }
        const result = transform(entries.sort((a, b) => a.at - b.at));
        await writeArchive(HISTORY_FILE, { version: 1, entries: result.slice(-5) });
        if (settings.memoryJournal === legacy) { delete settings.memoryJournal; saveSettings(); }
        return result.slice(-5);
    });
}

export const readHistory = () => updateHistory();
