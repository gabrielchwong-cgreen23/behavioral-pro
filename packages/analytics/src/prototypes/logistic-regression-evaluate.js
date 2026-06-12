export function sigmoid(value) {
  return 1 / (1 + Math.exp(-Number(value || 0)))
}

export function buildLogisticRegressionFeatureVector(session = {}) {
  const deviceType = String(session.device_type || '').trim().toLowerCase()

  return {
    intercept: 1,
    rage_click_count: Number(session.rage_click_count || 0),
    cta_idle_count: Number(session.cta_idle_count || 0),
    policy_page_views: Number(session.policy_page_views || 0),
    session_duration_seconds: Number(session.session_duration || 0),
    device_type_mobile: deviceType === 'mobile' ? 1 : 0,
    device_type_desktop: deviceType === 'desktop' ? 1 : 0,
    device_type_tablet: deviceType === 'tablet' ? 1 : 0
  }
}

export function evaluateLogisticRegressionDecision({
  session = {},
  model = {}
} = {}) {
  const features = buildLogisticRegressionFeatureVector(session)
  const intercept = Number(model.intercept || 0)
  const coefficients = model.coefficients || {}

  let linearScore = intercept

  for (const [featureName, featureValue] of Object.entries(features)) {
    if (featureName === 'intercept') continue
    const coefficient = Number(coefficients[featureName] || 0)
    linearScore += coefficient * Number(featureValue || 0)
  }

  const probability = sigmoid(linearScore)
  const threshold = Number(model.decision_threshold || 0.5)

  return {
    decision: probability >= threshold,
    probability,
    linear_score: linearScore,
    model_version: String(model.model_version || 'prototype'),
    feature_schema_version: String(model.feature_schema_version || 'v1'),
    features
  }
}
