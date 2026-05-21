import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSessionFeaturesBaseCte,
  buildSessionFeaturesSelectSql
} from '../packages/analytics/src/session-features-sql.js'

test('session feature SQL includes dedupe, fallback-safe grouping, and objective counts', () => {
  const cte = buildSessionFeaturesBaseCte()
  const sql = buildSessionFeaturesSelectSql({
    whereClause: "shop_domain = 'alpha.myshopify.com'",
    limit: 10
  })

  assert.match(cte, /GROUP BY event_id/)
  assert.match(cte, /GROUP BY shop_domain, session_id/)
  assert.match(cte, /discount_code_success_count/)
  assert.match(cte, /scroll_100_count/)
  assert.match(sql, /provisional_abandoned_checkout/)
  assert.match(sql, /session_inactive_30m/)
  assert.match(sql, /WHERE shop_domain = 'alpha\.myshopify\.com'/)
  assert.match(sql, /LIMIT 10/)
})
