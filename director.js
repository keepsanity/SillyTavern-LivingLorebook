import { l } from './i18n.js';
/**
 * Director's note — a pinned entry that keeps the story's big open question and what is coming next,
 * so the main model has somewhere to steer. Refreshed every N AI replies or from the toolbar.
 */

import { chat_metadata, saveMetadata } from '../../../../script.js';
import {
    getSettings, loadAnyLorebook, saveLorebook, refreshEditor,
    createEntry, updateEntryContent, setEntryPinned,
    getMetadata, stageMetadata, countTokens,
    operationContext, isOperationCurrent,
} from './lore-store.js';
import { callLLM } from './llm-service.js';

const LOG_PREFIX = '[LivingLorebook]';
const TITLE = "Director's Note";
const META_KEY = 'll_director_at';
let running = false;

const DIRECTOR_SYSTEM = `You are the story director for a long-running roleplay between a player and an AI storyteller.
You write a short private note about the world around {{user}} and the main character. The storyteller reads it every turn; the player never sees it.

Write exactly these three lines, plain English, under 120 words total:
His life: what the main character has going on this week that has nothing to do with {{user}}: work, team, family, money, a friend, a problem. One or two concrete things, with dates when the page gives them.
Around them: what one or two other people in the cast are busy with in their own lives, as their own business.
Open: anything on the calendar or promised on the page that has not happened yet, with its date.

Rules:
- Build only from what is already on the page or in the lore. Nothing arrives from nowhere.
- Keep the genre the lore sets.
- {{user}} is never the target, the prize or someone to protect. Never decide what {{user}} does, says, feels or chooses.
- Other people's view of {{user}} and the main character is not a thread; their own lives are.
- Nothing here is due in the next reply; the storyteller uses it when the story gets there.
- Premise only: no dialogue, no gestures, no example lines.
Output only the three lines.`;

function clean(text) {
    return String(text || '')
        .replace(/<details[\s\S]*?<\/details>/gi, '')
        .replace(/<think[\s\S]*?<\/think>/gi, '')
        .trim();
}

function aiReplyCount(chat) {
    return chat.filter(m => !m.is_user && !m.is_system).length;
}

function findByCategory(data, lorebook, category) {
    for (const [uid, entry] of Object.entries(data.entries || {})) {
        if (entry.disable) continue;
        if (getMetadata(uid, lorebook)?.category === category) return { uid, entry };
    }
    return null;
}

/**
 * Creates or refreshes the director's note in the target lorebook.
 * @returns {Promise<{created: boolean, uid: string, tokens: number, text: string}>}
 */
export async function generateDirection() {
    const settings = structuredClone(getSettings());
    const operation = operationContext();
    if (!settings.targetLorebook) throw new Error(l('ll.1c7e28934a4ba644', "Select a target lorebook first."));

    const data = await loadAnyLorebook(settings.targetLorebook);
    if (!data) throw new Error(l('ll.fb9199f839943224', "Could not load the lorebook."));

    const ctx = SillyTavern.getContext();
    const chat = (ctx.chat || []).filter(m => !m.is_system && !m.is_hidden);
    if (chat.length === 0) throw new Error(l('ll.6860965f9c298580', "The conversation is empty."));

    const limit = Number(settings.directorChatLimit) || 40;
    const conversation = chat.slice(-limit)
        .map(m => `${m.is_user ? (ctx.name1 || 'User') : (m.name || 'Character')}: ${clean(m.mes)}`)
        .join('\n\n');

    const card = ctx.characters?.[ctx.characterId];
    const cardText = card ? ctx.substituteParams(card.description || '') : '';

    const lore = [];
    for (const [uid, entry] of Object.entries(data.entries || {})) {
        if (entry.disable) continue;
        const cat = getMetadata(uid, settings.targetLorebook)?.category;
        if (cat === 'direction') continue;
        const body = clean(entry.content).replace(/^##\s+.*\r?\n/, '');
        lore.push(`--- ${entry.comment || 'untitled'}${cat === 'arc' ? ' (story so far)' : ''} ---\n${cat === 'arc' ? body : body.slice(0, 600)}`);
    }

    const previous = findByCategory(data, settings.targetLorebook, 'direction');
    const previousText = previous ? clean(previous.entry.content).replace(/^##\s+.*\r?\n/, '') : '';

    const userPrompt = [
        `# Main character card\n${cardText || '(none)'}`,
        `# Lore\n${lore.join('\n\n') || '(none)'}`,
        previousText ? `# Previous director's note\n${previousText}` : '',
        `# Recent conversation\n${conversation}`,
        'Write the new note.',
    ].filter(Boolean).join('\n\n');

    const system = DIRECTOR_SYSTEM.replaceAll('{{user}}', ctx.name1 || 'the player character');
    const raw = await callLLM(system, userPrompt, Number(settings.directorMaxTokens) || 4000, settings);
    const text = clean(raw);
    if (!text) throw new Error(l('ll.ef9e91a0eb7995ec', "The AI returned an empty response."));
    if (!isOperationCurrent(operation)) throw new Error(l('ll.515f3432faf2e879', "The chat changed. Saving was cancelled."));

    const content = `Background for the storyteller: what other people in the story have going on in their own lives. Nothing here is due; use it when the story gets there. Never quote or mention this note.\n${text}`;
    let uid;
    let created = false;
    if (previous) {
        uid = previous.uid;
        updateEntryContent(data, uid, content, settings.targetLorebook);
    } else {
        const entry = await createEntry(settings.targetLorebook, data, {
            title: TITLE, content, keywords: ['director'], category: 'direction',
            summary: 'When to select: always (director\'s note).',
        });
        if (!entry) throw new Error(l('ll.director.createFail', "Could not create the director's note."));
        uid = String(entry.uid);
        created = true;
    }
    setEntryPinned(data, uid, true);
    stageMetadata(data, uid, { category: 'direction', lastUpdated: Date.now() }, settings.targetLorebook);
    await saveLorebook(settings.targetLorebook, data);
    refreshEditor();

    chat_metadata[META_KEY] = aiReplyCount(ctx.chat || []);
    saveMetadata();

    return { created, uid, tokens: await countTokens(content), text };
}

/** Called after each AI reply; refreshes the note in the background every N replies. */
export async function maybeAutoDirect(onDone) {
    const settings = getSettings();
    if (!settings.directorAutoEnabled || !settings.targetLorebook || running) return;
    const interval = Math.max(5, Number(settings.directorInterval) || 20);
    const count = aiReplyCount(SillyTavern.getContext().chat || []);
    const last = Number(chat_metadata[META_KEY]) || 0;
    if (count - last < interval) return;

    running = true;
    try {
        await generateDirection();
        console.log(`${LOG_PREFIX} Director's note refreshed at reply ${count}`);
        onDone?.();
    } catch (err) {
        console.warn(`${LOG_PREFIX} Director's note refresh failed:`, err);
    } finally {
        running = false;
    }
}

export function isDirectorRunning() {
    return running;
}

export function setDirectorRunning(value) {
    running = value;
}
