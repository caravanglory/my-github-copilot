import color from "picocolors"

import { toAccountInfo } from "../features/copilot-account-switcher"
import type { AccountEntry, StoreFile } from "../features/copilot-account-switcher"

function formatQuota(s?: { remaining?: number; entitlement?: number; unlimited?: boolean }): string {
  if (!s) return color.dim("—")
  if (s.unlimited) return color.green("♾️")
  if (s.remaining !== undefined && s.entitlement !== undefined) {
    const pct = s.entitlement > 0 ? s.remaining / s.entitlement : 0
    const text = `${s.remaining}/${s.entitlement}`
    if (pct > 0.5) return color.green(text)
    if (pct > 0.2) return color.yellow(text)
    return color.red(text)
  }
  return color.dim("—")
}

export function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return color.dim("never")
  const days = Math.floor((Date.now() - timestamp) / 86400000)
  if (days === 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return new Date(timestamp).toLocaleDateString()
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

function padVisual(s: string, width: number): string {
  const visible = stripAnsi(s)
  return s + " ".repeat(Math.max(0, width - visible.length))
}

interface AccountRow {
  name: string
  status: string
  lastUsed: string
  premium: string
  chat: string
  completions: string
}

function buildAccountRows(store: StoreFile): AccountRow[] {
  return Object.entries(store.accounts).map(([name, entry], idx) => {
    const info = toAccountInfo(name, entry, idx, store.active)
    const nameStr = info.isCurrent ? color.green(color.bold(info.name)) : color.white(info.name)
    const statusStr = info.isCurrent
      ? color.green("active")
      : (info.status ?? "unknown") === "expired"
        ? color.red("expired")
        : color.dim("—")
    const lastUsed = entry.lastUsed ? formatRelativeTime(entry.lastUsed) : color.dim("—")
    const { premium, chat, completions } = entry.quota?.snapshots ?? {}
    return {
      name: nameStr,
      status: statusStr,
      lastUsed,
      premium: formatQuota(premium),
      chat: formatQuota(chat),
      completions: formatQuota(completions),
    }
  })
}

export function buildAccountLines(store: StoreFile): string {
  const entries = Object.entries(store.accounts)
  if (entries.length === 0) return color.dim("  No accounts configured. Add one to get started.")

  const rows = buildAccountRows(store)

  const headers = { name: "Name", status: "Status", lastUsed: "Last Used", premium: "Premium", chat: "Chat", completions: "Comp" }
  const keys = ["name", "status", "lastUsed", "premium", "chat", "completions"] as const
  const widths = Object.fromEntries(
    keys.map((k) => [k, Math.max(stripAnsi(headers[k]).length, ...rows.map((r) => stripAnsi(r[k]).length))]),
  ) as Record<(typeof keys)[number], number>

  const headerLine = keys.map((k) => padVisual(color.bold(headers[k]), widths[k])).join("  ")
  const separator = keys.map((k) => color.dim("─".repeat(widths[k]))).join("  ")
  const dataLines = rows.map((row) => keys.map((k) => padVisual(row[k], widths[k])).join("  "))

  return [headerLine, separator, ...dataLines].join("\n")
}

export function buildQuotaReport(store: StoreFile): string {
  const entries = Object.entries(store.accounts)
  if (entries.length === 0) return color.dim("No accounts configured — add an account first.")

  const lines: string[] = []
  for (const [name, entry] of entries) {
    if (entry.quota?.error) {
      lines.push(`  ${color.red("x")} ${color.white(name)}: ${color.red(entry.quota.error)}`)
    } else if (entry.quota?.snapshots) {
      const { premium, chat, completions } = entry.quota.snapshots
      const planInfo = [entry.quota.plan, entry.quota.sku].filter(Boolean).join(" / ") || "unknown plan"
      lines.push(`  ${color.green("*")} ${color.white(name)} ${color.dim(`(${planInfo})`)}`)
      lines.push(`    Premium:     ${formatQuota(premium)}`)
      lines.push(`    Chat:        ${formatQuota(chat)}`)
      lines.push(`    Completions: ${formatQuota(completions)}`)
      if (entry.quota.reset) lines.push(`    Resets:      ${color.cyan(entry.quota.reset)}`)
    } else {
      lines.push(`  ${color.dim("?")} ${color.white(name)}: ${color.dim("no quota data")}`)
    }
  }
  return lines.join("\n")
}

const MODEL_FAMILIES: Array<{ prefix: string; label: string }> = [
  { prefix: "claude-opus", label: "Opus" },
  { prefix: "claude-sonnet", label: "Sonnet" },
  { prefix: "claude-haiku", label: "Haiku" },
  { prefix: "gpt-5", label: "GPT-5" },
  { prefix: "gpt-4", label: "GPT-4" },
  { prefix: "gemini-3", label: "Gemini 3" },
  { prefix: "gemini-2", label: "Gemini 2" },
  { prefix: "grok", label: "Grok" },
]

function groupModelsByFamily(models: string[]): Array<{ label: string; models: string[] }> {
  const groups: Array<{ label: string; models: string[] }> = []
  const remaining = [...models]

  for (const family of MODEL_FAMILIES) {
    const matched = remaining.filter((m) => m.startsWith(family.prefix))
    if (matched.length > 0) {
      groups.push({ label: family.label, models: matched })
      for (const m of matched) remaining.splice(remaining.indexOf(m), 1)
    }
  }

  if (remaining.length > 0) {
    groups.push({ label: "Other", models: remaining })
  }

  return groups
}

export function buildModelReport(store: StoreFile): string {
  const entries = Object.entries(store.accounts)
  if (entries.length === 0) return color.dim("No accounts configured — add an account first.")

  const lines: string[] = []
  for (const [name, entry] of entries) {
    if (entry.models?.error) {
      lines.push(`  ${color.red("x")} ${color.white(name)}: ${color.red(entry.models.error)}`)
    } else if (entry.models) {
      const avail = entry.models.available.length
      const disabled = entry.models.disabled.length
      lines.push(`  ${color.green("*")} ${color.white(name)}: ${color.green(`${avail} available`)}, ${disabled > 0 ? color.yellow(`${disabled} disabled`) : color.dim(`${disabled} disabled`)}`)
      if (entry.models.available.length > 0) {
        const groups = groupModelsByFamily(entry.models.available)
        for (const group of groups) {
          lines.push(`    ${color.cyan(group.label.padEnd(10))} ${color.dim(group.models.join(", "))}`)
        }
      }
    } else {
      lines.push(`  ${color.dim("?")} ${color.white(name)}: ${color.dim("no model data")}`)
    }
  }
  return lines.join("\n")
}

export function buildAccountChoices(accounts: Record<string, AccountEntry>, active?: string): Array<{ value: string; label: string; hint?: string }> {
  return Object.entries(accounts).map(([name, entry]) => {
    const isCurrent = active === name
    const hint = [
      isCurrent ? "current" : undefined,
      entry.user ? `@${entry.user}` : undefined,
      entry.lastUsed ? formatRelativeTime(entry.lastUsed) : undefined,
    ]
      .filter(Boolean)
      .join(", ")
    return { value: name, label: name, hint: hint || undefined }
  })
}
