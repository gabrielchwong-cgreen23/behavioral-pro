function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

class QueryBuilder {
  constructor(store, table) {
    this.store = store
    this.table = table
    this.mode = 'select'
    this.filters = []
    this.sort = null
    this.insertRows = null
    this.upsertRows = null
    this.upsertOptions = null
    this.resultMode = 'many'
  }

  select() {
    return this
  }

  eq(column, value) {
    this.filters.push({ column, value })
    return this
  }

  order(column, options = {}) {
    this.sort = {
      column,
      ascending: options.ascending !== false
    }
    return this
  }

  insert(rows) {
    this.mode = 'insert'
    this.insertRows = rows
    return this
  }

  upsert(rows, options = {}) {
    this.mode = 'upsert'
    this.upsertRows = rows
    this.upsertOptions = options
    return this
  }

  maybeSingle() {
    this.resultMode = 'maybeSingle'
    return this
  }

  single() {
    this.resultMode = 'single'
    return this
  }

  async execute() {
    const rows = this.store.tables[this.table]

    if (!rows) {
      return {
        data: null,
        error: { message: `Unknown table: ${this.table}` }
      }
    }

    if (this.mode === 'insert') {
      const inserted = this.insertRows.map(row => this.store.insert(this.table, row))
      return {
        data: this.finish(inserted),
        error: null
      }
    }

    if (this.mode === 'upsert') {
      const conflictColumn = this.upsertOptions?.onConflict
      const upserted = this.upsertRows.map(row => this.store.upsert(this.table, row, conflictColumn))
      return {
        data: this.finish(upserted),
        error: null
      }
    }

    let result = rows.filter(row =>
      this.filters.every(filter => row[filter.column] === filter.value)
    )

    if (this.sort) {
      result = [...result].sort((left, right) => {
        const leftValue = left[this.sort.column]
        const rightValue = right[this.sort.column]
        if (leftValue === rightValue) return 0
        const comparison = leftValue < rightValue ? -1 : 1
        return this.sort.ascending ? comparison : -comparison
      })
    } else {
      result = [...result]
    }

    return {
      data: this.finish(result),
      error: null
    }
  }

  finish(rows) {
    if (this.resultMode === 'single') {
      return clone(rows[0] || null)
    }

    if (this.resultMode === 'maybeSingle') {
      return rows[0] ? clone(rows[0]) : null
    }

    return clone(rows)
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject)
  }
}

class MockSupabaseStore {
  constructor(seed = {}) {
    this.tables = {
      stores: clone(seed.stores || []),
      performance_metrics: clone(seed.performance_metrics || []),
      store_benchmarks: clone(seed.store_benchmarks || []),
      experiment_sessions: clone(seed.experiment_sessions || []),
      events: clone(seed.events || []),
      session_state: clone(seed.session_state || []),
      storefront_intervention_variants: clone(seed.storefront_intervention_variants || []),
      storefront_trajectory_bandit_state: clone(seed.storefront_trajectory_bandit_state || []),
      storefront_intervention_sessions: clone(seed.storefront_intervention_sessions || [])
    }
    this.nextIds = {
      stores: this.getNextId('stores'),
      performance_metrics: this.getNextId('performance_metrics'),
      store_benchmarks: this.getNextId('store_benchmarks'),
      experiment_sessions: this.getNextId('experiment_sessions'),
      events: this.getNextId('events'),
      session_state: this.getNextId('session_state'),
      storefront_intervention_variants: this.getNextId('storefront_intervention_variants'),
      storefront_trajectory_bandit_state: this.getNextId('storefront_trajectory_bandit_state'),
      storefront_intervention_sessions: this.getNextId('storefront_intervention_sessions')
    }
  }

  getNextId(table) {
    const max = this.tables[table].reduce((current, row) => Math.max(current, Number(row.id || 0)), 0)
    return max + 1
  }

  insert(table, row) {
    const inserted = clone(row)
    if (inserted.id == null) {
      inserted.id = this.nextIds[table]
      this.nextIds[table] += 1
    }
    this.tables[table].push(inserted)
    return inserted
  }

  upsert(table, row, conflictColumn) {
    if (!conflictColumn) {
      return this.insert(table, row)
    }

    const conflictColumns = String(conflictColumn)
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
    const index = this.tables[table].findIndex(existing =>
      conflictColumns.every(column => existing[column] === row[column])
    )
    if (index === -1) {
      return this.insert(table, row)
    }

    const next = {
      ...this.tables[table][index],
      ...clone(row)
    }
    this.tables[table][index] = next
    return next
  }

  rpc(functionName, args = {}) {
    if (functionName !== 'upsert_session_state_counters') {
      return {
        data: null,
        error: { message: `Unknown rpc: ${functionName}` }
      }
    }

    const {
      p_shop_domain,
      p_session_id,
      p_store_id,
      p_visitor_id,
      p_experiment_variant,
      p_page_url,
      p_referrer,
      p_seen_at,
      p_counter_deltas,
      p_signal_updates
    } = args

    const shopDomain = p_shop_domain
    const sessionId = p_session_id
    const seenAt = p_seen_at || new Date().toISOString()
    const counters = p_counter_deltas && typeof p_counter_deltas === 'object'
      ? clone(p_counter_deltas)
      : {}
    const signals = p_signal_updates && typeof p_signal_updates === 'object'
      ? clone(p_signal_updates)
      : {}

    const index = this.tables.session_state.findIndex(row =>
      row.shop_domain === shopDomain && row.session_id === sessionId
    )

    if (index === -1) {
      const inserted = this.insert('session_state', {
        shop_domain: shopDomain,
        session_id: sessionId,
        store_id: p_store_id || null,
        visitor_id: p_visitor_id || null,
        experiment_variant: p_experiment_variant || null,
        page_url: p_page_url || null,
        referrer: p_referrer || null,
        counters,
        signals,
        first_seen_at: seenAt,
        last_seen_at: seenAt,
        first_intervention_triggered_at:
          Number(counters.intervention_triggered_count || 0) > 0 ? seenAt : null,
        updated_at: seenAt
      })
      return { data: clone(inserted), error: null }
    }

    const existing = this.tables.session_state[index]
    const mergedCounters = {
      ...(existing.counters || {})
    }
    const mergedSignals = {
      ...(existing.signals || {})
    }

    for (const [key, value] of Object.entries(counters)) {
      mergedCounters[key] = Number(mergedCounters[key] || 0) + Number(value || 0)
    }

    for (const [key, value] of Object.entries(signals)) {
      mergedSignals[key] = value
    }

    const next = {
      ...existing,
      store_id: p_store_id || existing.store_id || null,
      visitor_id: p_visitor_id || existing.visitor_id || null,
      experiment_variant: p_experiment_variant || existing.experiment_variant || null,
      page_url: p_page_url || existing.page_url || null,
      referrer: p_referrer || existing.referrer || null,
      counters: mergedCounters,
      signals: mergedSignals,
      first_seen_at: existing.first_seen_at || seenAt,
      last_seen_at: seenAt,
      first_intervention_triggered_at:
        existing.first_intervention_triggered_at ||
        (Number(counters.intervention_triggered_count || 0) > 0 ? seenAt : null),
      updated_at: seenAt
    }

    this.tables.session_state[index] = next
    return { data: clone(next), error: null }
  }
}

export function createMockSupabase(seed = {}) {
  const store = new MockSupabaseStore(seed)

  return {
    _store: store,
    from(table) {
      return new QueryBuilder(store, table)
    },
    async rpc(functionName, args) {
      return store.rpc(functionName, args)
    }
  }
}
