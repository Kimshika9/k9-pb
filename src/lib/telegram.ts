import {
  init,
  retrieveRawInitData,
  miniApp,
  viewport,
} from "@tma.js/sdk-react";

// Only the raw signed payload is passed to the server. SDK user data never authorizes access.
export function initializeTelegram(): string | null {
  let raw: string | undefined;
  try {
    raw = retrieveRawInitData();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    init();
    miniApp.mount.ifAvailable();
    miniApp.setHeaderColor.ifAvailable("#0b0e16");
    miniApp.setBgColor.ifAvailable("#0b0e16");
    miniApp.ready.ifAvailable();
    if (viewport.mount.isAvailable()) {
      void viewport
        .mount({ timeout: 3000 })
        .then(() => {
          viewport.expand.ifAvailable();
          viewport.bindCssVars.ifAvailable();
        })
        .catch(() => {
          /* Telegram clients without viewport support still authenticate. */
        });
    }
  } catch {
    /* Client decoration cannot override server authentication. */
  }
  return raw;
}
export const telegramInitData = initializeTelegram();
