# Living Lorebook 3

Remember shared experiences in detail, keep relationships current, and preserve the overall story.
Made mostly for personal use ₍ᐢっ ̫ ʚ̴̶̷̥̀ ᐢ₎

## Interface language

The interface follows SillyTavern's language setting. Korean (`ko` / `ko-kr`) uses the bundled Korean locale; English is the fallback for other languages. Reload SillyTavern after changing the language. No separate extension language setting is needed.

Buttons, settings, dialogs, review messages, selection reasons, and notifications are localized. Lorebook content, names, and saved model prompts are not translated or rewritten. Localization uses SillyTavern's native locale loader and translation API, with namespaced keys in `locales/ko.json`. Template placeholders must be preserved when adding translations.

## Organizing memories

The main toolbar contains **Organize Memories**, **New Entry**, and **Story Arc**. Open **More** for undo, world generation, reorganization, and memory compression. Review, automatic story arcs, and message hiding are grouped under memory organization settings. Compression settings contain ratios; the action lives in More.

1. Select the target lorebook and conversation range.
2. The model proposes additions and updates with source message IDs.
3. Review the previous and proposed content alongside the source messages, then apply or cancel.
4. Automatic hiding applies only to complete, nonempty changes without warnings. Empty results, partial responses, and duplicate or interpretation warnings leave source messages visible.

With automatic story arcs enabled, organizing memories creates the first arc or updates the existing one **before hiding messages**. If arc generation fails, saved memories remain and automatic hiding is withheld. An existing disabled setting stays disabled. Arcs use existing entries and the configured recent active conversation window, not the entire chat history.

### LIVE, PIN, and unresolved matters

- **LIVE** allows the organizer to update an entry. Relationships retain the same UID through breakups, reconciliation, or marriage; detailed transition scenes belong in event entries. Once v3 has recorded evidence, updates from older message ranges cannot rewind a newer state.
- **PIN** makes an entry an always-selected candidate, subject to the LL token cap and SillyTavern's applicable limits.
- **Unresolved matters** marks an outstanding promise, goal, or conflict for retrieval priority when a related name is mentioned. The model can set this during organization. Existing entries need LIVE enabled for the model to update or clear the flag; manual editing remains available.

The organizer receives existing categories, aliases, unresolved flags, and evidence positions. Metadata-only updates are supported and shown in review. Additions with the same title and category trigger a warning. Prompts emphasize concrete objects, places, actions, and meaningful wording as recall cues; this does not guarantee semantic accuracy.

### Undo

**Undo Last Organization** restores the latest organization for the target lorebook within the five most recent organization records. Later entry or metadata edits block undo rather than being overwritten. **Chat message hiding must be reversed separately.** Undo does not roll back compression, reorganization, or automatic story arc updates.

## Retrieval and injection

- **hybrid:** prioritizes directly named characters and relevant current relationships or unresolved commitments, then ranks semantic and lexical matches.
- **bm25:** uses lexical retrieval and name matching without embeddings.
- **ai:** asks a model to choose among candidates with summaries. Selecting zero entries is valid. Name-priority rules apply to the fast retrieval engines.

Older managed entries with empty native keys can still use `metadata.keywords`. Existing titles and bodies remain eligible for vector retrieval without new metadata or summaries. Add exact names to **Names / Aliases** in the entry editor. Relationship and commitment entries can use participant aliases to support direct-name retrieval.

When several people appear in the wider search window, direct mentions in the configured recent vector window take priority. Earlier people remain candidates. This does not resolve pronouns automatically.

A healthy vector query returning no matches is distinct from an outage or stale index. Unavailable vector retrieval can fall back to BM25. Changed indexes are rebuilt before the next hybrid search, which can make the first search slower.

The former relative-cutoff value is retained but now acts as a **lexical-only result floor**, combined with the BM25 floor by taking the higher value. A single engine's match is no longer discarded simply because it falls below the highest fused score. Direct name and keyword evidence is handled separately.

Click the **Selected** token indicator to inspect selection reasons and World Info activation results. SillyTavern's budget, position, and slot rules still apply. World Info activation is not proof of inclusion in the final model request. Priority affects runtime order on managed copies, not the stored entry order.

### Token budget

The LL selection token cap defaults to **0**, meaning **no additional LL cap**. SillyTavern's limits and the configured selection count still apply. A positive value limits selected memory tokens, including pinned memories. Memories omitted by this cap are listed with a reason.

## Compatibility and data protection

- Startup preserves saved custom prompts. Evidence, duplication, relationship-state, and continuity rules are added as system instructions when organizing memories or generating an arc. Updated default prompts follow the same contract; older custom prompts may need their conflicting instructions revised manually.
- Existing categories, lorebooks, keyword metadata, and LIVE/PIN settings remain usable. Existing lorebook content is not rewritten in bulk.
- Vector/hybrid retrieval does not require AI-selection summaries. The existing automatic backfill preference is retained; organization backfills only newly created entries.
- New defaults enable change review and set the LL token cap to 0. Review can be disabled in settings.
- Saving compares the original book immediately before writing and checks HTTP success before committing staged metadata. Conflicts, chat switches, empty content, and incomplete responses abort the operation.
- Reorganization preserves LIVE and pinned entries and requires output coverage for every input UID.

Embedding configuration follows SillyTavern's **Vector Storage** settings.

## Verification and limitations

Run from the extension directory:

```sh
node --experimental-vm-modules --test tests/*.test.mjs
```

The 41 regression tests execute real extension modules with mock SillyTavern storage, model, vector, and localization services. They cover relationship transitions, save failures, older ranges, incomplete proposals, duplicate warnings, name retrieval, token budgets, reorganization, first-arc generation, and language fallback without modifying user text. These are not a benchmark of actual RP response quality.

Older entries without v3 evidence positions cannot be checked for chronological regression before their first tracked update. Semantic duplicates and source entailment still require review. The pre-save comparison is not server-side atomic compare-and-swap: another tab can write between comparison and saving. Lorebook and settings persistence are also not a single database transaction.

## License

**AGPL-3.0** — see [LICENSE](LICENSE).

## Inspired by

- [SillyTavern](https://github.com/SillyTavern/SillyTavern)
- [sillytavern-DeepLore](https://github.com/pixelnull/sillytavern-DeepLore)
- [SillyTavern-MemoryBooks](https://github.com/aikohanasaki/SillyTavern-MemoryBooks)
- [TunnelVision](https://github.com/Coneja-Chibi/TunnelVision)
- [VectHare](https://github.com/Coneja-Chibi/VectHare)

---

Copyright (C) 2026 keepsanity
