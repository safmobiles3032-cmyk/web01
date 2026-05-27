import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

type AdminUser = {
  id: string
  email?: string
  role: string
}

type ApiBody = {
  action?: string
  [key: string]: unknown
}

class HttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function env(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function supabaseUrl(): string {
  return env("SUPABASE_URL").replace(/\/+$/, "")
}

function serviceRole(): string {
  return Deno.env.get("SERVICE_ROLE_KEY") ?? env("SUPABASE_SERVICE_ROLE_KEY")
}

function anonKey(): string {
  return Deno.env.get("APP_ANON_KEY") ?? env("SUPABASE_ANON_KEY")
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

function encodeFilter(value: string): string {
  return encodeURIComponent(value)
}

async function readJson(req: Request): Promise<ApiBody> {
  return (await req.json().catch(() => ({}))) as ApiBody
}

async function rest<T>(
  path: string,
  init: RequestInit = {},
  returnText = false,
): Promise<T> {
  const url = `${supabaseUrl()}${path}`
  const headers = new Headers(init.headers)
  headers.set("apikey", serviceRole())
  headers.set("Authorization", `Bearer ${serviceRole()}`)
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json")
  }

  const resp = await fetch(url, { ...init, headers })
  const text = await resp.text()
  if (!resp.ok) {
    throw new HttpError(resp.status, text || `Supabase request failed (${resp.status})`)
  }
  if (returnText) return text as T
  if (!text) return null as T
  return JSON.parse(text) as T
}

async function requireAdmin(req: Request): Promise<AdminUser> {
  const authHeader = req.headers.get("authorization") ?? ""
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    throw new HttpError(401, "Missing admin session")
  }

  const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim()
  if (!accessToken) throw new HttpError(401, "Missing admin session")

  const userResp = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: {
      apikey: anonKey(),
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!userResp.ok) {
    throw new HttpError(401, "Invalid admin session")
  }

  const user = (await userResp.json()) as { id?: string; email?: string }
  if (!user.id) throw new HttpError(401, "Invalid admin session")

  const rows = await rest<Array<{ role: string; is_active: boolean }>>(
    `/rest/v1/admin_users?select=role,is_active&user_id=eq.${encodeFilter(user.id)}&is_active=eq.true&limit=1`,
  )

  const row = rows[0]
  if (!row) {
    throw new HttpError(403, "This account is not an active admin")
  }

  return { id: user.id, email: user.email, role: row.role }
}

function startOfMonthIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

function normalizeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeInt(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim()
}

function subscriptionState(row: Record<string, unknown> | undefined): string {
  if (!row) return "expired"
  if (row.disabled_by_admin === true || row.status === "disabled") return "disabled"
  const expiresAt = Date.parse(String(row.expires_at ?? ""))
  if (row.is_active === true && row.status === "active" && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
    return "active"
  }
  if (row.status === "trial") return "trial"
  return "expired"
}

function daysUntil(value: unknown): number | null {
  const expiresAt = Date.parse(String(value ?? ""))
  if (!Number.isFinite(expiresAt)) return null
  return Math.ceil((expiresAt - Date.now()) / 86400000)
}

async function getActivePlan() {
  const rows = await rest<Array<Record<string, unknown>>>(
    "/rest/v1/subscription_plans?select=*&is_active=eq.true&order=created_at.asc&limit=1",
  )
  return rows[0] ?? null
}

async function listCustomers(search = "") {
  const profiles = await rest<Array<Record<string, unknown>>>(
    "/rest/v1/profiles?select=id,email,username,created_at,updated_at&order=created_at.desc&limit=1000",
  )
  const subscriptions = await rest<Array<Record<string, unknown>>>(
    "/rest/v1/user_subscriptions?select=*&order=updated_at.desc&limit=1000",
  )
  const subByUser = new Map(subscriptions.map((row) => [String(row.user_id), row]))
  const needle = search.trim().toLowerCase()

  return profiles
    .filter((profile) => {
      if (!needle) return true
      return [profile.id, profile.email, profile.username]
        .map((v) => String(v ?? "").toLowerCase())
        .some((v) => v.includes(needle))
    })
    .map((profile) => {
      const sub = subByUser.get(String(profile.id))
      return {
        ...profile,
        subscription: sub ?? null,
        subscription_state: subscriptionState(sub),
        days_remaining: daysUntil(sub?.expires_at),
      }
    })
}

async function dashboard() {
  const customers = await listCustomers()
  const payments = await rest<Array<Record<string, unknown>>>(
    `/rest/v1/manual_payments?select=*&created_at=gte.${encodeFilter(startOfMonthIso())}&order=created_at.desc&limit=1000`,
  )
  const allPayments = await listPayments(10)
  const plan = await getActivePlan()
  const price = normalizeNumber(plan?.price, 179)
  const activeCustomers = customers.filter((c) => c.subscription_state === "active")
  const expiredCustomers = customers.filter((c) => c.subscription_state === "expired")
  const expiring3 = activeCustomers.filter((c) => {
    const days = c.days_remaining
    return typeof days === "number" && days >= 0 && days <= 3
  })
  const expiring7 = activeCustomers.filter((c) => {
    const days = c.days_remaining
    return typeof days === "number" && days >= 0 && days <= 7
  })

  return {
    stats: {
      total_customers: customers.length,
      active_subscriptions: activeCustomers.length,
      expired_subscriptions: expiredCustomers.length,
      expiring_in_3_days: expiring3.length,
      expiring_in_7_days: expiring7.length,
      payments_this_month: payments.length,
      estimated_monthly_revenue: activeCustomers.length * price,
    },
    recent_customers: customers.slice(0, 8),
    recent_payments: allPayments,
    plan,
  }
}

async function customerDetails(userId: string) {
  if (!userId) throw new HttpError(400, "Missing user id")
  const profiles = await rest<Array<Record<string, unknown>>>(
    `/rest/v1/profiles?select=id,email,username,created_at,updated_at&id=eq.${encodeFilter(userId)}&limit=1`,
  )
  const subscriptions = await rest<Array<Record<string, unknown>>>(
    `/rest/v1/user_subscriptions?select=*,subscription_plans(name,price,duration_days)&user_id=eq.${encodeFilter(userId)}&limit=1`,
  )
  const payments = await rest<Array<Record<string, unknown>>>(
    `/rest/v1/manual_payments?select=*&user_id=eq.${encodeFilter(userId)}&order=created_at.desc&limit=100`,
  )
  return {
    profile: profiles[0] ?? null,
    subscription: subscriptions[0] ?? null,
    payments,
  }
}

async function verifyPayment(body: ApiBody, admin: AdminUser) {
  const userId = normalizeText(body.user_id)
  if (!userId) throw new HttpError(400, "Missing user id")
  const plan = await getActivePlan()
  if (!plan?.id) throw new HttpError(400, "Active plan not found")

  const months = Math.max(normalizeInt(body.months_added, 1), 1)
  const amount = normalizeNumber(body.amount, normalizeNumber(plan.price, 179) * months)

  return await rest<Record<string, unknown>>("/rest/v1/rpc/admin_verify_manual_payment", {
    method: "POST",
    body: JSON.stringify({
      p_user_id: userId,
      p_amount: amount,
      p_payment_method: normalizeText(body.payment_method) || "UPI",
      p_payment_reference: normalizeText(body.payment_reference) || null,
      p_months_added: months,
      p_payment_date: normalizeText(body.payment_date) || new Date().toISOString(),
      p_admin_notes: normalizeText(body.admin_notes) || null,
      p_plan_id: normalizeText(body.plan_id) || plan.id,
      p_verified_by: admin.id,
    }),
  })
}

async function adjustSubscription(body: ApiBody, admin: AdminUser) {
  const userId = normalizeText(body.user_id)
  const action = normalizeText(body.subscription_action)
  if (!userId || !action) throw new HttpError(400, "Missing subscription action")

  return await rest<Record<string, unknown>>("/rest/v1/rpc/admin_adjust_subscription", {
    method: "POST",
    body: JSON.stringify({
      p_user_id: userId,
      p_action: action,
      p_plan_id: normalizeText(body.plan_id) || null,
      p_months: normalizeInt(body.months, 1),
      p_days: normalizeInt(body.days, 0),
      p_expires_at: normalizeText(body.expires_at) || null,
      p_admin_notes: normalizeText(body.admin_notes) || null,
      p_admin_user_id: admin.id,
    }),
  })
}

function dataUrlToUpload(dataUrl: string): { bytes: Uint8Array; mime: string; ext: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new HttpError(400, "QR upload must be a base64 data URL")

  const mime = match[1]
  const base64 = match[2]
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)

  const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png"
  return { bytes, mime, ext }
}

async function uploadQrImage(dataUrl: string): Promise<string> {
  const upload = dataUrlToUpload(dataUrl)
  const path = `qr-${Date.now()}.${upload.ext}`
  const resp = await fetch(`${supabaseUrl()}/storage/v1/object/payment-qrs/${path}`, {
    method: "POST",
    headers: {
      apikey: serviceRole(),
      Authorization: `Bearer ${serviceRole()}`,
      "Content-Type": upload.mime,
      "x-upsert": "true",
    },
    body: upload.bytes,
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw new HttpError(resp.status, text || "QR upload failed")
  }
  return `${supabaseUrl()}/storage/v1/object/public/payment-qrs/${path}`
}

async function saveQrSettings(body: ApiBody) {
  const existing = await rest<Array<Record<string, unknown>>>(
    "/rest/v1/payment_qr_settings?select=id&order=updated_at.desc&limit=1",
  )
  const settings = (body.settings ?? {}) as Record<string, unknown>
  const imageData = normalizeText(body.qr_image_data_url)
  const qrImageUrl = imageData ? await uploadQrImage(imageData) : normalizeText(settings.qr_image_url)

  const payload = {
    qr_image_url: qrImageUrl || null,
    upi_id: normalizeText(settings.upi_id) || null,
    receiver_name: normalizeText(settings.receiver_name) || null,
    instruction_text: normalizeText(settings.instruction_text) || null,
    support_contact: normalizeText(settings.support_contact) || null,
    is_enabled: settings.is_enabled !== false,
  }

  if (existing[0]?.id) {
    return await rest<Array<Record<string, unknown>>>(
      `/rest/v1/payment_qr_settings?id=eq.${encodeFilter(String(existing[0].id))}&select=*`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(payload),
      },
    )
  }

  return await rest<Array<Record<string, unknown>>>("/rest/v1/payment_qr_settings?select=*", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload),
  })
}

async function savePlan(body: ApiBody) {
  const plan = (body.plan ?? {}) as Record<string, unknown>
  const id = normalizeText(plan.id)
  const payload = {
    name: normalizeText(plan.name) || "Monthly",
    price: normalizeNumber(plan.price, 179),
    duration_days: Math.max(normalizeInt(plan.duration_days, 30), 1),
    is_active: plan.is_active !== false,
  }

  if (id) {
    return await rest<Array<Record<string, unknown>>>(
      `/rest/v1/subscription_plans?id=eq.${encodeFilter(id)}&select=*`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(payload),
      },
    )
  }

  return await rest<Array<Record<string, unknown>>>("/rest/v1/subscription_plans?select=*", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload),
  })
}

async function listPayments(limit = 500) {
  const payments = await rest<Array<Record<string, unknown>>>(
    `/rest/v1/manual_payments?select=*&order=created_at.desc&limit=${limit}`,
  )
  const profiles = await rest<Array<Record<string, unknown>>>(
    "/rest/v1/profiles?select=id,email,username&limit=1000",
  )
  const plans = await rest<Array<Record<string, unknown>>>(
    "/rest/v1/subscription_plans?select=id,name,price,duration_days&limit=100",
  )
  const profileById = new Map(profiles.map((profile) => [String(profile.id), profile]))
  const planById = new Map(plans.map((plan) => [String(plan.id), plan]))

  return payments.map((payment) => ({
    ...payment,
    profiles: profileById.get(String(payment.user_id)) ?? null,
    subscription_plans: planById.get(String(payment.plan_id)) ?? null,
  }))
}

async function listSources() {
  return await rest<Array<Record<string, unknown>>>(
    "/rest/v1/shared_iptv_sources?select=*&order=profile_id.asc,sort_order.asc,created_at.desc&limit=500",
  )
}

async function saveSource(body: ApiBody) {
  const source = (body.source ?? {}) as Record<string, unknown>
  const id = normalizeText(source.id)
  const profileId = normalizeText(source.profile_id || source.profileId) || "all"
  if (!["all", "sports", "kids"].includes(profileId)) {
    throw new HttpError(400, "Profile must be all, sports, or kids")
  }

  const payload = {
    profile_id: profileId,
    name: normalizeText(source.name),
    m3u_url: normalizeText(source.m3u_url || source.m3uUrl),
    epg_url: normalizeText(source.epg_url || source.epgUrl),
    is_enabled: source.is_enabled !== false && source.isEnabled !== false,
    sort_order: normalizeInt(source.sort_order || source.sortOrder, 0),
  }

  if (!payload.m3u_url) throw new HttpError(400, "M3U URL is required")

  if (id) {
    return await rest<Array<Record<string, unknown>>>(
      `/rest/v1/shared_iptv_sources?id=eq.${encodeFilter(id)}&select=*`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(payload),
      },
    )
  }

  return await rest<Array<Record<string, unknown>>>("/rest/v1/shared_iptv_sources?select=*", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload),
  })
}

async function deleteSource(body: ApiBody) {
  const id = normalizeText(body.id)
  if (!id) throw new HttpError(400, "Missing source id")
  await rest<string>(`/rest/v1/shared_iptv_sources?id=eq.${encodeFilter(id)}`, { method: "DELETE" }, true)
  return { ok: true }
}

async function testSource(body: ApiBody) {
  const url = normalizeText(body.url)
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, "Enter a valid http or https URL")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-2048" },
      signal: controller.signal,
    })
    return {
      ok: resp.ok,
      status: resp.status,
      content_type: resp.headers.get("content-type"),
      message: resp.ok ? "Source responded" : `Source responded with ${resp.status}`,
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : "Source test failed",
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function listWebPlayers() {
  return await rest<Array<Record<string, unknown>>>(
    "/rest/v1/shared_web_players?select=*&order=sort_order.asc,slot.asc&limit=20",
  )
}

async function saveWebPlayer(body: ApiBody) {
  const player = (body.player ?? {}) as Record<string, unknown>
  const slot = normalizeInt(player.slot, 1)
  if (![1, 2].includes(slot)) throw new HttpError(400, "Slot must be 1 or 2")
  const payload = {
    slot,
    title: normalizeText(player.title) || `Web Player ${slot}`,
    url: normalizeText(player.url),
    is_enabled: player.is_enabled !== false && player.isEnabled !== false,
    sort_order: normalizeInt(player.sort_order || player.sortOrder, slot),
    open_external: player.open_external === true || player.openExternal === true,
  }

  return await rest<Array<Record<string, unknown>>>(
    "/rest/v1/shared_web_players?on_conflict=slot&select=*",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(payload),
    },
  )
}

async function bootstrap() {
  const [dash, customers, payments, qrRows, plan, sources, webPlayers] = await Promise.all([
    dashboard(),
    listCustomers(),
    listPayments(),
    rest<Array<Record<string, unknown>>>("/rest/v1/payment_qr_settings?select=*&order=updated_at.desc&limit=1"),
    getActivePlan(),
    listSources(),
    listWebPlayers(),
  ])

  return {
    dashboard: dash,
    customers,
    payments,
    qr_settings: qrRows[0] ?? null,
    plan,
    sources,
    web_players: webPlayers,
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }

  try {
    const body = await readJson(req)
    const admin = await requireAdmin(req)
    const action = normalizeText(body.action)

    switch (action) {
      case "bootstrap":
        return jsonResponse({ admin, data: await bootstrap() })
      case "dashboard":
        return jsonResponse({ data: await dashboard() })
      case "customers":
        return jsonResponse({ data: await listCustomers(normalizeText(body.search)) })
      case "customer":
        return jsonResponse({ data: await customerDetails(normalizeText(body.user_id)) })
      case "payments":
        return jsonResponse({ data: await listPayments() })
      case "verify_payment":
        return jsonResponse({ data: await verifyPayment(body, admin) })
      case "adjust_subscription":
        return jsonResponse({ data: await adjustSubscription(body, admin) })
      case "save_qr_settings":
        return jsonResponse({ data: await saveQrSettings(body) })
      case "save_plan":
        return jsonResponse({ data: await savePlan(body) })
      case "sources":
        return jsonResponse({ data: await listSources() })
      case "save_source":
        return jsonResponse({ data: await saveSource(body) })
      case "delete_source":
        return jsonResponse({ data: await deleteSource(body) })
      case "test_source":
        return jsonResponse({ data: await testSource(body) })
      case "web_players":
        return jsonResponse({ data: await listWebPlayers() })
      case "save_web_player":
        return jsonResponse({ data: await saveWebPlayer(body) })
      default:
        throw new HttpError(400, "Unknown admin action")
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    const message = error instanceof Error ? error.message : "Unexpected error"
    return jsonResponse({ error: message }, status)
  }
})
