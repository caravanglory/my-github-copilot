import { appendFileSync } from "node:fs"

import { log } from "../../logger"

import type { FetchLike } from "./types"

const RETRYABLE_MESSAGES = [
  "load failed",
  "failed to fetch",
  "network request failed",
  "sse read timed out",
  "unable to connect",
  "econnreset",
  "etimedout",
  "socket hang up",
  "unknown certificate",
  "self signed certificate",
  "unable to verify the first certificate",
  "self-signed certificate in certificate chain",
]

type RetryableSystemError = Error & {
  code: string
  syscall: string
  cause: unknown
}

type JsonRecord = Record<string, unknown>

const defaultDebugLogFile = (() => {
  const tmp = process.env.TEMP || process.env.TMP || "/tmp"
  return `${tmp}/opencode-copilot-retry-debug.log`
})()

function isDebugEnabled(): boolean {
  return process.env.OPENCODE_COPILOT_RETRY_DEBUG === "1"
}

function debugLog(message: string, details?: Record<string, unknown>): void {
  if (!isDebugEnabled()) return
  const suffix = details ? ` ${JSON.stringify(details)}` : ""
  const line = `[copilot-network-retry debug] ${new Date().toISOString()} ${message}${suffix}`
  log(line)

  const filePath = process.env.OPENCODE_COPILOT_RETRY_DEBUG_FILE || defaultDebugLogFile
  if (!filePath) return

  try {
    appendFileSync(filePath, `${line}\n`)
  } catch (error) {
    log(`[copilot-network-retry debug] failed to write log file`, {
      filePath,
      error: String(error),
    })
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function getErrorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error).toLowerCase()
}

function isInputIdTooLongErrorBody(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false
  const error = (payload as { error?: { message?: unknown } }).error
  const message = String(error?.message ?? "").toLowerCase()
  return message.includes("invalid 'input[") && message.includes(".id'") && message.includes("string too long")
}

function isInputIdTooLongMessage(text: string): boolean {
  const message = text.toLowerCase()
  return message.includes("invalid 'input[") && message.includes(".id'") && message.includes("string too long")
}

function hasLongInputIds(payload: JsonRecord): boolean {
  const input = payload.input
  if (!Array.isArray(input)) return false
  return input.some(
    (item) => typeof (item as { id?: unknown })?.id === "string" && ((item as { id?: string }).id?.length ?? 0) > 64,
  )
}

function stripLongInputIds(payload: JsonRecord): JsonRecord {
  const input = payload.input
  if (!Array.isArray(input)) return payload

  let changed = false
  const nextInput = input.map((item) => {
    if (!item || typeof item !== "object") return item
    const id = (item as { id?: unknown }).id
    if (typeof id === "string" && id.length > 64) {
      changed = true
      const clone = { ...(item as JsonRecord) }
      delete (clone as { id?: unknown }).id
      return clone
    }
    return item
  })

  if (!changed) return payload
  return { ...payload, input: nextInput }
}

function parseJsonBody(init?: RequestInit): JsonRecord | undefined {
  if (typeof init?.body !== "string") return undefined
  try {
    const parsed = JSON.parse(init.body)
    if (!parsed || typeof parsed !== "object") return undefined
    return parsed as JsonRecord
  } catch {
    return undefined
  }
}

function buildRetryInit(init: RequestInit | undefined, payload: JsonRecord): RequestInit {
  const headers = new Headers(init?.headers)
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  return { ...init, headers, body: JSON.stringify(payload) }
}

async function maybeRetryInputIdTooLong(
  request: Request | URL | string,
  init: RequestInit | undefined,
  response: Response,
  baseFetch: FetchLike,
): Promise<Response> {
  if (response.status !== 400) return response

  const requestPayload = parseJsonBody(init)
  if (!requestPayload || !hasLongInputIds(requestPayload)) {
    debugLog("skip input-id retry: request has no long ids")
    return response
  }

  debugLog("input-id retry candidate", {
    status: response.status,
    contentType: response.headers.get("content-type") ?? undefined,
  })

  const responseText = await response
    .clone()
    .text()
    .catch(() => "")

  if (!responseText) {
    debugLog("skip input-id retry: empty response body")
    return response
  }

  let matched = isInputIdTooLongMessage(responseText)
  if (!matched) {
    try {
      const bodyPayload = JSON.parse(responseText)
      matched = isInputIdTooLongErrorBody(bodyPayload)
    } catch {
      matched = false
    }
  }

  debugLog("input-id retry detection", {
    matched,
    bodyPreview: responseText.slice(0, 200),
  })

  if (!matched) return response

  const sanitized = stripLongInputIds(requestPayload)
  if (sanitized === requestPayload) {
    debugLog("skip input-id retry: sanitize made no changes")
    return response
  }

  debugLog("input-id retry triggered", {
    removedLongIds: true,
    hadPreviousResponseId: typeof requestPayload.previous_response_id === "string",
  })

  const retried = await baseFetch(request, buildRetryInit(init, sanitized))
  debugLog("input-id retry response", {
    status: retried.status,
    contentType: retried.headers.get("content-type") ?? undefined,
  })
  return retried
}

function toRetryableSystemError(error: unknown): RetryableSystemError {
  const base = error instanceof Error ? error : new Error(String(error))
  const wrapped = new Error(`[copilot-network-retry normalized] ${base.message}`) as RetryableSystemError
  wrapped.name = base.name
  wrapped.code = "ECONNRESET"
  wrapped.syscall = "fetch"
  wrapped.cause = error
  return wrapped
}

function isCopilotUrl(request: Request | URL | string): boolean {
  const raw = request instanceof Request ? request.url : request instanceof URL ? request.href : String(request)

  try {
    const url = new URL(raw)
    return url.hostname === "api.githubcopilot.com" || url.hostname.startsWith("copilot-api.")
  } catch {
    return false
  }
}

function withStreamDebugLogs(response: Response, request: Request | URL | string): Response {
  if (!isDebugEnabled()) return response
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("text/event-stream") || !response.body) return response

  const rawUrl = request instanceof Request ? request.url : request instanceof URL ? request.href : String(request)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = response.body!.getReader()
      const pump = async () => {
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) {
              debugLog("sse stream finished", { url: rawUrl })
              controller.close()
              break
            }
            controller.enqueue(next.value)
          }
        } catch (error) {
          const message = getErrorMessage(error)
          debugLog("sse stream read error", {
            url: rawUrl,
            message,
            retryableByMessage: RETRYABLE_MESSAGES.some((part) => message.includes(part)),
          })
          controller.error(error)
        }
      }

      void pump()
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export function isRetryableCopilotFetchError(error: unknown): boolean {
  if (!error || isAbortError(error)) return false
  const message = getErrorMessage(error)
  return RETRYABLE_MESSAGES.some((part) => message.includes(part))
}

export function createCopilotRetryingFetch(baseFetch: FetchLike): FetchLike {
  return async function retryingFetch(request: Request | URL | string, init?: RequestInit): Promise<Response> {
    debugLog("fetch start", {
      url: request instanceof Request ? request.url : request instanceof URL ? request.href : String(request),
      isCopilot: isCopilotUrl(request),
    })

    try {
      const response = await baseFetch(request, init)
      debugLog("fetch resolved", {
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
      })

      if (isCopilotUrl(request)) {
        const retried = await maybeRetryInputIdTooLong(request, init, response, baseFetch)
        return withStreamDebugLogs(retried, request)
      }
      return response
    } catch (error) {
      debugLog("fetch threw", {
        message: getErrorMessage(error),
        retryableByMessage: isRetryableCopilotFetchError(error),
      })

      if (!isCopilotUrl(request) || !isRetryableCopilotFetchError(error)) {
        throw error
      }

      log("[copilot-network-retry] normalizing retryable error", {
        message: getErrorMessage(error),
      })

      throw toRetryableSystemError(error)
    }
  }
}
