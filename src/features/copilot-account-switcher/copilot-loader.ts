import type { FetchLike } from "./types"

type RequestInfo = Request | URL | string

type AuthInfo = {
  type: string
  refresh?: string
  access?: string
  expires?: number
  enterpriseUrl?: string
}

type ProviderModel = {
  id?: string
  api: { url?: string; npm?: string }
  cost?: { input: number; output: number; cache: { read: number; write: number } }
}

type ProviderInput = {
  models?: Record<string, ProviderModel>
}

type LoaderResult = {
  baseURL?: string
  apiKey: string
  fetch: FetchLike
}

type Loader = (
  getAuth: () => Promise<AuthInfo | undefined>,
  provider?: ProviderInput,
) => Promise<LoaderResult | Record<string, never>>

const PLUGIN_VERSION = "snapshot"

function normalizeDomain(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function detectRequestContext(body: unknown, url: string): { isVision: boolean; isAgent: boolean } {
  try {
    const parsed = typeof body === "string" ? JSON.parse(body) : body
    if (!parsed || typeof parsed !== "object") return { isVision: false, isAgent: false }

    const record = parsed as Record<string, unknown>

    if (Array.isArray(record.messages) && url.includes("completions")) {
      const messages = record.messages as Array<{ role?: string; content?: unknown }>
      const last = messages[messages.length - 1]
      return {
        isVision: messages.some(
          (msg) =>
            Array.isArray(msg.content) &&
            (msg.content as Array<{ type?: string }>).some((part) => part.type === "image_url"),
        ),
        isAgent: last?.role !== "user",
      }
    }

    if (Array.isArray(record.input)) {
      const items = record.input as Array<{ role?: string; id?: string; content?: unknown }>
      const last = items[items.length - 1]
      return {
        isVision: items.some(
          (item) =>
            Array.isArray(item?.content) &&
            (item.content as Array<{ type?: string }>).some((part) => part.type === "input_image"),
        ),
        isAgent: last?.role !== "user",
      }
    }

    if (Array.isArray(record.messages)) {
      const messages = record.messages as Array<{ role?: string; content?: unknown }>
      const last = messages[messages.length - 1]
      const hasNonToolCalls =
        Array.isArray(last?.content) &&
        (last.content as Array<{ type?: string }>).some((part) => part?.type !== "tool_result")
      return {
        isVision: messages.some(
          (item) =>
            Array.isArray(item?.content) &&
            (item.content as Array<{ type?: string }>).some(
              (part) =>
                part?.type === "image" ||
                (part?.type === "tool_result" &&
                  Array.isArray((part as unknown as { content?: unknown[] }).content) &&
                  ((part as unknown as { content: Array<{ type?: string }> }).content).some(
                    (nested) => nested?.type === "image",
                  )),
            ),
        ),
        isAgent: !(last?.role === "user" && hasNonToolCalls),
      }
    }
  } catch {
    // ignore parse errors
  }
  return { isVision: false, isAgent: false }
}

export function createOfficialCopilotLoader(options?: {
  fetchImpl?: FetchLike
  version?: string
}): Loader {
  const fetchImpl = options?.fetchImpl ?? fetch
  const version = options?.version ?? PLUGIN_VERSION

  return async function loader(
    getAuth: () => Promise<AuthInfo | undefined>,
    provider?: ProviderInput,
  ): Promise<LoaderResult | Record<string, never>> {
    const info = await getAuth()
    if (!info || info.type !== "oauth") return {}

    const enterpriseUrl = info.enterpriseUrl
    const baseURL = enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : undefined

    if (provider?.models) {
      for (const model of Object.values(provider.models)) {
        model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        model.api.npm = "@ai-sdk/github-copilot"
      }
    }

    return {
      baseURL,
      apiKey: "",
      async fetch(request: RequestInfo, init?: RequestInit): Promise<Response> {
        const info = await getAuth()
        if (!info || info.type !== "oauth") return fetchImpl(request, init)

        const url = request instanceof URL ? request.href : request.toString()
        const { isVision, isAgent } = detectRequestContext(init?.body, url)

        const headers: Record<string, string> = {
          "x-initiator": isAgent ? "agent" : "user",
          ...(init?.headers as Record<string, string>),
          "User-Agent": `opencode/${version}`,
          Authorization: `Bearer ${info.refresh}`,
          "Openai-Intent": "conversation-edits",
        }

        if (isVision) {
          headers["Copilot-Vision-Request"] = "true"
        }

        delete headers["x-api-key"]
        delete headers["authorization"]

        return fetchImpl(request, { ...init, headers })
      },
    }
  }
}

export type { AuthInfo as CopilotAuthState, ProviderInput as CopilotProviderConfig, LoaderResult as OfficialCopilotConfig }

export async function loadOfficialCopilotConfig(input: {
  getAuth: () => Promise<AuthInfo | undefined>
  baseFetch?: FetchLike
  provider?: ProviderInput
  version?: string
}): Promise<LoaderResult | undefined> {
  const loader = createOfficialCopilotLoader({
    fetchImpl: input.baseFetch,
    version: input.version,
  })
  const result = await loader(input.getAuth, input.provider)

  if (!("fetch" in result) || typeof result.fetch !== "function") {
    return undefined
  }

  return {
    baseURL: (result as LoaderResult).baseURL,
    apiKey: (result as LoaderResult).apiKey,
    fetch: (result as LoaderResult).fetch,
  }
}
