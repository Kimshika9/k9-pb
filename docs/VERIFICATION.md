# Phase 2 verification

Verified locally on 2026-10-12. Phase 1's original 67 tests remain in the full suite. Production database bindings were not changed; no deployment, remote migration, real webhook registration, channel publication or real Telegram Rich Message send was performed.

## Automated checks

The final suite contains **103 tests across 9 files**. It covers Phase 1 HMAC/freshness/owner restrictions and webhook behavior, plus:

- Typed block creation, immutable editing, delete/clone/reorder, nested IDs, malformed fields, cycles and nesting bounds.
- All requested rich text formats, Unicode and plain HTML-looking text, table/details/list/media wire mappings, button action/style validation and exact UTF-8 callback limits.
- Draft create/restore/search/update/export/duplicate/delete, stale revisions, two simultaneous saves, legacy preservation, foreign-resource filtering and approval checks.
- Template samples/save/reuse/rename/duplicate/delete and version conflicts.
- Owner webhook media registration/deduplication, invalid IDs/limits, manual getFile verification, canonical ID preservation and credential-safe responses.
- Loading/empty/error states, preview themes, draft restoration, explicit confirmation, debounced autosave, edits during an in-flight save, 409 recovery and template back-navigation.
- A real Tiptap component test for exclusive inline-code formatting, whole-document selection, selection loss while focusing the toolbar, and undo/redo. Other editor state tests isolate ProseMirror selection through a test-only text component; actual toolbar behavior was also exercised in Chromium.

Commands: `npm run test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run format:check`, and `git diff --check`. Type checks include frontend, Worker, shared modules, tests and Vite config. The production build uses the existing official Cloudflare Vite plugin; the post workspace and rich text library are split out of the initial dashboard bundle.

The new additive migration `0002_editor.sql` applied successfully to the existing **local D1** database: 14 commands. Migration 0001 and approval constraints were preserved. Automated API tests apply both migrations to isolated real SQLite databases; no production database reset occurs.

## Real local Worker/browser workflow

Chromium used the Vite/Cloudflare Worker runtime and migrated local D1, with temporary synthetic authentication credentials and Telegram update fixtures. At **1440×1000** and **390×844**, the workflow passed:

- Sample template to persistent draft; Myanmar/English text with bold and hyperlinks.
- Table row/cell editing; selecting owner-registered photo metadata and caption.
- Callback button/link style, dark/light preview, expanded details and safe placeholders.
- Actual JSON download and inspection; save-as-template; autosave and reload from D1.
- A second HTTP client updating the same draft, a real 409 in the UI, recovery as a new draft, search and restore.
- No page errors or horizontal page overflow.

An additional Chromium workflow exercised all formatting toolbar marks, undo/redo, switching to inline code, block move/duplicate/delete, confirmed draft deletion, and template duplication/rename/deletion. It caught a selection-preservation edge case, which was fixed and rechecked. Earlier browser checks also caught table-cell CSS and sample back-navigation issues; both have regression coverage or final screenshots.

Screenshots use synthetic/sample content and are browser approximations:

- [Desktop editor](screenshots/phase2-editor-1440.png)
- [Mobile editor](screenshots/phase2-editor-390.png)
- [Desktop preview](screenshots/phase2-preview-1440.png)
- [Mobile preview](screenshots/phase2-preview-390.png)

Temporary `.dev.vars` test configuration is removed before the final production build. Test-created local drafts/templates/media are cleaned up by their fixture identifiers; the database is not reset. No real credentials were supplied or committed.

## Remaining live checks

Telegram's documentation website returned 403; wire fields were verified against its official Bot API 10.3 implementation and pinned TDLib schema. Hosted Rich Message acceptance, complete published provider limits, native Telegram Android behavior (including Myanmar IME and download UX), live media uploads/type compatibility and large-video delivery remain unverified. Media previews use placeholders; no token-bearing URLs or paid upload services were added. Phase 3 requires real credentials, an HTTPS launch URL, an approved test channel and explicit authorization for external actions.
