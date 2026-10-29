import { useEffect, useState } from "react";
import {
  MAX_AUTH_AGE_SECONDS,
  SESSION_WARNING_SECONDS,
} from "../../shared/auth";
import { telegramInitData } from "./telegram";

export function launchExpiry(raw: string | null): number | null {
  const value = new URLSearchParams(raw ?? "").get("auth_date");
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    return null;
  return (Number(value) + MAX_AUTH_AGE_SECONDS) * 1000;
}
export function sessionState(raw: string | null, now = Date.now()) {
  const expires = launchExpiry(raw);
  const remaining =
    expires === null ? null : Math.max(0, Math.ceil((expires - now) / 1000));
  return {
    remaining,
    warning: remaining !== null && remaining <= SESSION_WARNING_SECONDS,
    expired: remaining === 0,
  };
}
export function useSessionState() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 15_000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
    };
  }, []);
  return sessionState(telegramInitData, now);
}
