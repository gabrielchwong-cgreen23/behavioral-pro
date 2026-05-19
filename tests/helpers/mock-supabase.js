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
      experiment_sessions: clone(seed.experiment_sessions || []),
      events: clone(seed.events || [])
    }
    this.nextIds = {
      stores: this.getNextId('stores'),
      experiment_sessions: this.getNextId('experiment_sessions'),
      events: this.getNextId('events')
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

    const index = this.tables[table].findIndex(existing => existing[conflictColumn] === row[conflictColumn])
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
}

export function createMockSupabase(seed = {}) {
  const store = new MockSupabaseStore(seed)

  return {
    _store: store,
    from(table) {
      return new QueryBuilder(store, table)
    }
  }
}
