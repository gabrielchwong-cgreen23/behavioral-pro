'use client'

import { useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Button,
  Card,
  FormLayout,
  Modal,
  Select,
  TextField,
  Text,
  Toast
} from '@shopify/polaris'

type FeedbackType = 'Bug Report' | 'Feature Recommendation'

type FeedbackCardProps = {
  shopDomain?: string
}

type FeedbackPayload = {
  shopDomain: string
  route: string
  submittedAt: string
  type: FeedbackType
  description: string
}

type FeedbackResponse = {
  ok: boolean
  userErrors: Array<{
    field?: string[]
    message: string
  }>
}

const feedbackTypeOptions = [
  { label: 'Bug Report', value: 'Bug Report' },
  { label: 'Feature Recommendation', value: 'Feature Recommendation' }
]

function inferShopDomain(explicitShopDomain?: string, params?: URLSearchParams | null) {
  if (explicitShopDomain?.trim()) {
    return explicitShopDomain.trim()
  }

  const fromQuery = params?.get('shop') || params?.get('shop_domain')
  if (fromQuery?.trim()) {
    return fromQuery.trim()
  }

  if (typeof window === 'undefined') {
    return ''
  }

  const fromWindow = (window as Window & {
    shopify?: { config?: { shop?: string } }
  }).shopify?.config?.shop

  return String(fromWindow || '').trim()
}

export function FeedbackCard({ shopDomain }: FeedbackCardProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [modalOpen, setModalOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [feedbackType, setFeedbackType] = useState<FeedbackType>('Bug Report')
  const [description, setDescription] = useState('')
  const [toastContent, setToastContent] = useState<string | null>(null)
  const [inlineError, setInlineError] = useState<string | null>(null)

  const resolvedShopDomain = useMemo(
    () => inferShopDomain(shopDomain, searchParams),
    [shopDomain, searchParams]
  )

  const currentRoute = useMemo(() => {
    const query = searchParams?.toString()
    return query ? `${pathname}?${query}` : pathname || '/'
  }, [pathname, searchParams])

  async function handleSubmit() {
    const trimmedDescription = description.trim()

    if (!trimmedDescription) {
      setInlineError('Please share a little detail so we can help.')
      return
    }

    setSubmitting(true)
    setInlineError(null)

    const payload: FeedbackPayload = {
      shopDomain: resolvedShopDomain,
      route: currentRoute,
      submittedAt: new Date().toISOString(),
      type: feedbackType,
      description: trimmedDescription
    }

    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      const result = (await response.json()) as FeedbackResponse

      if (!response.ok || result.userErrors?.length) {
        const firstError = result.userErrors?.[0]?.message || 'We could not save your feedback.'
        setInlineError(firstError)
        return
      }

      setDescription('')
      setFeedbackType('Bug Report')
      setToastContent('Thanks for the feedback.')
      setModalOpen(false)
    } catch {
      setInlineError('We could not save your feedback right now. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Card>
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <Text as="h2" variant="headingSm">
            Help Us Improve
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Found a bug or have an idea? Send it in without leaving this page.
          </Text>
          <div>
            <Button variant="plain" onClick={() => setModalOpen(true)}>
              Share quick feedback →
            </Button>
          </div>
        </div>
      </Card>

      <Modal
        open={modalOpen}
        onClose={() => {
          if (!submitting) {
            setModalOpen(false)
            setInlineError(null)
          }
        }}
        title="Share quick feedback"
        primaryAction={{
          content: 'Send feedback',
          onAction: handleSubmit,
          loading: submitting
        }}
        secondaryActions={[
          {
            content: 'Cancel',
            onAction: () => {
              setModalOpen(false)
              setInlineError(null)
            },
            disabled: submitting
          }
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <Select
              label="Type"
              options={feedbackTypeOptions}
              value={feedbackType}
              onChange={(value) => setFeedbackType(value as FeedbackType)}
            />
            <TextField
              label="Description"
              value={description}
              onChange={setDescription}
              multiline={4}
              autoComplete="off"
              placeholder="What happened, or what would you love to see?"
              error={inlineError || undefined}
            />
            <Text as="p" tone="subdued" variant="bodySm">
              Context is captured automatically: shop, current route, and timestamp.
            </Text>
          </FormLayout>
        </Modal.Section>
      </Modal>

      {toastContent ? (
        <Toast content={toastContent} onDismiss={() => setToastContent(null)} />
      ) : null}
    </>
  )
}

export default FeedbackCard
