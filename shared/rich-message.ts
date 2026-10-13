// Phase 2 replaces the unused Phase 1 stub with the validated application model and official adapter.
export type {
  EditorDocument as RichDocument,
  Block as RichBlock,
  ButtonStyle,
} from "./editor/model";
export type { InputRichMessage } from "./editor/telegram";
export {
  serializeRichMessage,
  validateForTelegram,
  telegramPreviewAdapter,
} from "./editor/telegram";
