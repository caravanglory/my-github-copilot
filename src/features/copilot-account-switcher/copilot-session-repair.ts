import { log } from "../../logger"

import { readStoreSafe } from "./store"
import type { FetchLike } from "./types"

const POST_SWITCH_WINDOW_MS = 5 * 60 * 1000

export async function getLastAccountSwitchAt(): Promise<number | undefined> {
  const store = await readStoreSafe().catch(() => undefined)
  return store?.lastAccountSwitchAt
}

export function isWithinPostSwitchWindow(switchedAt: number, windowMs = POST_SWITCH_WINDOW_MS): boolean {
  return Date.now() - switchedAt < windowMs
}

function isPostSwitchError(status: number, bodyText: string): boolean {
  if (status < 400) return false

  const lower = bodyText.toLowerCase()
  const sessionErrors = [
    "session",
    "invalid token",
    "unauthorized",
    "bad request",
    "authentication",
    "expired",
  ]
  return sessionErrors.some((keyword) => lower.includes(keyword))
}

export function createPostSwitchAwareFetch(baseFetch: FetchLike): FetchLike {
  return async function postSwitchAwareFetch(
    request: Request | URL | string,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await baseFetch(request, init)

    if (response.status < 400) return response

    const switchedAt = await getLastAccountSwitchAt().catch(() => undefined)
    if (!switchedAt || !isWithinPostSwitchWindow(switchedAt)) return response

    const cloned = response.clone()
    const bodyText = await cloned.text().catch(() => "")
    if (!bodyText) return response

    if (isPostSwitchError(response.status, bodyText)) {
      const elapsedSec = Math.round((Date.now() - switchedAt) / 1000)
      const rawUrl = request instanceof Request ? request.url : String(request)
      log("[copilot-session-repair] post-switch error detected", {
        status: response.status,
        elapsedSec,
        url: rawUrl,
        bodyPreview: bodyText.slice(0, 200),
      })
    }

    return response
  }
}
