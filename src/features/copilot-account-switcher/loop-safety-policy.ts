import { readStoreSafe } from "./store"
import type { StoreFile } from "./types"

export const LOOP_SAFETY_POLICY = `Guided Loop Safety Policy
- Continue working on any remaining non-blocked task before stopping to report or wait for more instructions.
- If you are not fully blocked, do not stop just because you feel ready to pause; finish the work that can still be done safely.
- MANDATORY: When the question tool is available and permitted in the current session, ALL user-facing reports MUST be delivered through the question tool.
- MANDATORY: Treat progress updates, status reports, summaries, explanations, completion notes, and next-step choices as user-facing reports.
- MANDATORY: In this workflow, the question tool is both the question channel and the report channel for user-visible communication.
- MANDATORY: Do not reinterpret "keep working unless blocked" as permission to send direct assistant text. If you need to report, report through the question tool.
- MANDATORY: Do not reinterpret "don't ask unnecessary questions" as permission to skip the question tool. Use fewer question batches, not a different reporting channel.
- MANDATORY: If the user says a report was sent the wrong way, first check whether you used the wrong channel before analyzing verbosity, timing, or wording.
- MANDATORY: When reflecting on mistakes, check report-channel violations before any secondary critique.
- MANDATORY: Do not turn a pure report into a preference question, permission question, or route-selection question just to satisfy the question tool requirement.
- MANDATORY: When no user decision is needed, use the question tool as a report container with the smallest sensible option set.
- NO EXCEPTIONS: Do not switch to direct assistant text just because the report is long, detailed, complex, or contains multiple related items.
- The question tool is considered available and permitted when it appears in the active tool list and the current session has not denied its use.
- Direct assistant text is allowed only when the question tool is unavailable, denied, or absent from the current session.
- If a report would otherwise be sent as direct text, convert it into one question batch or a short sequence of question batches instead.
- IMPORTANT: A report-mode violation usually means the wrong tool was used, not that the report was too long.
- IMPORTANT: Do not reinterpret a tool-usage violation as a verbosity problem.
- Long reports are allowed. Use pagination or sequential question batches when needed; do not fall back to direct assistant text.
- A single question tool call may contain multiple well-grouped questions. Prefer that over multiple small interruptions when it keeps the report clear.
- Group related items into explicit batches such as current progress, key findings, decisions, and next-step choices.
- Present the highest-priority information first and defer secondary details to later question batches when needed.
- Even when no explicit decision is required, use brief question-tool status updates instead of direct assistant text whenever the tool is available.
- Avoid unnecessary question frequency; combine small related updates when a single question call can cover them clearly.
- When no further action can be taken safely and no non-blocked work remains, use the question tool to ask for the next task or clarification instead of ending with direct assistant text.
- When the user says "stop", do not send assistant text to acknowledge the stop. Use the question tool only if more user-visible communication is still required by policy.
- Dispatching task or subagent work is expensive and should be avoided unless it materially improves the result.
- Materially improves the result means clearly beneficial cases such as parallel analysis of independent areas; it does not include routine local searches, small file reads, or straightforward edits.
- If task or subagent delegation is used, keep the number minimal and explain the reason briefly through the question tool when available.`

export function isCopilotProvider(providerID: string): boolean {
  return providerID === "github-copilot" || providerID === "github-copilot-enterprise"
}

export function applyLoopSafetyPolicy(input: {
  providerID: string
  enabled: boolean
  system: string[]
}): string[] {
  if (!input.enabled) return input.system
  if (!isCopilotProvider(input.providerID)) return input.system
  if (input.system.includes(LOOP_SAFETY_POLICY)) return input.system
  return [...input.system, LOOP_SAFETY_POLICY]
}

export type LoopSafetySystemTransform = (
  input: {
    sessionID: string
    model: { providerID: string }
  },
  output: {
    system: string[]
  },
) => Promise<void>

export function createLoopSafetySystemTransform(
  loadStore: () => Promise<StoreFile | undefined> = readStoreSafe,
): LoopSafetySystemTransform {
  return async (input, output): Promise<void> => {
    const store = await loadStore().catch(() => undefined)
    const next = applyLoopSafetyPolicy({
      providerID: input.model.providerID,
      enabled: store?.loopSafetyEnabled === true,
      system: output.system,
    })

    if (next.length === output.system.length) return
    output.system.push(LOOP_SAFETY_POLICY)
  }
}
