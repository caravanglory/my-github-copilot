import * as p from "@clack/prompts"

import type { AccountEntry } from "../features/copilot-account-switcher"

export async function promptManualAccountEntry(existingNames: string[]): Promise<{ name: string; entry: AccountEntry } | null> {
  const name = await p.text({
    message: "Account name",
    placeholder: "my-github-account",
    validate(value) {
      if (!value.trim()) return "Name is required"
      if (existingNames.includes(value.trim())) return `Name already exists: ${value.trim()}`
    },
  })
  if (p.isCancel(name)) return null

  const refresh = await p.text({
    message: "OAuth refresh/access token",
    placeholder: "gho_xxxx...",
    validate(value) {
      if (!value.trim()) return "Token is required"
    },
  })
  if (p.isCancel(refresh)) return null

  const access = await p.text({
    message: "Copilot access token (optional)",
    placeholder: "Press Enter to skip",
    defaultValue: "",
  })
  if (p.isCancel(access)) return null

  const expiresRaw = await p.text({
    message: "Access token expires (unix ms, optional)",
    placeholder: "Press Enter to skip",
    defaultValue: "",
  })
  if (p.isCancel(expiresRaw)) return null

  const enterpriseUrl = await p.text({
    message: "Enterprise URL (optional)",
    placeholder: "github.mycompany.com",
    defaultValue: "",
  })
  if (p.isCancel(enterpriseUrl)) return null

  const expires = Number(expiresRaw)
  const trimmedName = (name as string).trim()
  const trimmedRefresh = (refresh as string).trim()
  const trimmedAccess = (access as string).trim()
  const trimmedEnterprise = (enterpriseUrl as string).trim()

  const entry: AccountEntry = {
    name: trimmedName,
    refresh: trimmedRefresh,
    access: trimmedAccess || trimmedRefresh,
    expires: Number.isFinite(expires) ? expires : 0,
    enterpriseUrl: trimmedEnterprise || undefined,
    addedAt: Date.now(),
    source: "manual",
  }
  return { name: trimmedName, entry }
}
