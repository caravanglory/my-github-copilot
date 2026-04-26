import { log } from "../../logger"

import { readAuth, readStore, writeAuthEntry, writeStore } from "./store"
import { fetchModels, fetchQuota, fetchUser } from "./copilot-auth"
import type { AccountEntry, AccountInfo, StoreFile } from "./types"

type AuthClient = {
  auth: {
    set: (input: {
      path: { id: string }
      body: {
        type: "oauth"
        refresh: string
        access: string
        expires: number
        enterpriseUrl?: string
      }
    }) => Promise<unknown>
  }
}

function normalizeDomain(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function buildName(entry: AccountEntry, login?: string): string {
  const user = login ?? entry.user
  if (!user) return entry.name
  if (!entry.enterpriseUrl) return user
  const host = normalizeDomain(entry.enterpriseUrl)
  return `${host}:${user}`
}

function score(entry: AccountEntry): number {
  return (entry.user ? 2 : 0) + (entry.email ? 2 : 0) + (entry.orgs?.length ? 1 : 0)
}

function dedupeKey(entry: AccountEntry): string | undefined {
  if (entry.refresh) return `refresh:${entry.refresh}`
  return undefined
}

export function toAccountInfo(
  name: string,
  entry: AccountEntry,
  index: number,
  active?: string,
): AccountInfo {
  const status = entry.expires && entry.expires > 0 && entry.expires < Date.now() ? "expired" : "active"
  const labelName = name.startsWith("github.com:") ? name.slice("github.com:".length) : name
  const hasUser = entry.user ? labelName.includes(entry.user) : false
  const suffix = entry.user
    ? hasUser
      ? ""
      : ` (${entry.user})`
    : entry.email
      ? ` (${entry.email})`
      : ""
  const label = `${labelName}${suffix}`

  return {
    name: label,
    index,
    addedAt: entry.addedAt,
    lastUsed: entry.lastUsed,
    status,
    isCurrent: active === name,
  }
}

export function dedupeAccounts(store: StoreFile): void {
  const seen = new Map<string, string>()
  for (const [name, entry] of Object.entries(store.accounts)) {
    const k = dedupeKey(entry)
    if (!k) continue
    const current = seen.get(k)
    if (!current) {
      seen.set(k, name)
      continue
    }
    const currentEntry = store.accounts[current]
    if (score(entry) > score(currentEntry)) {
      delete store.accounts[current]
      seen.set(k, name)
      if (store.active === current) store.active = name
      continue
    }
    delete store.accounts[name]
    if (store.active === name) store.active = current
  }
}

export function mergeAuthEntries(
  store: StoreFile,
  imported: Array<[string, AccountEntry]>,
): void {
  dedupeAccounts(store)
  const byRefresh = new Map<string, string>()
  for (const [name, entry] of Object.entries(store.accounts)) {
    if (entry.refresh) byRefresh.set(entry.refresh, name)
  }
  for (const [key, entry] of imported) {
    const match = byRefresh.get(entry.refresh)
    if (match) {
      store.accounts[match] = {
        ...store.accounts[match],
        ...entry,
        name: store.accounts[match].name,
        source: "auth",
        providerId: key,
      }
      if (!store.active) store.active = match
      continue
    }
    const name = entry.name || `auth:${key}`
    store.accounts[name] = {
      ...entry,
      name,
      source: "auth",
      providerId: key,
    }
    if (!store.active) store.active = name
  }
}

export async function importFromAuth(authFilePath?: string): Promise<{
  store: StoreFile
  imported: number
}> {
  const store = await readStore()
  const authEntries = await readAuth(authFilePath)
  const entries = Object.entries(authEntries)
  mergeAuthEntries(store, entries)
  await writeStore(store)
  return { store, imported: entries.length }
}

export async function switchAccount(accountName: string, client?: AuthClient): Promise<StoreFile> {
  const store = await readStore()
  if (!store.accounts[accountName]) {
    throw new Error(`Account not found: ${accountName}`)
  }
  store.active = accountName
  store.accounts[accountName].lastUsed = Date.now()
  store.lastAccountSwitchAt = Date.now()
  await writeStore(store)
  await writeAuthEntry(store.accounts[accountName])
  if (client) {
    await switchAccountWithClient(client, store.accounts[accountName])
  }
  return store
}

export async function removeAccount(accountName: string): Promise<StoreFile> {
  const store = await readStore()
  delete store.accounts[accountName]
  if (store.active === accountName) {
    const remaining = Object.keys(store.accounts)
    store.active = remaining.length > 0 ? remaining[0] : undefined
  }
  await writeStore(store)
  return store
}

export async function removeAllAccounts(): Promise<StoreFile> {
  const store = await readStore()
  store.accounts = {}
  store.active = undefined
  await writeStore(store)
  return store
}

export async function addAccount(entry: AccountEntry): Promise<StoreFile> {
  const store = await readStore()
  const name = entry.name || `account-${Object.keys(store.accounts).length + 1}`
  store.accounts[name] = { ...entry, name }
  if (!store.active) store.active = name
  await writeStore(store)
  return store
}

export async function checkQuotas(): Promise<StoreFile> {
  const store = await readStore()
  for (const [, entry] of Object.entries(store.accounts)) {
    const quota = await fetchQuota(entry)
    if (quota) entry.quota = quota
  }
  store.lastQuotaRefresh = Date.now()
  await writeStore(store)
  return store
}

export async function checkModels(): Promise<StoreFile> {
  const store = await readStore()
  for (const [, entry] of Object.entries(store.accounts)) {
    const result = await fetchModels(entry)
    if ("error" in result) {
      entry.models = { available: [], disabled: [], error: result.error, updatedAt: Date.now() }
    } else {
      entry.models = { ...result, updatedAt: Date.now() }
    }
  }
  await writeStore(store)
  return store
}

export async function refreshIdentity(): Promise<StoreFile> {
  const store = await readStore()
  const items = await Promise.all(
    Object.entries(store.accounts).map(async ([name, entry]) => {
      const user = await fetchUser(entry)
      const base = buildName(entry, user?.login ?? entry.user)
      return {
        oldName: name,
        base,
        entry: {
          ...entry,
          user: user?.login ?? entry.user,
          email: user?.email ?? entry.email,
          orgs: user?.orgs ?? entry.orgs,
          name: base,
        },
      }
    }),
  )

  const counts = new Map<string, number>()
  const renamed = items.map((item) => {
    const count = (counts.get(item.base) ?? 0) + 1
    counts.set(item.base, count)
    const name = count === 1 ? item.base : `${item.base}#${count}`
    return { ...item, name, entry: { ...item.entry, name } }
  })

  store.accounts = renamed.reduce(
    (acc, item) => {
      acc[item.name] = item.entry
      return acc
    },
    {} as Record<string, AccountEntry>,
  )

  const active = renamed.find((item) => item.oldName === store.active)
  if (active) store.active = active.name

  await writeStore(store)
  return store
}

export async function toggleLoopSafety(): Promise<StoreFile> {
  const store = await readStore()
  store.loopSafetyEnabled = store.loopSafetyEnabled !== true
  await writeStore(store)
  log("[copilot-account-switcher] loop safety toggled", {
    enabled: store.loopSafetyEnabled,
  })
  return store
}

export async function switchAccountWithClient(client: AuthClient, entry: AccountEntry): Promise<void> {
  const providerId = entry.enterpriseUrl ? "github-copilot-enterprise" : "github-copilot"
  const payload = {
    type: "oauth" as const,
    refresh: entry.refresh,
    access: entry.access,
    expires: entry.expires,
    ...(entry.enterpriseUrl ? { enterpriseUrl: entry.enterpriseUrl } : {}),
  }
  try {
    await client.auth.set({
      path: { id: providerId },
      body: payload,
    })
    log("[copilot-account-switcher] runtime auth state updated", { provider: providerId })
  } catch (error) {
    log("[copilot-account-switcher] failed to update runtime auth state", { error: String(error) })
  }
}

export async function toggleAutoRefresh(): Promise<StoreFile> {
  const store = await readStore()
  store.autoRefresh = store.autoRefresh !== true
  store.refreshMinutes = store.refreshMinutes ?? 15
  await writeStore(store)
  log("[copilot-account-switcher] auto-refresh toggled", {
    enabled: store.autoRefresh,
    minutes: store.refreshMinutes,
  })
  return store
}

export async function setRefreshInterval(minutes: number): Promise<StoreFile> {
  const store = await readStore()
  store.refreshMinutes = Math.max(1, Math.min(180, minutes))
  await writeStore(store)
  log("[copilot-account-switcher] refresh interval set", {
    minutes: store.refreshMinutes,
  })
  return store
}

export async function toggleNetworkRetry(): Promise<StoreFile> {
  const store = await readStore()
  store.networkRetryEnabled = store.networkRetryEnabled !== true
  await writeStore(store)
  log("[copilot-account-switcher] network retry toggled", {
    enabled: store.networkRetryEnabled,
  })
  return store
}

export async function getActiveAccount(): Promise<{
  name: string
  entry: AccountEntry
} | undefined> {
  const store = await readStore()
  if (!store.active || !store.accounts[store.active]) return undefined
  return { name: store.active, entry: store.accounts[store.active] }
}
