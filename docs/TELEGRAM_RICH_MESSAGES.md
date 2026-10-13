# Telegram Bot API 10.3 research and renderer boundary

Research date: 2026-10-12. The supplied screenshots show the intended future composition: media, table-like metadata, collapsible details, and colored action buttons. They inform Phase 2's document model, not the private dashboard's theme.

## Official evidence

The official documentation URL is <https://core.telegram.org/bots/api>. Direct retrieval returned **HTTP 403 in this environment**. Research therefore used Telegram's official implementation, pinned to commit `e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1`:

- [CMakeLists.txt](https://github.com/tdlib/telegram-bot-api/blob/e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1/CMakeLists.txt) declares `project(TelegramBotApi VERSION 10.3 ...)`.
- [Client.cpp](https://github.com/tdlib/telegram-bot-api/blob/e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1/telegram-bot-api/Client.cpp) registers `sendrichmessage` and parses the fields below. Relevant functions: `process_send_rich_message_query`, `get_input_rich_message`, `get_input_page_block`, `get_page_block_table_cell`, `get_inline_button`, `get_button_style`.

| Feature            | Confirmed official implementation                                                                                                  | Phase 2 mapping                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `sendRichMessage`  | Consumes `rich_message`, sends `inputMessageRichMessage`                                                                           | Dedicated renderer output, approval-guarded sender            |
| `InputRichMessage` | One source: `blocks`, `markdown`, or `html`; optional `is_rtl`, `skip_entity_detection`; HTML/Markdown may have `media` references | Our versioned document is independent of Telegram wire schema |
| Tables             | Block `type: "table"`, `cells` as row arrays, optional `caption`, `is_bordered`, `is_striped`, `is_compact`                        | Editor table rows map to validated Telegram cells             |
| Details            | `type: "details"`, rich-text `summary`, nested `blocks`, optional `is_open`                                                        | Collapsible content model                                     |
| Button rows        | `type: "buttons"`, array `buttons`, optional `align` (`left`, `center`, `right`)                                                   | Rows of validated actions                                     |
| Styled buttons     | Default/empty, `primary`, `danger`, `success`; `link` only for Rich Message callback buttons                                       | Blue/red/green/link presentation with accessible labels       |
| Rich text          | Structured text fields parsed by `get_rich_text`, not assumed to be inline keyboard strings                                        | Escaping and rich-text conversion in the adapter              |

## Phase 2 implementation

The structured adapter is now implemented in `shared/editor/telegram.ts`. It emits only the supported Bot API wire fields; editor IDs, revisions, owner data and media-library metadata are removed. `serializeRichMessage` validates the version 2 editor model and completion requirements before returning `{ blocks: [...] }`. The future `telegramPreviewAdapter.prepare` wraps this in a `sendRichMessage` request preparation object without making any HTTP call or choosing a channel.

Additional official evidence comes from [TDLib's pinned schema](https://github.com/tdlib/td/blob/c15d3f5a5de6e3ba5839822c451152e5e18bb700/td/generate/scheme/td_api.tl): headings use sizes 1–6, ordered list item numbering types include `"1"`, and `buttonStyleLink` is allowed only for callback buttons in an `inlineButton`. These internal TDLib names are not copied blindly to HTTP JSON: for example, Bot API details use `summary`, even though TDLib's internal constructor calls that field `header`.

Confirmed mappings:

```json
{
  "blocks": [
    { "type": "heading", "size": 2, "text": ["Software information"] },
    {
      "type": "paragraph",
      "text": [{ "type": "bold", "text": "မြန်မာ / English" }]
    },
    {
      "type": "table",
      "cells": [
        [
          { "text": ["Label"], "is_header": true },
          { "text": ["Value"], "is_header": false }
        ]
      ],
      "caption": [],
      "is_bordered": true,
      "is_striped": false,
      "is_compact": false
    },
    {
      "type": "details",
      "summary": ["More information"],
      "blocks": [{ "type": "paragraph", "text": ["Nested content"] }],
      "is_open": false
    },
    {
      "type": "buttons",
      "align": "center",
      "buttons": [
        {
          "text": ["Open details"],
          "style": "link",
          "callback_data": "open_details"
        }
      ]
    }
  ]
}
```

Media blocks use `{ "type": "photo", "photo": { "type": "photo", "media": "<verified same-bot file_id>", "has_spoiler": false }, "caption": { "text": ["Caption"] } }`, with analogous `video`/`document` InputMedia containers. The caption is a RichBlockCaption object; file IDs are provided as `media`, not an invented `file_id` wire field. Documents omit `has_spoiler`. Preformatted blocks use `type: "pre"`, `text` and `language`; quotations use `blocks` and `credit`; lists use item `blocks`, `value` and `type`.

The interface deliberately supports only the requested structured blocks, not every possible 10.3 RichText or media variant. Tests cover exact output and validation. There are no editor HTML strings, parse_mode shortcuts or unverified Telegram fields in the adapter. The browser preview is an approximation and media uses placeholders.

## Limits and live acceptance

The published documentation URL continued to return 403 during Phase 2. Field mappings were cross-checked with the official 10.3 implementation and the pinned TDLib schema. Verified constraints are enforced; additional caps are explicitly **Studio limits**, not claims about unpublished provider maxima. See PHASE2_EDITOR.md for exact limits and the difference between incomplete drafts and export validation.

Before Phase 3 sends anything: cross-check the complete published reference when accessible, verify hosted 10.3 endpoint support, table/nesting/text/media acceptance and native rendering with real credentials and an owner-approved test channel. Confirm manually registered media kind compatibility; getFile verifies identity/size but provides no media-kind field. No live Telegram Rich Message was sent during this implementation, and large-media/native-device compatibility remains unverified.
