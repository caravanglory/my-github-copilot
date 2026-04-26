import { describe, expect, test } from "bun:test"

import { parseStore, storePath, authPath } from "./features/copilot-account-switcher/store"
import {
  toAccountInfo,
  dedupeAccounts,
  mergeAuthEntries,
} from "./features/copilot-account-switcher/account-manager"
import { getGitHubToken } from "./features/copilot-account-switcher/copilot-auth"
import { isRetryableCopilotFetchError } from "./features/copilot-account-switcher/copilot-network-retry"
import { isWithinPostSwitchWindow } from "./features/copilot-account-switcher/copilot-session-repair"
import {
  applyLoopSafetyPolicy,
  isCopilotProvider,
  LOOP_SAFETY_POLICY,
} from "./features/copilot-account-switcher/loop-safety-policy"
import {
  buildAccountChoices,
  buildAccountLines,
  buildModelReport,
  formatRelativeTime,
} from "./cli/copilot-account-display"
import type { AccountEntry, StoreFile } from "./features/copilot-account-switcher/types"

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<AccountEntry> = {}): AccountEntry {
  return {
    name: "test-account",
    refresh: "gho_testrefresh",
    access: "gho_testaccess",
    expires: 0,
    ...overrides,
  }
}

function makeStore(overrides: Partial<StoreFile> = {}): StoreFile {
  return {
    accounts: {},
    ...overrides,
  }
}

// ─── parseStore ───────────────────────────────────────────────────────────────

describe("parseStore", () => {
  test("returns empty accounts for empty string", () => {
    const store = parseStore("")
    expect(store.accounts).toEqual({})
    expect(store.loopSafetyEnabled).toBe(false)
    expect(store.networkRetryEnabled).toBe(false)
  })

  test("parses valid JSON", () => {
    const raw = JSON.stringify({
      active: "alice",
      accounts: {
        alice: makeEntry({ name: "alice" }),
      },
    })
    const store = parseStore(raw)
    expect(store.active).toBe("alice")
    expect(store.accounts["alice"]).toBeDefined()
  })

  test("backfills entry.name from key when missing", () => {
    const raw = JSON.stringify({
      accounts: {
        bob: { refresh: "gho_x", access: "gho_x", expires: 0 },
      },
    })
    const store = parseStore(raw)
    expect(store.accounts["bob"].name).toBe("bob")
  })

  test("defaults loopSafetyEnabled and networkRetryEnabled to false", () => {
    const raw = JSON.stringify({ accounts: {}, loopSafetyEnabled: null, networkRetryEnabled: undefined })
    const store = parseStore(raw)
    expect(store.loopSafetyEnabled).toBe(false)
    expect(store.networkRetryEnabled).toBe(false)
  })
})

// ─── storePath / authPath ─────────────────────────────────────────────────────

describe("storePath / authPath", () => {
  test("storePath contains opencode/copilot-x.json", () => {
    expect(storePath()).toContain("opencode")
    expect(storePath()).toContain("copilot-x.json")
  })

  test("authPath contains opencode/auth.json", () => {
    expect(authPath()).toContain("opencode")
    expect(authPath()).toContain("auth.json")
  })
})

// ─── toAccountInfo ────────────────────────────────────────────────────────────

describe("toAccountInfo", () => {
  test("marks current account", () => {
    const entry = makeEntry({ name: "alice" })
    const info = toAccountInfo("alice", entry, 0, "alice")
    expect(info.isCurrent).toBe(true)
  })

  test("non-active account is not current", () => {
    const info = toAccountInfo("bob", makeEntry(), 1, "alice")
    expect(info.isCurrent).toBe(false)
  })

  test("expired account status", () => {
    const entry = makeEntry({ expires: Date.now() - 1000 })
    const info = toAccountInfo("old", entry, 0)
    expect(info.status).toBe("expired")
  })

  test("active account status when expires is 0", () => {
    const info = toAccountInfo("fresh", makeEntry({ expires: 0 }), 0)
    expect(info.status).toBe("active")
  })

  test("strips github.com: prefix from name", () => {
    const info = toAccountInfo("github.com:alice", makeEntry(), 0)
    expect(info.name).toBe("alice")
  })

  test("appends user in parentheses when not in name", () => {
    const info = toAccountInfo("myname", makeEntry({ user: "gh-alice" }), 0)
    expect(info.name).toContain("(gh-alice)")
  })
})

// ─── dedupeAccounts ───────────────────────────────────────────────────────────

describe("dedupeAccounts", () => {
  test("removes lower-score duplicate", () => {
    const store = makeStore({
      accounts: {
        a: makeEntry({ name: "a", refresh: "gho_same" }),
        b: makeEntry({ name: "b", refresh: "gho_same", user: "alice", email: "a@x.com" }),
      },
    })
    dedupeAccounts(store)
    expect(Object.keys(store.accounts)).toHaveLength(1)
    expect(store.accounts["b"]).toBeDefined()
  })

  test("updates active to winner", () => {
    const store = makeStore({
      active: "a",
      accounts: {
        a: makeEntry({ name: "a", refresh: "gho_same" }),
        b: makeEntry({ name: "b", refresh: "gho_same", user: "alice" }),
      },
    })
    dedupeAccounts(store)
    expect(store.active).toBe("b")
  })

  test("no-op when refreshes are distinct", () => {
    const store = makeStore({
      accounts: {
        a: makeEntry({ name: "a", refresh: "gho_aaa" }),
        b: makeEntry({ name: "b", refresh: "gho_bbb" }),
      },
    })
    dedupeAccounts(store)
    expect(Object.keys(store.accounts)).toHaveLength(2)
  })
})

// ─── mergeAuthEntries ─────────────────────────────────────────────────────────

describe("mergeAuthEntries", () => {
  test("imports a new account", () => {
    const store = makeStore()
    const entry = makeEntry({ name: "auth:github-copilot", refresh: "gho_new" })
    mergeAuthEntries(store, [["github-copilot", entry]])
    expect(Object.keys(store.accounts)).toHaveLength(1)
  })

  test("sets active when store has none", () => {
    const store = makeStore()
    mergeAuthEntries(store, [["github-copilot", makeEntry({ name: "auth:github-copilot", refresh: "gho_x" })]])
    expect(store.active).toBeDefined()
  })

  test("merges into existing entry with same refresh", () => {
    const store = makeStore({
      accounts: {
        "my-account": makeEntry({ name: "my-account", refresh: "gho_shared" }),
      },
    })
    const newEntry = makeEntry({ name: "auth:github-copilot", refresh: "gho_shared", user: "alice" })
    mergeAuthEntries(store, [["github-copilot", newEntry]])
    // Still one account, not two
    expect(Object.keys(store.accounts)).toHaveLength(1)
    // Name is preserved from existing
    expect(store.accounts["my-account"]).toBeDefined()
  })
})

// ─── getGitHubToken ───────────────────────────────────────────────────────────

describe("getGitHubToken", () => {
  test("returns access when it starts with gho_", () => {
    const token = getGitHubToken(makeEntry({ access: "gho_abc", refresh: "ghr_xyz" }))
    expect(token).toBe("gho_abc")
  })

  test("returns refresh when it starts with gho_ and access does not", () => {
    const token = getGitHubToken(makeEntry({ refresh: "gho_refresh", access: "some-other" }))
    expect(token).toBe("gho_refresh")
  })

  test("returns access (not ghr_) when refresh is ghr_", () => {
    const token = getGitHubToken(makeEntry({ refresh: "ghr_x", access: "gho_access" }))
    expect(token).toBe("gho_access")
  })

  test("falls back to refresh when neither is a gh token", () => {
    const token = getGitHubToken(makeEntry({ refresh: "opaque-refresh", access: "opaque-access" }))
    expect(token).toBe("opaque-refresh")
  })
})

// ─── isRetryableCopilotFetchError ─────────────────────────────────────────────

describe("isRetryableCopilotFetchError", () => {
  test("returns false for null/undefined", () => {
    expect(isRetryableCopilotFetchError(null)).toBe(false)
    expect(isRetryableCopilotFetchError(undefined)).toBe(false)
  })

  test("returns false for AbortError", () => {
    const err = new Error("aborted")
    err.name = "AbortError"
    expect(isRetryableCopilotFetchError(err)).toBe(false)
  })

  test("returns true for network errors", () => {
    expect(isRetryableCopilotFetchError(new Error("load failed"))).toBe(true)
    expect(isRetryableCopilotFetchError(new Error("Failed to fetch"))).toBe(true)
    expect(isRetryableCopilotFetchError(new Error("ECONNRESET happened"))).toBe(true)
    expect(isRetryableCopilotFetchError(new Error("socket hang up"))).toBe(true)
  })

  test("returns false for non-retryable errors", () => {
    expect(isRetryableCopilotFetchError(new Error("404 not found"))).toBe(false)
    expect(isRetryableCopilotFetchError(new Error("invalid json"))).toBe(false)
  })
})

// ─── isWithinPostSwitchWindow ─────────────────────────────────────────────────

describe("isWithinPostSwitchWindow", () => {
  test("returns true when switch was recent", () => {
    expect(isWithinPostSwitchWindow(Date.now() - 1000)).toBe(true)
  })

  test("returns false when switch was long ago", () => {
    expect(isWithinPostSwitchWindow(Date.now() - 10 * 60 * 1000)).toBe(false)
  })

  test("respects custom window", () => {
    const switchedAt = Date.now() - 2000
    expect(isWithinPostSwitchWindow(switchedAt, 1000)).toBe(false)
    expect(isWithinPostSwitchWindow(switchedAt, 5000)).toBe(true)
  })
})

// ─── loop-safety-policy ───────────────────────────────────────────────────────

describe("isCopilotProvider", () => {
  test("recognises copilot providers", () => {
    expect(isCopilotProvider("github-copilot")).toBe(true)
    expect(isCopilotProvider("github-copilot-enterprise")).toBe(true)
  })

  test("rejects other providers", () => {
    expect(isCopilotProvider("openai")).toBe(false)
    expect(isCopilotProvider("anthropic")).toBe(false)
  })
})

describe("applyLoopSafetyPolicy", () => {
  test("no-op when disabled", () => {
    const system = ["baseline"]
    const result = applyLoopSafetyPolicy({ providerID: "github-copilot", enabled: false, system })
    expect(result).toEqual(system)
  })

  test("no-op for non-copilot provider", () => {
    const system = ["baseline"]
    const result = applyLoopSafetyPolicy({ providerID: "openai", enabled: true, system })
    expect(result).toEqual(system)
  })

  test("appends policy when enabled for copilot", () => {
    const result = applyLoopSafetyPolicy({ providerID: "github-copilot", enabled: true, system: [] })
    expect(result).toContain(LOOP_SAFETY_POLICY)
  })

  test("does not double-append if policy already present", () => {
    const system = [LOOP_SAFETY_POLICY]
    const result = applyLoopSafetyPolicy({ providerID: "github-copilot", enabled: true, system })
    expect(result).toHaveLength(1)
  })
})

// ─── display helpers ──────────────────────────────────────────────────────────

describe("formatRelativeTime", () => {
  test("returns 'today' for recent timestamp", () => {
    expect(formatRelativeTime(Date.now() - 1000)).toBe("today")
  })

  test("returns dim 'never' for undefined", () => {
    // strip ansi for comparison
    const result = formatRelativeTime(undefined).replace(/\x1b\[[0-9;]*m/g, "")
    expect(result).toBe("never")
  })

  test("returns 'yesterday' for ~1 day ago", () => {
    expect(formatRelativeTime(Date.now() - 86400000 * 1.5)).toBe("yesterday")
  })

  test("returns Nd ago within a week", () => {
    expect(formatRelativeTime(Date.now() - 86400000 * 3)).toBe("3d ago")
  })
})

describe("buildAccountChoices", () => {
  test("returns empty array for no accounts", () => {
    expect(buildAccountChoices({}, undefined)).toEqual([])
  })

  test("includes current hint", () => {
    const accounts = { alice: makeEntry({ name: "alice" }) }
    const choices = buildAccountChoices(accounts, "alice")
    expect(choices[0].hint).toContain("current")
  })

  test("includes @user hint when user is set", () => {
    const accounts = { alice: makeEntry({ user: "gh-alice" }) }
    const choices = buildAccountChoices(accounts, undefined)
    expect(choices[0].hint).toContain("@gh-alice")
  })
})

describe("buildAccountLines", () => {
  test("shows placeholder when no accounts", () => {
    const store = makeStore()
    const result = buildAccountLines(store).replace(/\x1b\[[0-9;]*m/g, "")
    expect(result).toContain("No accounts configured")
  })

  test("renders header row with account name", () => {
    const store = makeStore({
      active: "alice",
      accounts: { alice: makeEntry({ name: "alice", user: "gh-alice" }) },
    })
    const result = buildAccountLines(store).replace(/\x1b\[[0-9;]*m/g, "")
    expect(result).toContain("Name")
    expect(result).toContain("Status")
    expect(result).toContain("alice")
  })
})

describe("buildModelReport", () => {
  test("shows placeholder when no accounts", () => {
    const result = buildModelReport(makeStore()).replace(/\x1b\[[0-9;]*m/g, "")
    expect(result).toContain("No accounts configured")
  })

  test("shows model counts", () => {
    const store = makeStore({
      accounts: {
        alice: makeEntry({
          models: {
            available: ["claude-sonnet-4", "gpt-4o"],
            disabled: ["old-model"],
            updatedAt: Date.now(),
          },
        }),
      },
    })
    const result = buildModelReport(store).replace(/\x1b\[[0-9;]*m/g, "")
    expect(result).toContain("2 available")
    expect(result).toContain("1 disabled")
  })
})
