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
Do not replace concrete shared experiences with generic statements such as "they spent time together".
No summary is required for vector/hybrid retrieval. Do not produce generic thematic retrieval hints.
`;

export const ARC_POLICY = `
Write a continuity brief for the next scene using supplied memories and recent conversation.
For major turning points retain supported cause, change and still-relevant consequence.
Include one-time characters if their actions still matter. Never invent narrative themes or future closure.
End with current situation, immediate goals, unresolved promises/conflicts and relevant knowledge boundaries.
Close resolved issues. Earlier states are history, not errors to erase or states to project onto the present.
Condense older details to fit the requested length while preserving causes of the present situation.
Do not count the same event twice when both recent chat and memories describe it.
`;

export function parseCompleteJSON(raw) {
    if (typeof raw !== 'string') throw new Error(l('ll.8b0dde7064ecd1ab', "The AI response is not a string."));
    try { return JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
    catch { throw new Error(l('ll.019c603a2a1d949b', "The AI response is incomplete. Memories and source messages are unchanged. Try a smaller range.")); }
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
