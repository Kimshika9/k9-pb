import type { ApiErrorBody } from "../../shared/contracts";
import { telegramInitData } from "./telegram";
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (!telegramInitData)
    throw new ApiError(
      401,
      "TELEGRAM_REQUIRED",
      "Open K9 Post Studio using your bot’s launch button.",
    );
  const headers = new Headers(options.headers);
  headers.set("Authorization", `tma ${telegramInitData}`);
  if (options.body) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      credentials: "omit",
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "Could not connect. Check your connection and try again.",
    );
  }
  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      typeof body?.error?.code === "string"
        ? body.error.code
        : "REQUEST_FAILED",
      typeof body?.error?.message === "string"
        ? body.error.message
        : "The request failed. Please try again.",
    );
  }
  try {
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new Error();
    return (await response.json()) as T;
  } catch {
    throw new ApiError(
      502,
      "INVALID_RESPONSE",
      "The studio returned an unexpected response. Please try again.",
    );
  }
}
