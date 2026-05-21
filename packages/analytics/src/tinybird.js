const DEFAULT_TINYBIRD_HOST = 'https://api.europe-west2.gcp.tinybird.co'

export function getTinybirdHost(env = process.env) {
  return String(
    env.TINYBIRD_API_URL ||
      env.TINYBIRD_HOST ||
      DEFAULT_TINYBIRD_HOST
  ).replace(/\/+$/, '')
}

export function getTinybirdEventsApiUrl(env = process.env) {
  if (env.TINYBIRD_EVENTS_API_URL) {
    return env.TINYBIRD_EVENTS_API_URL
  }

  const datasource = env.TINYBIRD_RAW_EVENTS_DATASOURCE || 'raw_events'
  const branch = env.TINYBIRD_BRANCH ? `&branch=${encodeURIComponent(env.TINYBIRD_BRANCH)}` : ''
  return `${getTinybirdHost(env)}/v0/events?name=${encodeURIComponent(datasource)}${branch}`
}

export function getTinybirdQueryApiUrl(env = process.env) {
  if (env.TINYBIRD_QUERY_API_URL) {
    return env.TINYBIRD_QUERY_API_URL
  }

  return `${getTinybirdHost(env)}/v0/sql`
}

export function getTinybirdQueryToken(env = process.env) {
  return (
    env.TINYBIRD_API_KEY ||
    env.TINYBIRD_QUERY_TOKEN ||
    env.TINYBIRD_USER_TOKEN ||
    env.TINYBIRD_TOKEN ||
    null
  )
}

export function getTinybirdIngestToken(env = process.env) {
  return env.TINYBIRD_INGEST_TOKEN || env.TINYBIRD_TOKEN || null
}

export async function queryTinybirdSql({
  sql,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logLabel = 'TINYBIRD SQL'
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable for Tinybird queries')
  }

  const token = getTinybirdQueryToken(env)
  if (!token) {
    throw new Error('Missing Tinybird query token')
  }

  const response = await fetchImpl(getTinybirdQueryApiUrl(env), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      q: sql.includes('FORMAT ') ? sql : `${sql} FORMAT JSON`
    }).toString()
  })

  const text = await response.text().catch(() => '')

  if (!response.ok) {
    console.log(`${logLabel} FAILURE:`, response.status, text)
    throw new Error(`Tinybird query failed with status ${response.status}: ${text}`)
  }

  let parsed
  try {
    parsed = text ? JSON.parse(text) : { data: [] }
  } catch (error) {
    console.log(`${logLabel} PARSE FAILURE:`, text)
    throw new Error(`Tinybird query returned non-JSON payload: ${error.message}`)
  }

  const rows = Array.isArray(parsed.data) ? parsed.data.length : 0
  console.log(`${logLabel} SUCCESS:`, JSON.stringify({ rows }))
  return parsed
}

export function toTinybirdSqlString(value) {
  if (value == null) return 'NULL'
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
