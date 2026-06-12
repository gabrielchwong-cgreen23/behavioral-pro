export function buildMetricsPayload(shopDomain, overview) {
  const controlSessions = overview.sessionTable.filter((session) => session.variant === 'control')
  const variantSessions = overview.sessionTable.filter((session) => session.variant === 'variant')
  const exposedSessions = overview.sessionTable.filter(
    (session) => Array.isArray(session.messages_shown) && session.messages_shown.length > 0
  )
  const unexposedSessions = overview.sessionTable.filter(
    (session) => !Array.isArray(session.messages_shown) || session.messages_shown.length === 0
  )

  function summarize(sessions) {
    const purchases = sessions.filter((session) => session.converted).length
    const revenue = sessions.reduce((sum, session) => sum + Number(session.revenue || 0), 0)

    return {
      sessions: sessions.length,
      purchases,
      revenue,
      conversion_rate: sessions.length === 0 ? 0 : purchases / sessions.length,
      revenue_per_session: sessions.length === 0 ? 0 : revenue / sessions.length
    }
  }

  const control = summarize(controlSessions)
  const variant = summarize(variantSessions)
  const exposed = summarize(exposedSessions)
  const unexposed = summarize(unexposedSessions)
  const liftPercent = control.revenue_per_session === 0
    ? 0
    : ((variant.revenue_per_session - control.revenue_per_session) / control.revenue_per_session) * 100
  const exposureLiftPercent = unexposed.revenue_per_session === 0
    ? 0
    : ((exposed.revenue_per_session - unexposed.revenue_per_session) / unexposed.revenue_per_session) * 100
  const incrementalRevenueEstimate = Math.max(
    0,
    (variant.revenue_per_session - control.revenue_per_session) * variant.sessions
  )

  return {
    shop_domain: shopDomain,
    control,
    variant,
    exposed,
    unexposed,
    totals: overview.totals || {},
    lift_percent: liftPercent,
    exposure_rate: overview.sessionTable.length === 0 ? 0 : exposed.sessions / overview.sessionTable.length,
    exposure_lift_percent: exposureLiftPercent,
    incremental_revenue_estimate: incrementalRevenueEstimate
  }
}
