const DEFAULT_DECISION = Object.freeze({
  shouldTrigger: false,
  shopperState: 'browsing',
  interventionType: 'none',
  messageText: ''
})

function normalizeFlag(value) {
  return value === true
}

function normalizeSessionContext(sessionContext = {}) {
  return {
    productDwell12s: normalizeFlag(sessionContext.productDwell12s),
    reviewDwell10s: normalizeFlag(sessionContext.reviewDwell10s),
    addToCart: normalizeFlag(sessionContext.addToCart),
    couponFieldFocus: normalizeFlag(sessionContext.couponFieldFocus),
    checkoutBack: normalizeFlag(sessionContext.checkoutBack)
  }
}

export function inferShopperStateDecision(sessionContext = {}) {
  const flags = normalizeSessionContext(sessionContext)

  if (flags.checkoutBack) {
    return {
      shouldTrigger: true,
      shopperState: 'checkout_friction',
      interventionType: 'checkout_reassurance',
      messageText: 'Need help completing checkout? We can answer questions about payment, shipping, or order details.'
    }
  }

  if (flags.couponFieldFocus) {
    return {
      shouldTrigger: true,
      shopperState: 'price_sensitive',
      interventionType: 'offer_guidance',
      messageText: 'Looking for the best available offer? We can help clarify discounts, bundles, or shipping options.'
    }
  }

  if ((flags.productDwell12s || flags.reviewDwell10s) && !flags.addToCart) {
    return {
      shouldTrigger: true,
      shopperState: 'hesitant_interest',
      interventionType: 'product_reassurance',
      messageText: 'Questions about sizing or shipping? We are here to help.'
    }
  }

  return { ...DEFAULT_DECISION }
}

export function getDefaultStateInferenceDecision() {
  return { ...DEFAULT_DECISION }
}
