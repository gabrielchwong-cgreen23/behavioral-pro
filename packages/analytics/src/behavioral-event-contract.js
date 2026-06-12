const SNAKE_CASE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const UUID_OR_HASH_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

export function mapStorefrontSignalToBehavioralEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('input must be an object')
  }

  const anonymousId = String(input.anonymous_id || '').trim()
  const sessionId = String(input.session_id || '').trim()
  const eventName = String(input.event_name || '').trim()
  const timestamp = Number(input.timestamp)
  const properties = input.properties

  if (!anonymousId || !UUID_OR_HASH_PATTERN.test(anonymousId)) {
    throw new Error('anonymous_id must be a non-empty UUID/hash string')
  }

  if (!sessionId || !UUID_OR_HASH_PATTERN.test(sessionId)) {
    throw new Error('session_id must be a non-empty session hash string')
  }

  if (!eventName || !SNAKE_CASE_PATTERN.test(eventName)) {
    throw new Error('event_name must be snake_case')
  }

  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new Error('timestamp must be a Unix epoch integer in seconds')
  }

  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('properties must be an object')
  }

  return {
    anonymous_id: anonymousId,
    session_id: sessionId,
    event_name: eventName,
    timestamp,
    properties
  }
}
