import { l, lt } from './i18n.js';
/** Shared memory contract. Added to system prompts without replacing saved user prompts. */
export const MEMORY_POLICY = `
Living Lorebook continuity contract (takes precedence over conflicting task wording):
Record source-established actions, meaningful dialogue, explicit agreements and narrated internal states.
Do not infer motives, feelings or an overall relationship verdict. A missing relationship label is NOT evidence
of ambiguity, hesitation or lack of progress. Attribute beliefs and feelings to a person and a time.
Preserve qualifications, negation, promises and who knows a secret. Plans and claims are not completed facts.
One event is a coherent trigger/action/outcome. Do not copy its narration across categories.
Create a separate character/relationship entry only for distinct supported information worth consulting later.
Use only established dates. Background lore is not an event the characters experienced.
An event is historical evidence; an arc connects causes and consequences; a LIVE entry holds current facts.
An event entry stays under about 1500 characters: the decisive actions, the outcome and one reaction; the rest of the scene lets go.
An event also keeps, in one past-tense sentence tied to that moment, what the source narrated of a person's reaction or inner state right then, in plain words and at the size it had on the page: a hand left where it was, a step missed. Firsts, superlatives and what a moment meant are not recorded. Keep such reactions in events and milestones, dated; a LIVE entry states current facts and never a standing disposition.
Never deactivate a relationship because the people broke up, reconciled, or married. Update its state.
Preserve unaffected facts during updates. If nothing changed, do not update.
Older scenes may enrich history but must not rewind a later established current state.
The previous memory is a derived account, not independent evidence for an unsupported interpretation.
`;

export const ORGANIZE_SCHEMA = `
Return a complete JSON object with add, update and deactivate arrays, even when empty.
For EVERY add/update include sourceMessages: [integer message IDs from the supplied conversation].
Updates use uid and newContent (the COMPLETE replacement body, nonempty), plus a short reason.
Adds use title, content, keywords (string array), category, live (boolean).
Category is character, relationship, location, event, routine, item or fact.
Optional aliases: exact person/place/item names; never generic scene words.
Optional openLoop: true ONLY for a still unresolved explicit promise, goal or conflict; false when resolved.
Use live:true for a new current relationship or an unresolved commitment that must later be updated.
When a LIVE promise is fulfilled, cancelled or replaced, explicitly set openLoop:false and describe the outcome.
Aliases identify participants, not a relationship verdict. Preserve existing aliases unless the source corrects them.
Metadata-only updates still require the complete existing body and sourceMessages.
LIVE means permission to update, NOT permission to invent or disable. Return deactivate: [].
For relationships keep current supported facts, still-relevant commitments and only brief transition context.
Do not create another entry for an existing LIVE subject; update its UID when a supported change occurred.
Check the category/title/aliases index before adding. A matching READ ONLY subject cannot be silently updated:
add only a distinct new event, not a competing current-state record. Repeated mentions are not new events.
Keep distinctive recall cues (a particular object, place, wording or action) when supported by the source.
Keep who said what. When something was settled in conversation (a bet, a plan, a promise, a condition), record each person's part as that person's: what one proposed and what the other answered or added. A condition set in someone's own words stays attributed to them.
Record what was sent, said, written or done. Drafts that were typed and deleted, messages almost sent, and lines someone decided not to say are not events and are not recorded.
Do not replace concrete shared experiences with generic statements such as "they spent time together".
No summary is required for vector/hybrid retrieval. Do not produce generic thematic retrieval hints.
`;

/** Standing LIVE threads kept by every organize run: the main pair's progress and side characters' own lives. */
export function continuityThreads(char, user, pairUid = null) {
    const pairRule = pairUid !== null
        ? `Keep the LIVE relationship entry [uid:${pairUid}] for ${char} and ${user} current: update it when the conversation supports a change.`
        : `Add one LIVE relationship entry for ${char} and ${user} (category relationship, live:true, title "${char} & ${user} — Relationship").
  It is the designated current-state record for the pair, so adding it is allowed even when READ ONLY relationship entries
  for them exist; those stay as history and are not duplicated into it.`;
    return `
Ongoing threads to maintain, from source evidence only:
- ${pairRule} It holds:
  first, where the two of them stand right now, in three short plain sentences, each telling one strand through what was done
  or said on the page: how they are drawn to each other (what each has done toward the other's body and attention); how far
  each has let the other into their life (what each has changed, given or shown for the other); and what they call each other
  and have said they are (who said which word, with its date). Each strand is told in the source's own terms by its latest
  dated facts, the strand names stay out of the entry, and a strand nobody has moved keeps its last fact as it stands; then any plans, bets or promises between them as dated facts
  of what each said, with no open, pending or unresolved column; then the three or four most recent on-page milestones between them (meetings,
  touches, nicknames, promises, times one sought the other out), older ones folding into the event entries. Reactions and
  inner states stay in the dated events, and so do exact lines of dialogue: this entry tells what was said in plain reported
  speech, without quoting it. It carries no list of what draws ${char} to ${user} and no verdicts,
  predictions or labels the source did not use. The whole entry stays short, around 1200 characters.
- For a side character who appears in this conversation with something going on in their own life (work, a crush,
  a feud, a plan, a problem), keep one LIVE entry titled "<Name> — Current Life" (category character) with those
  still-open threads, as that person's own business; what they notice or think about ${char} and ${user} is not a thread. Add it if missing, update it if it exists. Record only what the source shows; never invent
  offscreen developments. Skip side characters with nothing of their own going on.
- For ${char} too, keep one LIVE entry titled "${char} — Current Life" (category character) with his own current circumstances:
  an injury and its expected recovery, a schedule, work, money, a problem, each with dates the source gives. Events hold how
  each came about; this entry holds where it stands now and is updated as it changes.
- Work is recorded the way a job is, in every entry: content, brands, posts and deals as what was made, posted, signed
  or decided, with dates. Who appears in that work or is left out of it, and how ${char} handles other women, are kept as
  plain facts in their own place and are not set against ${user} or read as signs of what he feels about her.
`;
}

export const ARC_POLICY = `
Write a continuity brief for the next scene using supplied memories and recent conversation.
For major turning points retain supported cause, change and still-relevant consequence.
Include one-time characters if their actions still matter. Never invent narrative themes or future closure.
Tell what was said in plain reported speech, keeping who said it; exact lines of dialogue stay in the dated events.
A character's work (content, brands, posts) is told as that person's own business, never as a measure of feeling for someone.
End with the current situation in three strands, each by its latest dated facts and without naming the strand: how they are drawn to each other, how far each has let the other into their life, and what they call each other and have said they are; then relevant knowledge boundaries. Earlier plans and promises stay in the dated timeline as what was said; there is no list of open items.
Close resolved issues. Earlier states are history, not errors to erase or states to project onto the present.
Condense older details to fit the requested length while preserving causes of the present situation.
Do not count the same event twice when both recent chat and memories describe it.
`;

export function parseCompleteJSON(raw) {
    if (typeof raw !== 'string') throw new Error(l('ll.8b0dde7064ecd1ab', "The AI response is not a string."));
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(text); } catch { /* Accept a complete JSON value surrounded by prose. */ }
    const values = [];
    let start = -1;
    let quoted = false;
    let escaped = false;
    const stack = [];
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (start < 0) {
            if (c !== '{' && c !== '[') continue;
            start = i;
            stack.push(c);
            continue;
        }
        if (quoted) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') quoted = false;
            continue;
        }
        if (c === '"') quoted = true;
        else if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') {
            if (stack.pop() !== (c === '}' ? '{' : '[')) break;
            if (!stack.length) {
                try { values.push(JSON.parse(text.slice(start, i + 1))); }
                catch { break; }
                start = -1;
            }
        }
    }
    // Never salvage a partial object or choose between multiple proposals.
    if (start < 0 && values.length === 1) return values[0];
    const error = new Error(l('ll.019c603a2a1d949b', 'Could not read a complete JSON response from the AI. The response may be malformed or cut off. Memories and source messages are unchanged.'));
    error.code = 'LL_INVALID_JSON';
    throw error;
}

export function normalizeMemory(text) {
    return String(text || '').replace(/^##[^\n]*\n/, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Validate the entire proposal BEFORE writing anything. No salvage or missing-body coercion. */
export function validateProposal(raw, data, metadata, processedIndices) {
    const obj = parseCompleteJSON(raw);
    if (!obj || Array.isArray(obj) || typeof obj !== 'object') throw new Error(l('ll.eff2a2a278ea351d', "Expected an organization response object."));
    for (const key of ['add', 'update', 'deactivate']) {
        if (!Array.isArray(obj[key])) throw new Error(lt('ll.9da2bd8f140d6a95')`The organization response is missing the ${key} array.`);
    }
    if (obj.deactivate.length) throw new Error(l('ll.2f32bbb4912ecf43', "The AI proposed disabling entries. Update existing entries to reflect state changes instead."));
    const allowed = new Set(processedIndices);
    const cats = new Set(['character', 'relationship', 'location', 'event', 'routine', 'item', 'fact']);
    const used = new Set();
    const contents = new Set(Object.values(data.entries || {}).filter(e => !e.disable).map(e => normalizeMemory(e.content)));
    const warnings = [];
    const changes = [];
    for (const [type, list] of [['add', obj.add], ['update', obj.update]]) {
        for (const item of list) {
            if (!item || typeof item !== 'object') throw new Error(l('ll.ad8629a6e23d6922', "Invalid change item."));
            const body = type === 'add' ? item.content : item.newContent;
            if (typeof body !== 'string' || !body.trim()) throw new Error(l('ll.c9ca1035316f3e4c', "Cannot save an empty body."));
            if (!Array.isArray(item.sourceMessages) || !item.sourceMessages.length
                || item.sourceMessages.some(i => !Number.isInteger(i) || !allowed.has(i))) {
                throw new Error(l('ll.735ee975c69e42a2', "Source message IDs are missing or outside the selected range."));
            }
            for (const key of ['keywords', 'aliases']) {
                if (item[key] !== undefined && (!Array.isArray(item[key]) || item[key].some(v => typeof v !== 'string'))) {
                    throw new Error(lt('ll.2f1521d75cd58f8b')`${key}must be an array of strings.`);
                }
            }
            if (item.openLoop !== undefined && typeof item.openLoop !== 'boolean') throw new Error(l('ll.325493f2b013ceb7', "Invalid openLoop value."));
            if (type === 'add') {
                if (typeof item.title !== 'string' || !item.title.trim() || !cats.has(item.category)) throw new Error(l('ll.80fab05a0b80d640', "Invalid title or category."));
                if (typeof item.live !== 'boolean') throw new Error(l('ll.0d60d52854436e5c', "A new memory is missing its LIVE flag."));
                const sameSubject = Object.entries(data.entries || {}).find(([uid, e]) =>
                    !e.disable && metadata[uid]?.category === item.category
                    && normalizeMemory(e.comment) === normalizeMemory(item.title));
                if (sameSubject) warnings.push(lt('ll.649db7fab77141ba')`Check the existing entry for this subject: ${item.title} (UID ${sameSubject[0]})`);
                if (item.openLoop && !item.live) warnings.push(lt('ll.e16ac0237613091a')`This unresolved matter is not LIVE and cannot be updated automatically: ${item.title}`);
                if (contents.has(normalizeMemory(body))) {
                    warnings.push(lt('ll.cc4a917a61e7f3e2')`Excluded identical content: ${item.title}`);
                    continue;
                }
                for (const existing of Object.values(data.entries || {}).filter(e => !e.disable)) {
                    const a = new Set(normalizeMemory(body).match(/[a-z0-9']+/g) || []);
                    const b = new Set(normalizeMemory(existing.content).match(/[a-z0-9']+/g) || []);
                    const intersection = [...a].filter(t => b.has(t)).length;
                    const union = new Set([...a, ...b]).size;
                    if (union > 8 && intersection / union > 0.65) {
                        warnings.push(lt('ll.2e90c510b4cb753c')`Check possible duplication: ${item.title} ↔ ${existing.comment}`);
                        break;
                    }
                }
                contents.add(normalizeMemory(body));
            } else {
                const uid = String(item.uid);
                if (!data.entries?.[uid] || data.entries[uid].disable || !metadata[uid]?.live || used.has(uid)) {
                    throw new Error(lt('ll.9b27f7b176d3f7dd')`Invalid, non-updatable, or duplicate UID: ${uid}`);
                }
                used.add(uid);
                const meta = metadata[uid];
                const metadataChanged = ['openLoop', 'aliases', 'summary'].some(key =>
                    item[key] !== undefined && JSON.stringify(item[key]) !== JSON.stringify(meta[key]));
                if (normalizeMemory(body) === normalizeMemory(data.entries[uid].content) && !metadataChanged) continue;
            }
            if (/\b(still ambiguous|not yet ready|bond deepened|remain\w* ambiguous)\b/i.test(body)) {
                warnings.push(lt('ll.03cb1df756a7a3b6')`Check relationship interpretation: ${item.title || data.entries[item.uid]?.comment}`);
            }
            changes.push({ ...item, type, sourceMessages: [...new Set(item.sourceMessages)] });
        }
    }
    return { changes, warnings };
}
