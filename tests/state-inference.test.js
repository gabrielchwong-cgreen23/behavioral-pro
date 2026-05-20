import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getDefaultStateInferenceDecision,
  inferShopperStateDecision
} from '../packages/analytics/src/index.js'

test('state inference defaults to browsing with no trigger', () => {
  assert.deepEqual(inferShopperStateDecision({}), {
    shouldTrigger: false,
    shopperState: 'browsing',
    interventionType: 'none',
    messageText: ''
  })
})

test('state inference maps hesitant interest from dwell without cart add', () => {
  assert.deepEqual(inferShopperStateDecision({
    productDwell12s: true,
    reviewDwell10s: true,
    addToCart: false,
    couponFieldFocus: false,
    checkoutBack: false
  }), {
    shouldTrigger: true,
    shopperState: 'hesitant_interest',
    interventionType: 'product_reassurance',
    messageText: 'Questions about sizing or shipping? We are here to help.'
  })
})

test('state inference maps price sensitivity from coupon focus', () => {
  assert.deepEqual(inferShopperStateDecision({
    couponFieldFocus: true
  }), {
    shouldTrigger: true,
    shopperState: 'price_sensitive',
    interventionType: 'offer_guidance',
    messageText: 'Looking for the best available offer? We can help clarify discounts, bundles, or shipping options.'
  })
})

test('state inference prioritizes checkout friction over lower-intent states', () => {
  assert.deepEqual(inferShopperStateDecision({
    productDwell12s: true,
    couponFieldFocus: true,
    checkoutBack: true
  }), {
    shouldTrigger: true,
    shopperState: 'checkout_friction',
    interventionType: 'checkout_reassurance',
    messageText: 'Need help completing checkout? We can answer questions about payment, shipping, or order details.'
  })
})

test('default decision helper returns the browsing fallback policy', () => {
  assert.deepEqual(getDefaultStateInferenceDecision(), {
    shouldTrigger: false,
    shopperState: 'browsing',
    interventionType: 'none',
    messageText: ''
  })
})
