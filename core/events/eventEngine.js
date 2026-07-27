const DEFAULT_CORE_VERSION = "footballbrain-core-v2";

function createAIEventEngine({ pool, coreVersion = DEFAULT_CORE_VERSION } = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("Event Engine : pool PostgreSQL invalide");
  }

  async function ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_events (
        id BIGSERIAL PRIMARY KEY,
        event_id UUID NOT NULL DEFAULT gen_random_uuid(),
        fixture_id INTEGER,
        event_type TEXT NOT NULL,
        event_category TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'FOOTBALLBRAIN_CORE',
        market_key TEXT,
        engine_name TEXT,
        previous_value JSONB,
        current_value JSONB,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        event_version TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (event_id)
      );

      CREATE INDEX IF NOT EXISTS ai_events_fixture_idx
      ON ai_events (fixture_id, occurred_at DESC);

      CREATE INDEX IF NOT EXISTS ai_events_type_idx
      ON ai_events (event_type, occurred_at DESC);

      CREATE INDEX IF NOT EXISTS ai_events_category_idx
      ON ai_events (event_category, occurred_at DESC);

      CREATE INDEX IF NOT EXISTS ai_events_market_idx
      ON ai_events (market_key, occurred_at DESC);

      CREATE INDEX IF NOT EXISTS ai_events_engine_idx
      ON ai_events (engine_name, occurred_at DESC);
    `);

    console.log("✅ FOOTBALLBRAIN CORE : table ai_events vérifiée");
  }

  function normalizeJSON(value) {
    if (value === undefined || value === null) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return { serializationError: true, value: String(value) };
    }
  }

  function normalizeName(value, fallback = "UNKNOWN") {
    const normalized = String(value || fallback)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return normalized || fallback;
  }

  async function emit({
    fixtureId = null,
    eventType,
    eventCategory,
    source = "FOOTBALLBRAIN_CORE",
    marketKey = null,
    engineName = null,
    previousValue = null,
    currentValue = null,
    metadata = {},
    occurredAt = null,
  } = {}) {
    if (!eventType) throw new Error("emitAIEvent : eventType manquant");
    if (!eventCategory) throw new Error("emitAIEvent : eventCategory manquante");

    const normalizedFixtureId = fixtureId == null ? null : Number(fixtureId);
    if (normalizedFixtureId !== null && (!Number.isInteger(normalizedFixtureId) || normalizedFixtureId <= 0)) {
      throw new Error("emitAIEvent : fixtureId invalide");
    }

    const result = await pool.query(
      `INSERT INTO ai_events (
        fixture_id, event_type, event_category, source, market_key, engine_name,
        previous_value, current_value, metadata, event_version, occurred_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10,
        COALESCE($11::timestamptz, NOW())
      ) RETURNING *`,
      [
        normalizedFixtureId,
        normalizeName(eventType),
        normalizeName(eventCategory),
        normalizeName(source, "FOOTBALLBRAIN_CORE"),
        marketKey ? normalizeName(marketKey) : null,
        engineName ? normalizeName(engineName) : null,
        previousValue === null ? null : JSON.stringify(normalizeJSON(previousValue)),
        currentValue === null ? null : JSON.stringify(normalizeJSON(currentValue)),
        JSON.stringify(normalizeJSON(metadata) || {}),
        coreVersion,
        occurredAt,
      ]
    );
    return result.rows[0];
  }

  async function getFixtureEvents(fixtureId, limit = 100) {
    const normalizedFixtureId = Number(fixtureId);
    if (!Number.isInteger(normalizedFixtureId) || normalizedFixtureId <= 0) {
      throw new Error("fixtureId invalide");
    }
    const normalizedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const result = await pool.query(
      `SELECT * FROM ai_events
       WHERE fixture_id = $1
       ORDER BY occurred_at ASC, id ASC
       LIMIT $2`,
      [normalizedFixtureId, normalizedLimit]
    );
    return result.rows;
  }

  return { coreVersion, ensureTables, emit, getFixtureEvents, normalizeJSON, normalizeName };
}

module.exports = { createAIEventEngine };
