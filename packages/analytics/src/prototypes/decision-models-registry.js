export function buildDecisionModelRecord({
  modelKey = 'intervention_logistic_regression',
  modelVersion = 'prototype',
  featureSchemaVersion = 'v1',
  intercept = 0,
  coefficients = {},
  decisionThreshold = 0.5,
  status = 'draft',
  trainingMetadata = {}
} = {}) {
  return {
    model_key: String(modelKey),
    model_version: String(modelVersion),
    feature_schema_version: String(featureSchemaVersion),
    intercept: Number(intercept || 0),
    coefficients,
    decision_threshold: Number(decisionThreshold || 0.5),
    status: String(status),
    training_metadata: trainingMetadata
  }
}

export function buildDecisionModelScoreRecord({
  modelVersion = 'prototype',
  shopDomain = '',
  sessionId = '',
  features = {},
  probability = 0,
  linearScore = 0,
  decision = false
} = {}) {
  return {
    model_version: String(modelVersion),
    shop_domain: String(shopDomain || '').trim(),
    session_id: String(sessionId || '').trim(),
    features,
    probability: Number(probability || 0),
    linear_score: Number(linearScore || 0),
    decision: Boolean(decision)
  }
}
