import 'dotenv/config'
import {
  getTinybirdHost,
  getTinybirdQueryToken,
  queryTinybirdSql
} from '../packages/analytics/src/tinybird.js'
import {
  buildSessionFeaturesBaseCte,
  buildSessionFeaturesSelectSql
} from '../packages/analytics/src/session-features-sql.js'

function requireEnv(name, value) {
  if (value) return value
  throw new Error(`Missing required env var: ${name}`)
}

async function main() {
  requireEnv(
    'TINYBIRD_API_KEY or TINYBIRD_QUERY_TOKEN or TINYBIRD_USER_TOKEN or TINYBIRD_TOKEN',
    getTinybirdQueryToken(process.env)
  )
  requireEnv('TINYBIRD_API_URL or TINYBIRD_HOST', process.env.TINYBIRD_API_URL || process.env.TINYBIRD_HOST)

  console.log(`Checking Tinybird session features via ${getTinybirdHost(process.env)}`)

  const sampleSql = buildSessionFeaturesSelectSql({ limit: 5 })
  const sample = await queryTinybirdSql({
    env: process.env,
    logLabel: 'CHECK SESSION FEATURES SAMPLE',
    sql: sampleSql
  })

  console.log(`Recent session rows returned: ${Array.isArray(sample.data) ? sample.data.length : 0}`)
  if (Array.isArray(sample.data) && sample.data.length > 0) {
    console.table(sample.data.map((row) => ({
      store_id: row.store_id || '',
      shop_domain: row.shop_domain,
      session_id: row.session_id,
      variant: row.experiment_variant || '',
      events: row.total_events,
      purchased: row.purchased,
      reached_checkout: row.reached_checkout,
      last_seen_at: row.last_seen_at
    })))
  }

  const storeCounts = await queryTinybirdSql({
    env: process.env,
    logLabel: 'CHECK SESSION FEATURES STORE COUNTS',
    sql: `
      ${buildSessionFeaturesBaseCte()}
      SELECT
        store_id,
        count() AS sessions
      FROM session_features
      WHERE notEmpty(ifNull(store_id, ''))
      GROUP BY store_id
      ORDER BY sessions DESC, store_id ASC
      LIMIT 50
    `
  })

  console.log(`Unique store rows returned: ${Array.isArray(storeCounts.data) ? storeCounts.data.length : 0}`)
  console.table((storeCounts.data || []).map((row) => ({
    store_id: row.store_id,
    sessions: row.sessions
  })))

  const fallbackCounts = await queryTinybirdSql({
    env: process.env,
    logLabel: 'CHECK SESSION FEATURES FALLBACK COUNTS',
    sql: `
      ${buildSessionFeaturesBaseCte()}
      SELECT
        shop_domain,
        count() AS sessions
      FROM session_features
      WHERE empty(ifNull(store_id, ''))
      GROUP BY shop_domain
      ORDER BY sessions DESC, shop_domain ASC
      LIMIT 50
    `
  })

  console.log(`Fallback shop-domain rows returned: ${Array.isArray(fallbackCounts.data) ? fallbackCounts.data.length : 0}`)
  console.table((fallbackCounts.data || []).map((row) => ({
    shop_domain: row.shop_domain,
    sessions: row.sessions
  })))
}

main().catch((error) => {
  console.error('check:session-features failed:', error.message || error)
  process.exitCode = 1
})
