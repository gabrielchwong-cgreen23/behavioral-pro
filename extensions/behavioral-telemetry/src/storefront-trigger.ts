interface DecisionResponse {
  decision: boolean
  strategy: string
  shadow_mode: boolean
  intervention_type?: string
  message_id?: string
  metadata?: {
    reason: string
    calculated_threshold?: number
  }
}

type SavedCartItem = {
  id: number
  quantity: number
}

type TidioMessagePayload = {
  participant?: unknown
  message?: unknown
  text?: unknown
  content?: unknown
  value?: unknown
  body?: unknown
}

type TidioChatApi = {
  show?: () => void
  messageFromOperator?: (message: string) => void
  on?: (eventName: string, listener: (message: unknown) => void) => void
}

type BrowserWindow = Window & {
  tidioChatApi?: TidioChatApi
  Shopify?: {
    routes?: {
      root?: string
    }
  }
}

const FETCH_TIMEOUT_MS = 1000
const SAVED_CART_STORAGE_KEY = 'behavioral_pro_saved_cart'
const FAILURE_COUNT_STORAGE_KEY = 'behavioral_pro_failure_count'
const CIRCUIT_BROKEN_STORAGE_KEY = 'behavioral_pro_circuit_broken'
const CIRCUIT_REPORTED_STORAGE_KEY = 'behavioral_pro_circuit_reported'
const CIRCUIT_BREAKER_THRESHOLD = 3
const SILENT_FALLBACK_REASON = 'silent_fallback'
const INTERVENTION_MESSAGE_MATRIX = {
  tidio_checkout_recovery_v1: "If you're running into any technical issues or have a quick question about shipping times, let me know right here—I'm happy to look into it for you!",
  tidio_trust_reassurance_v1: "you can ask any policy questions here, we'll get you exactly what you need",
  tidio_friction_assistance_v1: "If theres anything you're having trouble with, I can manually process your request here",
  tidio_cohort_v1: "Let me know if you have any questions about anything you're looking at",
  tidio_cart_recovery_v1: "If you need anything else, please let me know. Otherwise, I've saved your initial items so you won't lose them!"
} as const
const COHORT_MESSAGE_IDS = new Set([
  'tidio_fast_conversion_nudge_v1',
  'tidio_reassurance_assist_v1',
  'tidio_high_touch_consultation_v1'
])
const RECOVERY_INTENT_PATTERNS = [
  /\byes\b/,
  /\brestore\b/,
  /\bget (them|it) back\b/,
  /\bbring (them|it) back\b/,
  /\blost\b/
]

let cartRecoveryListenerBound = false
let cartRecoveryInFlight = false
let lastRecoveryMessageFingerprint = ''
let lastRecoveryMessageAt = 0

function getBackendUrl(path: string): string {
  const base =
    (window as BrowserWindow & { __BEHAVIORAL_PRO_BACKEND_BASE__?: string })
      .__BEHAVIORAL_PRO_BACKEND_BASE__ || window.location.origin
  return new URL(path, base).toString()
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function getShopifyAjaxUrl(path: string): string {
  const browserWindow = window as BrowserWindow
  const root = typeof browserWindow.Shopify?.routes?.root === 'string'
    ? browserWindow.Shopify.routes.root
    : '/'
  const normalizedRoot = ensureTrailingSlash(root.startsWith('/') ? root : `/${root}`)
  return new URL(path.replace(/^\/+/, ''), `${window.location.origin}${normalizedRoot}`).toString()
}

function getWindowTidioApi(): TidioChatApi | null {
  const browserWindow = window as BrowserWindow
  return browserWindow.tidioChatApi || null
}

function safeReadLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeWriteLocalStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Ignore storage failures in the storefront.
  }
}

function safeRemoveLocalStorage(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Ignore storage failures in the storefront.
  }
}

function safeReadSessionStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function safeWriteSessionStorage(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value)
  } catch {
    // Ignore storage failures in the storefront.
  }
}

function parseFailureCount(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0
  }

  return Math.min(CIRCUIT_BREAKER_THRESHOLD, parsed)
}

function isCircuitBroken(): boolean {
  return safeReadSessionStorage(CIRCUIT_BROKEN_STORAGE_KEY) === 'true'
}

function buildSilentFallbackDecision(): DecisionResponse {
  return {
    decision: false,
    strategy: SILENT_FALLBACK_REASON,
    shadow_mode: false,
    intervention_type: 'none',
    metadata: {
      reason: SILENT_FALLBACK_REASON
    }
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message || error.name
  }

  if (typeof error === 'string') {
    return error
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function reportCircuitBreakerTripped(shopDomain: string, error: unknown): void {
  if (safeReadSessionStorage(CIRCUIT_REPORTED_STORAGE_KEY) === 'true') {
    return
  }

  safeWriteSessionStorage(CIRCUIT_REPORTED_STORAGE_KEY, 'true')

  const payload = JSON.stringify({
    shop_domain: shopDomain,
    error_context: 'circuit_breaker_tripped',
    error_message: stringifyError(error)
  })
  const url = getBackendUrl('/api/log-system-error')

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const beaconPayload = new Blob([payload], { type: 'application/json' })
      if (navigator.sendBeacon(url, beaconPayload)) {
        return
      }
    }
  } catch {
    // Fall through to background fetch.
  }

  try {
    void fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: payload,
      keepalive: true,
      credentials: 'omit'
    }).catch(() => {})
  } catch {
    // Suppress all telemetry failures.
  }
}

function resetDecisionFailureCount(): void {
  safeWriteSessionStorage(FAILURE_COUNT_STORAGE_KEY, '0')
}

function recordDecisionFailure(shopDomain: string, error: unknown): void {
  if (isCircuitBroken()) {
    return
  }

  const nextCount = Math.min(
    CIRCUIT_BREAKER_THRESHOLD,
    parseFailureCount(safeReadSessionStorage(FAILURE_COUNT_STORAGE_KEY)) + 1
  )
  safeWriteSessionStorage(FAILURE_COUNT_STORAGE_KEY, String(nextCount))

  if (nextCount === CIRCUIT_BREAKER_THRESHOLD) {
    safeWriteSessionStorage(CIRCUIT_BROKEN_STORAGE_KEY, 'true')
    reportCircuitBreakerTripped(shopDomain, error)
  }
}

function normalizeSavedCartItems(input: unknown): SavedCartItem[] {
  if (!Array.isArray(input)) {
    return []
  }

  const items: SavedCartItem[] = []

  for (const rawItem of input) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      continue
    }

    const item = rawItem as Record<string, unknown>
    const id = Number(item.id)
    const quantity = Number(item.quantity)
    if (!Number.isFinite(id) || !Number.isFinite(quantity) || quantity <= 0) {
      continue
    }

    items.push({
      id: Math.trunc(id),
      quantity: Math.trunc(quantity)
    })
  }

  return items
}

function readSavedCartItems(): SavedCartItem[] {
  const rawValue = safeReadLocalStorage(SAVED_CART_STORAGE_KEY)
  if (!rawValue) {
    return []
  }

  try {
    return normalizeSavedCartItems(JSON.parse(rawValue) as unknown)
  } catch {
    return []
  }
}

function resolveInterventionMessageId(
  messageId?: string,
  interventionType?: string
): keyof typeof INTERVENTION_MESSAGE_MATRIX {
  const normalizedMessageId = typeof messageId === 'string' ? messageId.trim() : ''
  if (normalizedMessageId in INTERVENTION_MESSAGE_MATRIX) {
    return normalizedMessageId as keyof typeof INTERVENTION_MESSAGE_MATRIX
  }

  if (COHORT_MESSAGE_IDS.has(normalizedMessageId)) {
    return 'tidio_cohort_v1'
  }

  switch (interventionType) {
    case 'checkout_recovery':
      return 'tidio_checkout_recovery_v1'
    case 'trust_reassurance':
      return 'tidio_trust_reassurance_v1'
    case 'friction_assistance':
      return 'tidio_friction_assistance_v1'
    case 'cart_recovery':
      return 'tidio_cart_recovery_v1'
    default:
      return 'tidio_cohort_v1'
  }
}

async function snapshotActiveCart(): Promise<void> {
  try {
    const response = await fetch(getShopifyAjaxUrl('/cart.js'), {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      },
      credentials: 'same-origin'
    })

    if (!response.ok) {
      return
    }

    const payload = await response.json().catch(() => null) as { items?: unknown } | null
    const items = normalizeSavedCartItems(payload?.items)
    if (items.length === 0) {
      safeRemoveLocalStorage(SAVED_CART_STORAGE_KEY)
      return
    }

    safeWriteLocalStorage(SAVED_CART_STORAGE_KEY, JSON.stringify(items))
  } catch {
    // Never allow cart snapshotting failures to affect the storefront.
  }
}

function extractMessageText(input: unknown): string {
  if (typeof input === 'string') {
    return input.trim()
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ''
  }

  const value = input as Record<string, unknown>
  const directKeys = ['text', 'message', 'content', 'value', 'body']
  for (const key of directKeys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }

  for (const key of directKeys) {
    const candidate = value[key]
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const nestedText = extractMessageText(candidate)
      if (nestedText) {
        return nestedText
      }
    }
  }

  return ''
}

function normalizeVisitorMessage(
  input: unknown,
  fallbackParticipant?: string
): { participant: string; text: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      participant: String(fallbackParticipant || '').trim().toLowerCase(),
      text: extractMessageText(input)
    }
  }

  const value = input as TidioMessagePayload
  return {
    participant: typeof value.participant === 'string'
      ? value.participant.trim().toLowerCase()
      : String(fallbackParticipant || '').trim().toLowerCase(),
    text: extractMessageText(value)
  }
}

function matchesRecoveryIntent(text: string): boolean {
  const normalizedText = text.trim().toLowerCase()
  if (!normalizedText) {
    return false
  }

  return RECOVERY_INTENT_PATTERNS.some((pattern) => pattern.test(normalizedText))
}

async function restoreSavedCart(): Promise<void> {
  if (cartRecoveryInFlight) {
    return
  }

  const items = readSavedCartItems()
  if (items.length === 0) {
    return
  }

  cartRecoveryInFlight = true

  try {
    const response = await fetch(getShopifyAjaxUrl('/cart/add.js'), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ items }),
      credentials: 'same-origin'
    })

    if (!response.ok) {
      return
    }

    safeRemoveLocalStorage(SAVED_CART_STORAGE_KEY)
    window.location.reload()
  } catch {
    // Never allow recovery failures to affect the storefront.
  } finally {
    cartRecoveryInFlight = false
  }
}

async function handleIncomingTidioMessage(
  input: unknown,
  fallbackParticipant?: string
): Promise<void> {
  const message = normalizeVisitorMessage(input, fallbackParticipant)
  if (message.participant !== 'visitor') {
    return
  }

  if (!matchesRecoveryIntent(message.text)) {
    return
  }

  const fingerprint = `${message.participant}:${message.text.toLowerCase()}`
  const now = Date.now()
  if (
    fingerprint === lastRecoveryMessageFingerprint &&
    now - lastRecoveryMessageAt < 2000
  ) {
    return
  }

  lastRecoveryMessageFingerprint = fingerprint
  lastRecoveryMessageAt = now
  await restoreSavedCart()
}

function bindCartRecoveryListener(): void {
  if (cartRecoveryListenerBound) {
    return
  }

  const tidioChatApi = getWindowTidioApi()
  if (typeof tidioChatApi?.on !== 'function') {
    return
  }

  let boundAtLeastOnce = false

  try {
    tidioChatApi.on('messageFromVisitor', (message) => {
      void handleIncomingTidioMessage(message, 'visitor').catch(() => {})
    })
    boundAtLeastOnce = true
  } catch {
    // Ignore unsupported listener names on older widget builds.
  }

  try {
    tidioChatApi.on('message', (message) => {
      void handleIncomingTidioMessage(message).catch(() => {})
    })
    boundAtLeastOnce = true
  } catch {
    // Ignore unsupported listener names on older widget builds.
  }

  cartRecoveryListenerBound = boundAtLeastOnce
}

function initializeCartRecoveryWorker(): void {
  const onReady = (): void => {
    try {
      bindCartRecoveryListener()
    } catch {
      // Never allow widget lifecycle issues to affect the storefront.
    }
  }

  const tidioChatApi = getWindowTidioApi()
  if (typeof tidioChatApi?.on === 'function') {
    try {
      tidioChatApi.on('ready', onReady)
    } catch {
      // Ignore unsupported lifecycle listener names.
    }

    onReady()
    return
  }

  try {
    document.addEventListener('tidioChat-ready', onReady)
  } catch {
    // Ignore DOM event binding failures.
  }
}

function parseDecisionResponse(input: unknown): DecisionResponse | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null
  }

  const value = input as Record<string, unknown>
  if (typeof value.decision !== 'boolean') {
    return null
  }

  if (typeof value.strategy !== 'string') {
    return null
  }

  if (typeof value.shadow_mode !== 'boolean') {
    return null
  }

  let metadata: DecisionResponse['metadata']
  if (value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)) {
    const metadataValue = value.metadata as Record<string, unknown>
    if (typeof metadataValue.reason === 'string') {
      metadata = {
        reason: metadataValue.reason,
        calculated_threshold: typeof metadataValue.calculated_threshold === 'number'
          ? metadataValue.calculated_threshold
          : undefined
      }
    }
  }

  return {
    decision: value.decision,
    strategy: value.strategy,
    shadow_mode: value.shadow_mode,
    message_id: typeof value.message_id === 'string'
      ? value.message_id
      : undefined,
    intervention_type: typeof value.intervention_type === 'string'
      ? value.intervention_type
      : undefined,
    metadata
  }
}

async function fetchDecision(
  storeId: string,
  shopDomain: string,
  sessionId: string
): Promise<DecisionResponse> {
  if (isCircuitBroken()) {
    return buildSilentFallbackDecision()
  }

  const controller = typeof window.AbortController === 'function'
    ? new window.AbortController()
    : null
  let timeoutId = 0

  try {
    const url = new URL(getBackendUrl('/api/intervention-decision'))
    url.searchParams.set('store_id', storeId)
    url.searchParams.set('shop_domain', shopDomain)
    url.searchParams.set('session_id', sessionId)

    const response = await Promise.race([
      fetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        },
        credentials: 'omit',
        signal: controller?.signal
      }),
      new Promise<Response>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          try {
            controller?.abort()
          } catch {
            // Ignore abort failures and reject with a silent fallback path.
          }

          reject(new Error('intervention_decision_timeout'))
        }, FETCH_TIMEOUT_MS)
      })
    ])

    if (response.status !== 200) {
      recordDecisionFailure(
        shopDomain,
        new Error(`intervention_decision_failed_status:${response.status}`)
      )
      return buildSilentFallbackDecision()
    }

    const json = await response.json().catch(() => null)
    const parsedDecision = parseDecisionResponse(json)
    if (!parsedDecision) {
      recordDecisionFailure(shopDomain, new Error('intervention_decision_invalid_payload'))
      return buildSilentFallbackDecision()
    }

    resetDecisionFailureCount()
    return parsedDecision
  } catch (error) {
    recordDecisionFailure(shopDomain, error)
    return buildSilentFallbackDecision()
  } finally {
    window.clearTimeout(timeoutId)
  }
}

async function postShadowDecisionLog(
  shopDomain: string,
  sessionId: string,
  strategy: string,
  reason: string,
  calculatedThreshold?: number
): Promise<void> {
  const anonymousId = safeReadLocalStorage('behavioral_pro_visitor_id')
    || safeReadLocalStorage('bp_visitor_id')
    || sessionId

  const payload = {
    anonymous_id: anonymousId,
    session_id: sessionId,
    event_name: 'shadow_intervention_logged',
    timestamp: Math.floor(Date.now() / 1000),
    properties: {
      path: window.location.pathname,
      shop_domain: shopDomain,
      strategy,
      reason,
      ...(typeof calculatedThreshold === 'number'
        ? { calculated_threshold: calculatedThreshold }
        : {})
    }
  }

  try {
    await fetch(getBackendUrl('/api/events'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      keepalive: true,
      credentials: 'omit'
    })
  } catch {
    // Fail silently by design.
  }
}

function triggerActiveTidioIntervention(decision: DecisionResponse): void {
  const tidioChatApi = getWindowTidioApi()
  if (!tidioChatApi) {
    return
  }

  const messageId = resolveInterventionMessageId(
    decision.message_id,
    decision.intervention_type
  )
  const messageCopy = INTERVENTION_MESSAGE_MATRIX[messageId]

  if (typeof tidioChatApi.show === 'function') {
    tidioChatApi.show()
  }

  if (typeof tidioChatApi.messageFromOperator === 'function') {
    tidioChatApi.messageFromOperator(messageCopy)
  }
}

export async function maybeTriggerBehavioralUi(
  storeId: string,
  shopDomain: string,
  sessionId: string
): Promise<void> {
  try {
    const decision = await fetchDecision(storeId, shopDomain, sessionId)
    if (!decision || !decision.decision) {
      return
    }

    const reason = decision.metadata?.reason || 'no_reason_provided'
    if (reason === 'cart_abandonment_detected' || decision.intervention_type === 'cart_recovery') {
      await snapshotActiveCart()
    }

    if (decision.shadow_mode) {
      await postShadowDecisionLog(
        shopDomain,
        sessionId,
        decision.strategy,
        reason,
        decision.metadata?.calculated_threshold
      )
      return
    }

    triggerActiveTidioIntervention(decision)
  } catch {
    // Never allow analytics or intervention errors to affect the storefront.
  }
}

initializeCartRecoveryWorker()
