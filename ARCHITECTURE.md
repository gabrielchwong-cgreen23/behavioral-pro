# BehavioralPro Architecture

## System Shape

BehavioralPro is organized around two different kinds of state:

- Control state lives in Supabase.
  It answers: which store is installed, which session was assigned, which variant is active, and which legacy analytics rows exist for compatibility.

- Event state lives in Tinybird.
  It answers: what the shopper actually did, in what order, how those actions roll up into live session features, and whether the current session looks intervention-worthy.

The storefront and pixel layers are the producers.
The Express and Next API routes are the orchestration layer.
Tinybird is the live behavioral event engine.
Supabase is the authoritative control and compatibility store.

## Core Data Flow

### End-to-End Path

Storefront behavior starts in two places:

- Theme extension UI in [extensions/behavior-pro/blocks/star_rating.liquid](/Users/gabrielwong/Desktop/behavioral-pro/extensions/behavior-pro/blocks/star_rating.liquid)
  This script assigns a shopper to a variant, watches key interactions, emits normalized behavioral events, and can trigger the intervention UI.

- Shopify web pixel in [extensions/behavioral-telemetry/src/index.ts](/Users/gabrielwong/Desktop/behavioral-pro/extensions/behavioral-telemetry/src/index.ts)
  This listens to Shopify customer events and forwards a second stream of behavioral telemetry into the same ingestion route.

Those producers send events to `/api/events` in [app.js](/Users/gabrielwong/Desktop/behavioral-pro/app.js).

From there, the flow is:

Storefront or Pixel Event
→ request validation, rate limiting, bot filtering, and session ownership checks
→ normalized Phase 1 event record
→ Tinybird raw event ingest
→ optional mirror into Supabase-backed legacy analytics
→ Tinybird pipes and SQL roll raw events into session features and store benchmarks
→ `/api/intervention-decision` reads those live features
→ decision result comes back to the storefront
→ UI either stays quiet, shadow-logs the decision, or triggers the intervention experience

### Decision Loop

The live decision loop is intentionally read-after-write:

- `/api/events` appends behavioral facts.
- Tinybird computes the current session state from those facts.
- `/api/intervention-decision` reads the computed session state plus store-level benchmark context.
- The storefront decides whether to render intervention UI now, later, or only log a shadow decision.

This means the intervention engine is driven by event history, not by mutable server session flags.

### Main Read Models

- Raw event stream:
  Tinybird datasource in [tinybird-analytics/datasources/raw_events.datasource](/Users/gabrielwong/Desktop/behavioral-pro/tinybird-analytics/datasources/raw_events.datasource)

- Session feature rollup:
  Tinybird pipe in [tinybird-analytics/pipes/v1_session_features.sql](/Users/gabrielwong/Desktop/behavioral-pro/tinybird-analytics/pipes/v1_session_features.sql)

- Server-side decision evaluation:
  [packages/analytics/src/intervention-decision.js](/Users/gabrielwong/Desktop/behavioral-pro/packages/analytics/src/intervention-decision.js) and [app.js](/Users/gabrielwong/Desktop/behavioral-pro/app.js)

- Next route version of the decision endpoint:
  [src/app/api/intervention-decision/route.ts](/Users/gabrielwong/Desktop/behavioral-pro/src/app/api/intervention-decision/route.ts)

## State Boundaries

### Supabase: Control State

Supabase is responsible for durable control-plane records:

- `stores`
  Installation-level identity and access metadata for each shop.

- `experiment_sessions`
  Session assignment state.
  This is where the system remembers that a given shop/session pair belongs to control or variant.

- `events`
  Legacy or compatibility analytics mirror.
  This is not the primary behavioral engine; it exists so older analytics views and owner dashboards still work.

Conceptually, Supabase answers:

- Is this store known?
- Has this session already been assigned?
- Which experiment variant owns this shopper session?
- What legacy analytics rows should still be visible to internal tooling?

### Tinybird: Event State

Tinybird is responsible for the append-only behavioral stream and the derived read models built from it:

- Raw facts are ingested as one event per shopper interaction.
- Events are deduplicated and ordered into a session timeline.
- Session features are derived from event history, not stored directly by the app server.
- Store-level benchmarks are derived from many historical sessions.

Conceptually, Tinybird answers:

- What has happened in this session so far?
- Has the shopper shown friction, idleness, or abandonment signals?
- How does this session compare to the store’s own history?
- Should an intervention fire right now?

### Boundary Rule of Thumb

If the state is about identity, entitlement, assignment, or administrative ownership, it belongs in Supabase.

If the state is about shopper behavior, event chronology, live session features, or decision inputs, it belongs in Tinybird.

### Important Architectural Nuance

The server currently bridges both worlds:

- It refuses most event ingestion unless the session already exists in Supabase.
- It forwards accepted events into Tinybird as the primary source of behavioral truth.
- It can optionally mirror some of those same events back into Supabase for legacy analytics compatibility.

So the runtime pattern is:

Supabase authorizes and anchors the session.
Tinybird interprets the behavior inside that session.

## Critical Dependencies

### Shopify Identity and Request Trust

[app.js](/Users/gabrielwong/Desktop/behavioral-pro/app.js)

- `SHOPIFY_API_KEY`
  Required to validate Shopify session tokens and support embedded/admin-authenticated routes.

- `SHOPIFY_API_SECRET`
  Required for Shopify session-token verification, webhook verification, and as the fallback ingest-signing secret.

- `INGEST_SIGNING_SECRET`
  Optional override for signed ingestion requests.
  If absent, the app falls back to `SHOPIFY_API_SECRET`.

[scripts/create-web-pixel-oauth.js](/Users/gabrielwong/Desktop/behavioral-pro/scripts/create-web-pixel-oauth.js)

- `SHOPIFY_CLIENT_SECRET` or `SHOPIFY_API_SECRET`
  Required for the pixel OAuth helper script.

### Supabase Control Plane

[app.js](/Users/gabrielwong/Desktop/behavioral-pro/app.js)

- `SUPABASE_URL`
  Required to create the Supabase client used for stores, session assignment, and legacy analytics tables.

- `SUPABASE_SERVICE_ROLE_KEY`
  Required with `SUPABASE_URL` for privileged server-side reads and writes.

[packages/analytics/src/index.js](/Users/gabrielwong/Desktop/behavioral-pro/packages/analytics/src/index.js)

- No direct Supabase env lookup here.
  This package depends on a Supabase client being injected by the server.

- `ANALYTICS_DATA_DIRECTORY`
  Used only when the analytics package runs in file-backed mode instead of Supabase-backed mode.

### Tinybird Event Pipeline and Live Decisioning

[app.js](/Users/gabrielwong/Desktop/behavioral-pro/app.js)

- Depends indirectly on Tinybird credentials through the helper module for:
  event forwarding, session feature health checks, store benchmark queries, and intervention decisions.

- `BEHAVIORALPRO_AOV_COHORTS`
  Optional JSON map used to override or assign cohort behavior for decisioning.

[packages/analytics/src/tinybird.js](/Users/gabrielwong/Desktop/behavioral-pro/packages/analytics/src/tinybird.js)

- `TINYBIRD_API_URL` or `TINYBIRD_HOST`
  Base host for Tinybird API requests.

- `TINYBIRD_EVENTS_API_URL`
  Optional direct override for the event-ingest endpoint.

- `TINYBIRD_QUERY_API_URL`
  Optional direct override for the SQL query endpoint.

- `TINYBIRD_RAW_EVENTS_DATASOURCE`
  Optional datasource name override for raw event ingest.

- `TINYBIRD_BRANCH`
  Optional branch scoping for event ingest URL construction.

- Query token resolution:
  `TINYBIRD_API_KEY`, `TINYBIRD_QUERY_TOKEN`, `TINYBIRD_USER_TOKEN`, or `TINYBIRD_TOKEN`

- Ingest token resolution:
  `TINYBIRD_INGEST_TOKEN` or `TINYBIRD_TOKEN`

[src/app/api/intervention-decision/route.ts](/Users/gabrielwong/Desktop/behavioral-pro/src/app/api/intervention-decision/route.ts)

- `TINYBIRD_API_URL` or `TINYBIRD_HOST`
  Used to build the pipe URL.

- `TINYBIRD_API_KEY`
  Required by the Next route version of the live decision endpoint.

[scripts/check-session-features.js](/Users/gabrielwong/Desktop/behavioral-pro/scripts/check-session-features.js) and [scripts/validate-session-features.js](/Users/gabrielwong/Desktop/behavioral-pro/scripts/validate-session-features.js)

- `TINYBIRD_API_URL` or `TINYBIRD_HOST`
  Used by validation and health scripts that inspect the Tinybird session-feature layer.

### Owner and Internal Access

[app.js](/Users/gabrielwong/Desktop/behavioral-pro/app.js) and [packages/owner-analytics/src/index.js](/Users/gabrielwong/Desktop/behavioral-pro/packages/owner-analytics/src/index.js)

- `ANALYTICS_OWNER_TOKEN`
  Required for owner-only analytics and health-report routes.

### Runtime and Feature Flags

[app.js](/Users/gabrielwong/Desktop/behavioral-pro/app.js)

- `BEHAVIORALPRO_ENABLE_LEGACY_ASSIGNMENT_MIRROR`
  Controls whether assignment events are mirrored into the legacy analytics layer.

- `BEHAVIORALPRO_ENABLE_SUPABASE_RAW_EVENT_MIRROR`
  Controls whether non-assignment events are mirrored into Supabase-backed legacy analytics.

- `BEHAVIORALPRO_JSON_LIMIT`
  Sets the JSON body size limit for incoming requests.

- `PORT`
  Server listen port.

### Script-Level Local Simulation

[scripts/simulate-phase1-session.js](/Users/gabrielwong/Desktop/behavioral-pro/scripts/simulate-phase1-session.js)

- `BEHAVIORALPRO_BACKEND_BASE` or `BACKEND_BASE`
- `BEHAVIORALPRO_SHOP_DOMAIN`
- `BEHAVIORALPRO_SESSION_ID`
- `BEHAVIORALPRO_VISITOR_ID`
- `BEHAVIORALPRO_PAGE_URL`
- `BEHAVIORALPRO_REFERRER`

[scripts/validate-session-features.js](/Users/gabrielwong/Desktop/behavioral-pro/scripts/validate-session-features.js)

- `BEHAVIORALPRO_BACKEND_BASE`
- `BEHAVIORALPRO_SHOP_DOMAIN`
- `BEHAVIORALPRO_VALIDATION_TIMEOUT_MS`
- `BEHAVIORALPRO_VALIDATION_POLL_MS`

## Mental Model Summary

Think of the architecture as two planes sharing a session key:

- Supabase is the control plane.
  It knows who the store is, whether the session exists, and which experiment branch owns it.

- Tinybird is the behavioral plane.
  It knows what the shopper has done, what that behavior means, and whether the UI should intervene.

The APIs in [app.js](/Users/gabrielwong/Desktop/behavioral-pro/app.js) sit in the middle as the translator:

- They admit or reject traffic based on control state and trust rules.
- They project accepted traffic into the event plane.
- They read back a live behavioral interpretation and hand that answer to the UI.

That is the core architectural contract of the system.
