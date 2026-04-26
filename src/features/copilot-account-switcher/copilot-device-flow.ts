import { log } from "../../logger"

import { fetchUser } from "./copilot-auth"
import type { AccountEntry } from "./types"

const CLIENT_ID = "Ov23li8tweQw6odWQebz"
const POLLING_SAFETY_MARGIN_MS = 3000

export type DeviceFlowData = {
  verificationUri: string
  userCode: string
  deviceCode: string
  interval: number
  domain: string
}

function getUrls(domain: string): { deviceCodeUrl: string; accessTokenUrl: string } {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
  }
}

function normalizeDomain(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function initiateDeviceFlow(
  deployment: "github.com" | "enterprise",
  enterpriseUrl?: string,
): Promise<DeviceFlowData> {
  const domain = deployment === "enterprise" ? normalizeDomain(enterpriseUrl ?? "") : "github.com"
  const urls = getUrls(domain)

  const response = await fetch(urls.deviceCodeUrl, {
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

  if (!response.ok) throw new Error("Failed to initiate device authorization")

  const data = (await response.json()) as {
    verification_uri: string
    user_code: string
    device_code: string
    interval: number
  }

  return {
    verificationUri: data.verification_uri,
    userCode: data.user_code,
    deviceCode: data.device_code,
    interval: data.interval,
    domain,
  }
}

export async function pollDeviceFlow(
  flow: DeviceFlowData,
): Promise<{ refresh: string; access: string; expires: number }> {
  const urls = getUrls(flow.domain)

  while (true) {
    const response = await fetch(urls.accessTokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: flow.deviceCode,
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
        name: flow.domain === "github.com" ? "github.com" : `enterprise:${flow.domain}`,
        refresh: data.access_token,
        access: data.access_token,
        expires: 0,
        enterpriseUrl: flow.domain !== "github.com" ? flow.domain : undefined,
        addedAt: Date.now(),
        source: "auth",
      }
      const user = await fetchUser(entry)
      if (user?.login) entry.user = user.login

      log("[copilot-device-flow] auth completed", { user: entry.user })
      return {
        refresh: entry.refresh,
        access: entry.access,
        expires: entry.expires,
      }
    }

    if (data.error === "authorization_pending") {
      await sleep(flow.interval * 1000 + POLLING_SAFETY_MARGIN_MS)
      continue
    }

    if (data.error === "slow_down") {
      const serverInterval = data.interval
      const next = (serverInterval && serverInterval > 0 ? serverInterval : flow.interval + 5) * 1000
      await sleep(next + POLLING_SAFETY_MARGIN_MS)
      continue
    }

    throw new Error("Authorization failed")
  }
}
