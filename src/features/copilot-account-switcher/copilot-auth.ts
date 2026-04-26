import { log } from "../../logger"

import type { AccountEntry, GitHubUserInfo, QuotaSnapshot } from "./types"

const CLIENT_ID = "Ov23li8tweQw6odWQebz"
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000

export function getGitHubToken(entry: AccountEntry): string {
  const ghPrefixes = ["ghu_", "gho_", "ghp_", "github_pat_"]
  const isGhToken = (t: string) => ghPrefixes.some((p) => t.startsWith(p))

  if (entry.access && isGhToken(entry.access)) return entry.access
  if (entry.refresh && isGhToken(entry.refresh)) return entry.refresh
  if (entry.refresh?.startsWith("ghr_") && entry.access && !entry.access.startsWith("ghr_")) {
    return entry.access
  }
  return entry.refresh || entry.access
}

function isTokenExpired(entry: AccountEntry): boolean {
  if (!entry.expires || entry.expires <= 0) return false
  return entry.expires < Date.now() + TOKEN_EXPIRY_BUFFER_MS
}

export async function refreshAccessToken(entry: AccountEntry): Promise<boolean> {
  if (!entry.refresh?.startsWith("ghr_")) return false

  const domain = entry.enterpriseUrl ? normalizeDomain(entry.enterpriseUrl) : "github.com"
  const url = `https://${domain}/login/oauth/access_token`

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: entry.refresh,
      }),
    })

    if (!res.ok) {
      log("[copilot-auth] token refresh HTTP error", { status: res.status })
      return false
    }

    const data = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      error?: string
    }

    if (data.error || !data.access_token) {
      log("[copilot-auth] token refresh failed", { error: data.error })
      return false
    }

    entry.access = data.access_token
    if (data.refresh_token) entry.refresh = data.refresh_token
    entry.expires = data.expires_in
      ? Date.now() + data.expires_in * 1000
      : 0

    log("[copilot-auth] token refreshed successfully")
    return true
  } catch (error) {
    log("[copilot-auth] token refresh error", { error: String(error) })
    return false
  }
}

function hasUnknownExpiry(entry: AccountEntry): boolean {
  return !entry.expires || entry.expires <= 0
}

export async function getValidToken(entry: AccountEntry): Promise<string> {
  if (entry.refresh?.startsWith("ghr_") && (isTokenExpired(entry) || hasUnknownExpiry(entry))) {
    await refreshAccessToken(entry)
  }
  return getGitHubToken(entry)
}

function normalizeDomain(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function getUrls(domain: string): { DEVICE_CODE_URL: string; ACCESS_TOKEN_URL: string } {
  return {
    DEVICE_CODE_URL: `https://${domain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildSnapshot(raw?: {
  entitlement?: number
  remaining?: number
  used?: number
  unlimited?: boolean
  percent_remaining?: number
}): QuotaSnapshot | undefined {
  if (!raw) return undefined
  const entitlement = raw.entitlement
  const remaining = raw.remaining
  const used =
    raw.used ?? (entitlement !== undefined && remaining !== undefined ? entitlement - remaining : undefined)
  return {
    entitlement,
    remaining,
    used,
    unlimited: raw.unlimited,
    percentRemaining: raw.percent_remaining,
  }
}

export async function fetchUser(entry: AccountEntry): Promise<GitHubUserInfo | undefined> {
  try {
    const token = await getValidToken(entry)
    const base = entry.enterpriseUrl
      ? `https://api.${normalizeDomain(entry.enterpriseUrl)}`
      : "https://api.github.com"

    const headers = {
      Accept: "application/json",
      Authorization: `token ${token}`,
    }

    const userRes = await fetch(`${base}/user`, { headers })
    if (!userRes.ok) return undefined

    const userData = (await userRes.json()) as { login?: string; email?: string }
    const login = userData.login
    let email = userData.email

    if (!email) {
      try {
        const emailRes = await fetch(`${base}/user/emails`, { headers })
        if (emailRes.ok) {
          const items = (await emailRes.json()) as Array<{ email?: string; primary?: boolean; verified?: boolean }>
          const primary = items.find((item) => item.primary && item.verified)
          email = primary?.email ?? items[0]?.email
        }
      } catch {
        log("[copilot-auth] failed to fetch emails")
      }
    }

    let orgs: string[] = []
    try {
      const orgsRes = await fetch(`${base}/user/orgs`, { headers })
      if (orgsRes.ok) {
        const orgsData = (await orgsRes.json()) as Array<{ login?: string }>
        orgs = orgsData.map((o) => o.login).filter(Boolean) as string[]
      }
    } catch {
      log("[copilot-auth] failed to fetch orgs")
    }

    return { login, email, orgs }
  } catch (error) {
    log("[copilot-auth] fetchUser failed", { error: String(error) })
    return undefined
  }
}

export async function fetchQuota(
  entry: AccountEntry,
): Promise<AccountEntry["quota"] | undefined> {
  try {
    const token = await getValidToken(entry)
    const headers = {
      Accept: "application/json",
      Authorization: `token ${token}`,
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "Editor-Version": "vscode/1.96.2",
      "Copilot-Integration-Id": "vscode-chat",
      "X-Github-Api-Version": "2025-04-01",
    }
    const base = entry.enterpriseUrl
      ? `https://api.${normalizeDomain(entry.enterpriseUrl)}`
      : "https://api.github.com"

    const res = await fetch(`${base}/copilot_internal/user`, { headers })
    if (!res.ok) {
      return { error: `quota ${res.status}`, updatedAt: Date.now() }
    }

    const data = (await res.json()) as {
      access_type_sku?: string
      copilot_plan?: string
      quota_reset_date?: string
      quota_snapshots?: {
        premium_interactions?: {
          entitlement?: number
          remaining?: number
          used?: number
          unlimited?: boolean
          percent_remaining?: number
        }
        chat?: {
          entitlement?: number
          remaining?: number
          used?: number
          unlimited?: boolean
          percent_remaining?: number
        }
        completions?: {
          entitlement?: number
          remaining?: number
          used?: number
          unlimited?: boolean
          percent_remaining?: number
        }
      }
    }

    return {
      sku: data.access_type_sku,
      plan: data.copilot_plan,
      reset: data.quota_reset_date,
      updatedAt: Date.now(),
      snapshots: {
        premium: buildSnapshot(data.quota_snapshots?.premium_interactions),
        chat: buildSnapshot(data.quota_snapshots?.chat),
        completions: buildSnapshot(data.quota_snapshots?.completions),
      },
    }
  } catch (error) {
    log("[copilot-auth] fetchQuota failed", { error: String(error) })
    return { error: String(error), updatedAt: Date.now() }
  }
}

type ModelData = {
  data?: Array<{ id?: string; model_picker_enabled?: boolean; policy?: { state?: string } }>
}

function parseModels(modelData: ModelData): { available: string[]; disabled: string[] } {
  const available: string[] = []
  const disabled: string[] = []
  for (const item of modelData.data ?? []) {
    if (!item.id) continue
    const enabled = item.model_picker_enabled === true && item.policy?.state !== "disabled"
    if (enabled) available.push(item.id)
    else disabled.push(item.id)
  }
  return { available, disabled }
}

export async function fetchModels(
  entry: AccountEntry,
): Promise<{ available: string[]; disabled: string[] } | { error: string }> {
  try {
    const modelsUrl = entry.enterpriseUrl
      ? `https://copilot-api.${normalizeDomain(entry.enterpriseUrl)}/models`
      : "https://api.githubcopilot.com/models"

    const modelsHeaders = {
      Accept: "application/json",
      Authorization: `Bearer ${entry.access}`,
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot/1.159.0",
      "Copilot-Integration-Id": "vscode-chat",
      "X-Github-Api-Version": "2025-04-01",
    }

    const modelRes = await fetch(modelsUrl, { headers: modelsHeaders })
    if (modelRes.ok) {
      return parseModels((await modelRes.json()) as ModelData)
    }

    const token = await getValidToken(entry)
    const base = entry.enterpriseUrl
      ? `https://api.${normalizeDomain(entry.enterpriseUrl)}`
      : "https://api.github.com"

    const tokenRes = await fetch(`${base}/copilot_internal/v2/token`, {
      headers: {
        Accept: "application/json",
        Authorization: `token ${token}`,
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "Editor-Version": "vscode/1.96.2",
        "Editor-Plugin-Version": "copilot/1.159.0",
        "X-Github-Api-Version": "2025-04-01",
      },
    })
    if (!tokenRes.ok) return { error: `token ${tokenRes.status}` }

    const tokenData = (await tokenRes.json()) as { token?: string; expires_at?: number }
    if (!tokenData.token) return { error: "token missing" }

    entry.access = tokenData.token
    if (tokenData.expires_at) entry.expires = tokenData.expires_at * 1000

    const fallbackRes = await fetch(modelsUrl, {
      headers: {
        ...modelsHeaders,
        Authorization: `Bearer ${tokenData.token}`,
      },
    })
    if (!fallbackRes.ok) return { error: `models ${fallbackRes.status}` }

    return parseModels((await fallbackRes.json()) as ModelData)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function loginOauth(
  deployment: "github.com" | "enterprise",
  enterpriseUrl?: string,
): Promise<AccountEntry> {
  const domain = deployment === "enterprise" ? normalizeDomain(enterpriseUrl ?? "") : "github.com"
  const urls = getUrls(domain)

  const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: "read:user user:email",
    }),
  })

  if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

  const deviceData = (await deviceResponse.json()) as {
    verification_uri: string
    user_code: string
    device_code: string
    interval: number
  }

  console.log(`Go to: ${deviceData.verification_uri}`)
  console.log(`Enter code: ${deviceData.user_code}`)

  while (true) {
    const response = await fetch(urls.ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceData.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })

    if (!response.ok) throw new Error("Failed to poll token")

    const data = (await response.json()) as {
      access_token?: string
      error?: string
      interval?: number
    }

    if (data.access_token) {
      const entry: AccountEntry = {
        name: deployment === "enterprise" ? `enterprise:${domain}` : "github.com",
        refresh: data.access_token,
        access: data.access_token,
        expires: 0,
        enterpriseUrl: deployment === "enterprise" ? domain : undefined,
        addedAt: Date.now(),
        source: "auth",
      }
      const user = await fetchUser(entry)
      if (user?.login) entry.user = user.login
      if (user?.email) entry.email = user.email
      if (user?.orgs?.length) entry.orgs = user.orgs
      return entry
    }

    if (data.error === "authorization_pending") {
      await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
      continue
    }

    if (data.error === "slow_down") {
      const serverInterval = data.interval
      const next = (serverInterval && serverInterval > 0 ? serverInterval : deviceData.interval + 5) * 1000
      await sleep(next + OAUTH_POLLING_SAFETY_MARGIN_MS)
      continue
    }

    throw new Error("Authorization failed")
  }
}
