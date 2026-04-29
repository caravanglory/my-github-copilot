import * as p from "@clack/prompts"
import color from "picocolors"

import {
  readStore,
  authPath,
  loginOauth,
  importFromAuth,
  switchAccount,
  removeAccount,
  removeAllAccounts,
  addAccount,
  checkQuotas,
  checkModels,
  refreshIdentity,
} from "../features/copilot-account-switcher"

import {
  buildAccountLines,
  buildModelReport,
  buildAccountChoices,
} from "./copilot-account-display"
import { promptManualAccountEntry } from "./copilot-account-prompts"

type ActionType =
  | "add-oauth"
  | "add-manual"
  | "import"
  | "models"
  | "refresh-identity"
  | "switch"
  | "remove"
  | "remove-all"
  | "exit"

async function handleOAuthLogin(): Promise<void> {
  const deployment = await p.select({
    message: "Login target",
    options: [
      { value: "github.com" as const, label: "github.com" },
      { value: "enterprise" as const, label: "Enterprise", hint: "Custom GitHub Enterprise Server" },
    ],
  })
  if (p.isCancel(deployment)) return

  let enterpriseUrl: string | undefined
  if (deployment === "enterprise") {
    const url = await p.text({
      message: "Enterprise URL",
      placeholder: "github.mycompany.com",
      validate: (v) => (!v.trim() ? "URL is required" : undefined),
    })
    if (p.isCancel(url)) return
    enterpriseUrl = (url as string).trim()
  }

  const spinner = p.spinner()
  spinner.start("Authenticating via device flow...")
  const entry = await loginOauth(deployment, enterpriseUrl)
  await addAccount(entry)
  spinner.stop(`Account added: ${color.green(entry.name)}`)
}

async function handleManualAdd(): Promise<void> {
  const store = await readStore()
  const result = await promptManualAccountEntry(Object.keys(store.accounts))
  if (!result) return
  await addAccount(result.entry)
  p.log.success(`Account added: ${color.green(result.name)}`)
}

async function handleImport(): Promise<void> {
  const customPath = await p.text({
    message: "Import from",
    placeholder: authPath(),
    defaultValue: "",
  })
  if (p.isCancel(customPath)) return

  const spinner = p.spinner()
  spinner.start("Importing accounts...")
  const result = await importFromAuth((customPath as string).trim() || undefined)
  spinner.stop(`Imported ${color.green(String(result.imported))} account(s)`)
}

async function handleCheckQuotas(): Promise<void> {
  const spinner = p.spinner()
  spinner.start("Checking quotas for all accounts...")
  await checkQuotas()
  spinner.stop("Quotas updated")
}

async function handleCheckModels(): Promise<void> {
  const spinner = p.spinner()
  spinner.start("Checking available models...")
  const store = await checkModels()
  spinner.stop("Models checked")
  p.note(buildModelReport(store), "Model Report")
}

async function handleRefreshIdentity(): Promise<void> {
  const spinner = p.spinner()
  spinner.start("Refreshing identity & quota for all accounts...")
  await refreshIdentity()
  await checkQuotas()
  spinner.stop("Identity & quota refreshed")
}

async function handleSwitch(): Promise<void> {
  const store = await readStore()
  const choices = buildAccountChoices(store.accounts, store.active)
  if (choices.length === 0) { p.log.warn("No accounts to switch."); return }
  const selected = await p.select({ message: "Switch to", options: choices })
  if (p.isCancel(selected)) return
  await switchAccount(selected as string)
  p.log.success(`Switched to: ${color.green(selected as string)}`)
}

async function handleRemove(): Promise<void> {
  const store = await readStore()
  const choices = buildAccountChoices(store.accounts, store.active)
  if (choices.length === 0) { p.log.warn("No accounts to remove."); return }
  const selected = await p.select({ message: "Remove which account?", options: choices })
  if (p.isCancel(selected)) return
  const confirmed = await p.confirm({ message: `Remove ${color.red(selected as string)}?`, initialValue: false })
  if (p.isCancel(confirmed) || !confirmed) return
  await removeAccount(selected as string)
  p.log.success(`Removed: ${color.red(selected as string)}`)
}

async function handleRemoveAll(): Promise<void> {
  const confirmed = await p.confirm({ message: `${color.red("Remove ALL accounts?")} This cannot be undone.`, initialValue: false })
  if (p.isCancel(confirmed) || !confirmed) return
  await removeAllAccounts()
  p.log.success("All accounts removed.")
}

function buildMenuOptions(): Array<{ value: ActionType; label: string; hint?: string }> {
  return [
    { value: "add-oauth", label: "Add account (OAuth)", hint: "GitHub device flow" },
    { value: "add-manual", label: "Add account (manual)", hint: "Paste token directly" },
    { value: "import", label: "Import from auth.json", hint: "Auto-detect from OpenCode" },
    { value: "models", label: "Check models", hint: "Available & disabled models" },
    { value: "refresh-identity", label: "Refresh identity & quota", hint: "Update usernames, orgs & quotas" },
    { value: "switch", label: "Switch account" },
    { value: "remove", label: "Remove account" },
    { value: "remove-all", label: "Remove all accounts", hint: color.red("destructive") },
    { value: "exit", label: "Exit" },
  ]
}

const ACTION_HANDLERS: Record<string, () => Promise<void>> = {
  "add-oauth": handleOAuthLogin,
  "add-manual": handleManualAdd,
  import: handleImport,
  models: handleCheckModels,
  "refresh-identity": handleRefreshIdentity,
  switch: handleSwitch,
  remove: handleRemove,
  "remove-all": handleRemoveAll,
}

export async function copilotXCli(): Promise<number> {
  p.intro(color.bgCyan(color.black(" GitHub Copilot Account Manager ")))

  await handleCheckQuotas()

  while (true) {
    const store = await readStore()
    const accountDisplay = buildAccountLines(store)
    p.note(accountDisplay, "Accounts")

    const action = await p.select<ActionType>({ message: "What would you like to do?", options: buildMenuOptions() })
    if (p.isCancel(action)) { p.outro(color.dim("Bye!")); return 0 }
    if (action === "exit") { p.outro(color.dim("Bye!")); return 0 }

    try {
      const handler = ACTION_HANDLERS[action]
      if (handler) await handler()
    } catch (error) {
      p.log.error(`${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
