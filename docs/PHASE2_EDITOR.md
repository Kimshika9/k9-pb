# Phase 2: Advanced Rich Post Editor

## Use the editor

Open the Mini App through your owner's bot launch button, then open **Posts**. Create a draft or switch to **Templates** and choose one of the four samples. Click a content block to select it. Desktop shows its properties alongside the canvas; on mobile the selected properties appear inside the block card.

The add toolbar supports headings 1–6, formatted paragraphs, preformatted code, dividers, quotations, ordered/unordered lists, tables, expandable details, photos, videos, documents and button rows. Every block can be edited, duplicated, removed and moved with arrow controls; desktop drag handles reorder within the same block container. Nested blocks use the same controls and schema.

Rich text uses Tiptap/ProseMirror with a structured inline model. Bold, italic, underline, strikethrough, spoiler, inline code, safe hyperlinks, undo/redo and keyboard shortcuts work without persisting raw HTML. Myanmar and English text are preserved. Pasted HTML is interpreted through the editor's restricted schema; previews use React elements and never `dangerouslySetInnerHTML`. Inline code uses ProseMirror's exclusive mark behavior.

For tables, select a cell and edit its formatted text below the grid. Add/remove rows and columns, toggle the selected cell's header flag, set borders/stripes/compact spacing, and edit the caption. Wide grids scroll horizontally. For details and quotations, select and edit nested blocks inside the properties section.

A button row contains up to eight buttons. Each has a label, style, and exactly one URL or callback action. Add more Button row blocks for multiple rows. Callback actions are editable data only: the preview displays a notice and executes no business workflow. Link style is allowed only with callback actions.

## Saving and conflicts

Drafts persist in the existing `posts` table with `status='draft'`, schema version 2, owner identity and a revision. Autosave waits **1200 ms** after the last change. Manual Save uses the same serialized write path. Edits made while a save is in flight remain dirty and are saved afterward using the returned revision.

The Worker performs an atomic `UPDATE ... WHERE revision=?`. A stale client gets **409 VERSION_CONFLICT**, never an automatic overwrite. Autosave pauses on errors. Conflict recovery offers loading the latest saved version (with discard confirmation) or saving local changes as a new draft. Download a backup before closing an expired or offline session. Authentication still expires after 15 minutes; relaunch through the bot for fresh initData.

Delete actions require confirmation and the current revision. Draft lists have title search and pagination. Templates can be saved from any structurally valid draft, listed, reused, renamed, duplicated and deleted. Built-in samples are read-only; duplicate one to create an editable custom template. Custom template rename/delete also checks revisions.

**Backup** downloads the current editor document and draft metadata as JSON. **Telegram JSON** generates and downloads validated `InputRichMessage` JSON. An incomplete draft may be saved, but export is blocked until required text, media and actions are valid. Backup files and exported post content are private owner data. Download behavior inside native Telegram Android still needs device acceptance testing; downloads were verified in Chromium.

## Media workflow

1. Send a supported photo, video or document directly to the bot in the owner's private chat.
2. The existing secret-protected webhook verifies the owner and chat, registers the Telegram file ID and metadata in D1, and ignores non-owner media.
3. Add a matching media block and open **Choose photo/video/document**.
4. Refresh and pick a file, or register an existing ID belonging to the same bot. Existing IDs are checked with Telegram's `getFile` endpoint before storage.
5. Add a formatted caption and optionally a photo/video spoiler cover.

The library never returns `file_path` or a token-bearing download URL. No object storage, upload service, browser upload endpoint or media download proxy was added. Previews intentionally use placeholders. Owner-supplied file types must match the existing file: `getFile` verifies identity and size, but does not identify its media kind. The hosted Telegram service and native uploads have not been tested with real credentials; large videos are **not claimed to work**.

Repeated Telegram delivery is deduplicated by owner + file_unique_id, preserving the first canonical file ID so existing drafts keep their references. Draft/template saves and server export check each media reference against the owner's registered library and kind.

## Limits and validation

Confirmed Telegram rules: heading sizes 1–6; at most 8 buttons per row; one action per button; callback data 1–64 **UTF-8 bytes**; link style only on Rich Message callback buttons. URLs are additionally restricted by Studio to http, https and tg, without credentials or control/space characters. IDs use a conservative syntactic screen and must also be verified by Telegram or its authenticated webhook.

Conservative **Studio** caps (not assertions about undocumented Telegram maxima): 100 content blocks total, three nested container levels, 20 table rows × 8 columns, 50 list items, 4000 UTF-16 units per rich-text field/code block, and a 60 KB encoded editor document. Studio media registration caps photos at 10 MB, videos/documents at 20 MB. Requests retain Phase 1's streaming 64 KiB body limit. Draft pages contain 50 items; custom template lists currently cap at 100.

`parseDocument` rejects unknown fields, invalid types, unsafe text links, duplicate IDs, cycles, excessive nesting and malformed tables before persistence. Content completion checks are separate: a blank media block or unfinished button URL can be kept in a draft, but can never be exported as a valid Telegram payload. No editor IDs, library IDs, schema versions, ownership fields or draft metadata enter the Telegram serializer.

## Architecture and migration

- `shared/editor/model.ts`: typed version 2 document and block schema.
- `shared/editor/schema.ts`: runtime validation and explicit application limits.
- `shared/editor/operations.ts`: creation, immutable edits, cloning, reordering and rich-text conversion.
- `shared/editor/telegram.ts`: official wire types, completion validation, serializer and a preparation-only future Telegram preview adapter.
- `src/editor/`: draft/template workspace, autosave editor, block canvas, separate table/button builders, Tiptap text editor, browser preview and media picker.
- `worker/lib/editor-store.ts`: protected draft/template APIs and revision checks.
- `worker/lib/media.ts`: owner media APIs and webhook registration.
- `migrations/0002_editor.sql`: additive ownership/revision/media metadata fields and indexes. Migration 0001 and its approval constraints are preserved.

Run `npm run db:migrate:local` to apply the new migration to your existing local database. Never reset the database to upgrade. Legacy owner-null Phase 1 posts/templates remain visible to the sole configured owner and gain ownership on update. Empty version 1 documents and simple legacy heading/paragraph/divider blocks convert on read; unsupported legacy content returns 422 and remains intact in storage for explicit import. Existing media rows without ownership/kind are preserved but are not offered in the new library until re-registered.

Production bindings, remote migrations, webhook registration and deployment were not changed. Apply remote migrations only after explicit authorization. The deployment guide's `allowed_updates: ['message']` already includes private media messages.

## Phase 3 work

- Real `sendRichMessage` preview and channel publication: verify hosted 10.3 acceptance, complete published-reference limits and media kind compatibility with a dedicated test bot/channel.
- Check approved destinations and current bot/owner permissions immediately before each send/edit/retry; store message IDs, sanitized failures and idempotency state.
- Implement owner-approved callback workflows and Telegram message editing.
- Scheduling, UTC job timestamps, owner display timezone, durable execution/leases, retries, cancellation and dead-letter handling.
- Native Android Mini App acceptance: Myanmar IME composition, selection/clipboard, drag alternatives, file downloads, session expiry and large-media behavior.
- Explicit legacy-document/media import, richer template pagination, audit viewer, media removal/lifecycle, and safe webhook retention cleanup.
