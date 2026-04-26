export type AccountEntry = {
  name: string
  refresh: string
  access: string
  expires: number
  enterpriseUrl?: string
  user?: string
  email?: string
  orgs?: string[]
  addedAt?: number
  lastUsed?: number
  source?: "auth" | "manual"
  providerId?: string
  quota?: {
    plan?: string
    sku?: string
    reset?: string
    updatedAt?: number
    error?: string
    snapshots?: {
      premium?: QuotaSnapshot
      chat?: QuotaSnapshot
      completions?: QuotaSnapshot
    }
  }
  models?: {
    available: string[]
    disabled: string[]
    updatedAt?: number
    error?: string
  }
}

export type QuotaSnapshot = {
  entitlement?: number
  remaining?: number
  used?: number
  unlimited?: boolean
  percentRemaining?: number
}

export type StoreFile = {
  active?: string
  accounts: Record<string, AccountEntry>
  autoRefresh?: boolean
  refreshMinutes?: number
  lastQuotaRefresh?: number
  loopSafetyEnabled?: boolean
  networkRetryEnabled?: boolean
  lastAccountSwitchAt?: number
}

export type AccountStatus = "active" | "expired" | "unknown"

export type AccountInfo = {
  name: string
  index: number
  addedAt?: number
  lastUsed?: number
  status?: AccountStatus
  isCurrent?: boolean
  source?: "auth" | "manual"
  orgs?: string[]
  plan?: string
  sku?: string
  reset?: string
  models?: { enabled: number; disabled: number }
  modelsError?: string
  modelList?: { available: string[]; disabled: string[] }
  quota?: {
    premium?: { remaining?: number; entitlement?: number; unlimited?: boolean }
    chat?: { remaining?: number; entitlement?: number; unlimited?: boolean }
    completions?: { remaining?: number; entitlement?: number; unlimited?: boolean }
  }
}

export type MenuAction =
  | { type: "add" }
  | { type: "import" }
  | { type: "quota" }
  | { type: "refresh-identity" }
  | { type: "check-models" }
  | { type: "toggle-refresh" }
  | { type: "set-interval" }
  | { type: "toggle-loop-safety" }
  | { type: "toggle-network-retry" }
  | { type: "switch"; account: AccountInfo }
  | { type: "remove"; account: AccountInfo }
  | { type: "remove-all" }
  | { type: "cancel" }

export type GitHubUserInfo = {
  login?: string
  email?: string
  orgs?: string[]
}

export type FetchLike = (request: Request | URL | string, init?: RequestInit) => Promise<Response>
