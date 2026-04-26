import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"

import type { AccountEntry, StoreFile } from "./types"

const STORE_FILENAME = "copilot-x.json"
const AUTH_FILENAME = "auth.json"

function getXdgConfigDir(): string {
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
}

function getXdgDataDir(): string {
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
}

export function storePath(): string {
  return path.join(getXdgConfigDir(), "opencode", STORE_FILENAME)
}

export function authPath(): string {
  return path.join(getXdgDataDir(), "opencode", AUTH_FILENAME)
}

export function parseStore(raw: string): StoreFile {
  const data = raw ? (JSON.parse(raw) as StoreFile) : ({ accounts: {} } as StoreFile)
  if (!data.accounts) data.accounts = {}
  if (data.loopSafetyEnabled !== true) data.loopSafetyEnabled = false
  if (data.networkRetryEnabled !== true) data.networkRetryEnabled = false
  for (const [name, entry] of Object.entries(data.accounts)) {
    if (!entry.name) entry.name = name
  }
  return data
}

export async function readStore(filePath = storePath()): Promise<StoreFile> {
  const raw = await fs.readFile(filePath, "utf-8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  return parseStore(raw)
}

export async function readStoreSafe(filePath = storePath()): Promise<StoreFile | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf-8")
    return parseStore(raw)
  } catch (error) {
    const issue = error as NodeJS.ErrnoException
    if (issue.code === "ENOENT") return parseStore("")
    return undefined
  }
}

export async function writeStore(store: StoreFile, filePath = storePath()): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), { mode: 0o600 })
}

export async function writeAuthEntry(entry: AccountEntry): Promise<void> {
  const filePath = path.join(getXdgDataDir(), "opencode", AUTH_FILENAME)

  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(filePath, "utf-8")
    existing = JSON.parse(raw) as Record<string, unknown>
  } catch {
    existing = {}
  }

  const providerId = entry.enterpriseUrl ? "github-copilot-enterprise" : "github-copilot"
  existing[providerId] = {
    type: "oauth",
    refresh: entry.refresh,
    access: entry.access,
    expires: entry.expires,
    ...(entry.enterpriseUrl ? { enterpriseUrl: entry.enterpriseUrl } : {}),
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(existing, null, 2), { mode: 0o600 })
}

export async function readAuth(filePath?: string): Promise<Record<string, AccountEntry>> {
  const dataFile = path.join(getXdgDataDir(), "opencode", AUTH_FILENAME)
  const configFile = path.join(getXdgConfigDir(), "opencode", AUTH_FILENAME)
  const files = filePath ? [filePath] : [dataFile, configFile]

  let raw = ""
  for (const file of files) {
    raw = await fs.readFile(file, "utf-8").catch(() => "")
    if (raw) break
  }
  if (!raw) return {}

  const parsed = JSON.parse(raw) as Record<string, unknown>
  const copilotKeys = new Set(["github-copilot", "github-copilot-enterprise"])
  return Object.entries(parsed).reduce(
    (acc, [key, value]) => {
      if (!copilotKeys.has(key)) return acc
      if (!value || typeof value !== "object") return acc
      const info = value as {
        type?: string
        refresh?: string
        access?: string
        expires?: number
        enterpriseUrl?: string
      }
      if (info.type !== "oauth" || !(info.refresh || info.access)) return acc
      acc[key] = {
        name: `auth:${key}`,
        refresh: info.refresh ?? info.access!,
        access: info.access ?? info.refresh!,
        expires: info.expires ?? 0,
        enterpriseUrl: info.enterpriseUrl,
        source: "auth",
        providerId: key,
      }
      return acc
    },
    {} as Record<string, AccountEntry>,
  )
}
