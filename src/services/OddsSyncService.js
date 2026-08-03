"use strict";

const DEFAULT_TIMEZONE = "Europe/Paris";
const DEFAULT_SYNC_HOURS = 3;
const DEFAULT_NEAR_KICKOFF_INTERVAL_MINUTES = 15;
const DEFAULT_NEAR_KICKOFF_MAX_MINUTES = 100;
const DEFAULT_NEAR_KICKOFF_MIN_MINUTES = 20;

function toNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeMarketKeyFromApi(betName, valueName) {
  const bet = normalizeText(betName);
  const value = normalizeText(valueName);

  if (
    bet.includes("match winner") ||
    bet === "1x2" ||
    bet.includes("winner")
  ) {
    if (["home", "1", "domicile"].includes(value)) return "HOME";
    if (["draw", "x", "nul"].includes(value)) return "DRAW";
    if (["away", "2", "exterieur"].includes(value)) return "AWAY";
  }

  if (
    bet.includes("both teams") ||
    bet.includes("btts") ||
    bet.includes("les deux equipes")
  ) {
    if (["yes", "oui", "true"].includes(value)) return "BTTS_YES";
    if (["no", "non", "false"].includes(value)) return "BTTS_NO";
  }

  if (
    bet.includes("over/under") ||
    bet.includes("goals over") ||
    bet.includes("total goals") ||
    bet.includes("buts")
  ) {
    if (/^over\s*2[.,]5$/.test(value) || value === "over 2.5") {
      return "OVER25";
    }
    if (/^under\s*2[.,]5$/.test(value) || value === "under 2.5") {
      return "UNDER25";
    }
  }

  return null;
}

function parisDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function bookmakerPriority(name, id) {
  const normalized = normalizeText(name);
  if (Number(id) === 4 || normalized.includes("pinnacle")) return 1;
  if (Number(id) === 8 || normalized.includes("bet365")) return 2;
  if (Number(id) === 16 || normalized.includes("unibet")) return 3;
  return 100;
}

function createOddsSyncService({
  app,
  pool,
  callApiFootball,
  schedulersEnabled = true,
  adminGuard = null,
} = {}) {
  if (!app || !pool || typeof callApiFootball !== "function") {
    throw new Error("OddsSyncService: app, pool et callApiFootball sont obligatoires.");
  }

  let dateTimer = null;
  let nearKickoffTimer = null;
  let initialTimer = null;
  let syncingDate = false;
  let syncingNearKickoff = false;

  async function ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS market_odds (
        id BIGSERIAL PRIMARY KEY,
        fixture_id BIGINT NOT NULL,
        market_key TEXT NOT NULL,
        bookmaker_id INTEGER,
        bookmaker_name TEXT,
        odd NUMERIC(12, 4) NOT NULL,
        source TEXT NOT NULL DEFAULT 'API_FOOTBALL',
        api_updated_at TIMESTAMPTZ,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_current BOOLEAN NOT NULL DEFAULT TRUE,
        raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (fixture_id, market_key, bookmaker_id)
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_market_odds_fixture_market_current
      ON market_odds(fixture_id, market_key, is_current, captured_at DESC);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_market_odds_captured_at
      ON market_odds(captured_at DESC);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS odds_sync_runs (
        id BIGSERIAL PRIMARY KEY,
        sync_type TEXT NOT NULL,
        target TEXT,
        status TEXT NOT NULL DEFAULT 'RUNNING',
        pages INTEGER NOT NULL DEFAULT 0,
        fixtures INTEGER NOT NULL DEFAULT 0,
        odds_saved INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      );
    `);
  }

  async function beginRun(syncType, target) {
    const result = await pool.query(
      `INSERT INTO odds_sync_runs(sync_type, target) VALUES ($1, $2) RETURNING id`,
      [syncType, target]
    );
    return result.rows[0]?.id || null;
  }

  async function finishRun(runId, data = {}, error = null) {
    if (!runId) return;
    await pool.query(
      `
        UPDATE odds_sync_runs
        SET status = $2,
            pages = $3,
            fixtures = $4,
            odds_saved = $5,
            error_message = $6,
            finished_at = NOW()
        WHERE id = $1
      `,
      [
        runId,
        error ? "FAILED" : "SUCCESS",
        Number(data.pages || 0),
        Number(data.fixtures || 0),
        Number(data.oddsSaved || 0),
        error ? String(error.message || error).slice(0, 2000) : null,
      ]
    );
  }

  function extractOddsRows(apiItem = {}) {
    const fixtureId = toNumber(apiItem?.fixture?.id, null);
    if (!fixtureId) return [];

    const apiUpdatedAt = apiItem?.update || null;
    const bookmakers = Array.isArray(apiItem?.bookmakers)
      ? apiItem.bookmakers
      : [];
    const rows = [];

    for (const bookmaker of bookmakers) {
      const bookmakerId = toNumber(bookmaker?.id, null);
      const bookmakerName = bookmaker?.name || null;
      const bets = Array.isArray(bookmaker?.bets) ? bookmaker.bets : [];

      for (const bet of bets) {
        const values = Array.isArray(bet?.values) ? bet.values : [];
        for (const value of values) {
          const marketKey = normalizeMarketKeyFromApi(bet?.name, value?.value);
          const odd = toNumber(value?.odd, null);
          if (!marketKey || odd === null || odd <= 1) continue;

          rows.push({
            fixtureId,
            marketKey,
            bookmakerId,
            bookmakerName,
            odd,
            apiUpdatedAt,
            rawPayload: {
              betId: bet?.id ?? null,
              betName: bet?.name ?? null,
              value: value?.value ?? null,
              suspended: value?.suspended ?? null,
              main: value?.main ?? null,
            },
          });
        }
      }
    }

    return rows;
  }

  async function saveRows(rows = []) {
    let saved = 0;
    for (const row of rows) {
      await pool.query(
        `
          INSERT INTO market_odds (
            fixture_id, market_key, bookmaker_id, bookmaker_name,
            odd, source, api_updated_at, captured_at,
            is_current, raw_payload
          ) VALUES (
            $1, $2, $3, $4,
            $5, 'API_FOOTBALL', $6, NOW(),
            TRUE, $7::jsonb
          )
          ON CONFLICT (fixture_id, market_key, bookmaker_id)
          DO UPDATE SET
            bookmaker_name = EXCLUDED.bookmaker_name,
            odd = EXCLUDED.odd,
            source = EXCLUDED.source,
            api_updated_at = EXCLUDED.api_updated_at,
            captured_at = NOW(),
            is_current = TRUE,
            raw_payload = EXCLUDED.raw_payload
        `,
        [
          row.fixtureId,
          row.marketKey,
          row.bookmakerId,
          row.bookmakerName,
          row.odd,
          row.apiUpdatedAt,
          JSON.stringify(row.rawPayload || {}),
        ]
      );
      saved += 1;
    }
    return saved;
  }

  async function syncDate(date = parisDate()) {
    if (syncingDate) {
      return { ok: true, skipped: true, reason: "DATE_SYNC_ALREADY_RUNNING", date };
    }

    syncingDate = true;
    await ensureTables();
    const runId = await beginRun("DATE", date);
    let page = 1;
    let totalPages = 1;
    let fixtures = 0;
    let oddsSaved = 0;

    try {
      do {
        const response = await callApiFootball("/odds", {
          date,
          timezone: DEFAULT_TIMEZONE,
          page,
        }, { forceRefresh: true });

        const payload = response?.data || {};
        const items = Array.isArray(payload?.response) ? payload.response : [];
        totalPages = Math.max(1, Number(payload?.paging?.total || 1));
        fixtures += items.length;

        for (const item of items) {
          oddsSaved += await saveRows(extractOddsRows(item));
        }

        page += 1;
      } while (page <= totalPages);

      const result = {
        ok: true,
        date,
        pages: totalPages,
        fixtures,
        oddsSaved,
        syncedAt: new Date().toISOString(),
      };
      await finishRun(runId, result);
      return result;
    } catch (error) {
      await finishRun(runId, { pages: page - 1, fixtures, oddsSaved }, error);
      throw error;
    } finally {
      syncingDate = false;
    }
  }

  async function syncFixture(fixtureId) {
    await ensureTables();
    const id = toNumber(fixtureId, null);
    if (!id) throw new Error("fixtureId invalide");

    const runId = await beginRun("FIXTURE", String(id));
    try {
      const response = await callApiFootball("/odds", {
        fixture: id,
        timezone: DEFAULT_TIMEZONE,
        page: 1,
      }, { forceRefresh: true });
      const items = Array.isArray(response?.data?.response)
        ? response.data.response
        : [];
      let oddsSaved = 0;
      for (const item of items) {
        oddsSaved += await saveRows(extractOddsRows(item));
      }
      const result = {
        ok: true,
        fixtureId: id,
        fixtures: items.length,
        pages: 1,
        oddsSaved,
        syncedAt: new Date().toISOString(),
      };
      await finishRun(runId, result);
      return result;
    } catch (error) {
      await finishRun(runId, {}, error);
      throw error;
    }
  }

  async function syncNearKickoff() {
    if (syncingNearKickoff) {
      return { ok: true, skipped: true, reason: "NEAR_KICKOFF_SYNC_ALREADY_RUNNING" };
    }
    syncingNearKickoff = true;
    try {
      await ensureTables();
      const result = await pool.query(
        `
          SELECT DISTINCT ON (fixture_id)
            fixture_id,
            fixture_date
          FROM predictions
          WHERE fixture_date BETWEEN
            NOW() + ($1::text || ' minutes')::interval
            AND NOW() + ($2::text || ' minutes')::interval
          ORDER BY fixture_id, updated_at DESC NULLS LAST, id DESC
        `,
        [DEFAULT_NEAR_KICKOFF_MIN_MINUTES, DEFAULT_NEAR_KICKOFF_MAX_MINUTES]
      );

      const synced = [];
      for (const row of result.rows) {
        const freshness = await pool.query(
          `
            SELECT MAX(captured_at) AS last_capture
            FROM market_odds
            WHERE fixture_id = $1
          `,
          [row.fixture_id]
        );
        const lastCapture = freshness.rows[0]?.last_capture
          ? new Date(freshness.rows[0].last_capture)
          : null;
        if (lastCapture && Date.now() - lastCapture.getTime() < 20 * 60 * 1000) {
          continue;
        }
        synced.push(await syncFixture(row.fixture_id));
      }

      return {
        ok: true,
        checked: result.rows.length,
        synced: synced.length,
        details: synced,
      };
    } finally {
      syncingNearKickoff = false;
    }
  }

  async function getCurrentOddsMap(fixtureIds = []) {
    await ensureTables();
    const ids = [...new Set(fixtureIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    const map = new Map();
    if (ids.length === 0) return map;

    const result = await pool.query(
      `
        SELECT DISTINCT ON (fixture_id, market_key)
          fixture_id,
          market_key,
          bookmaker_id,
          bookmaker_name,
          odd,
          source,
          api_updated_at,
          captured_at
        FROM market_odds
        WHERE fixture_id = ANY($1::bigint[])
          AND is_current = TRUE
          AND odd > 1
        ORDER BY
          fixture_id,
          market_key,
          CASE
            WHEN bookmaker_id = 4 THEN 1
            WHEN bookmaker_id = 8 THEN 2
            WHEN bookmaker_id = 16 THEN 3
            ELSE 100
          END,
          captured_at DESC
      `,
      [ids]
    );

    for (const row of result.rows) {
      map.set(`${row.fixture_id}:${row.market_key}`, {
        odd: Number(row.odd),
        bookmakerId: row.bookmaker_id === null ? null : Number(row.bookmaker_id),
        bookmaker: row.bookmaker_name,
        source: row.source || "API_FOOTBALL",
        updatedAt: row.api_updated_at || row.captured_at,
        capturedAt: row.captured_at,
      });
    }
    return map;
  }

  function applyOddsToMarket(fixtureId, market = {}, oddsMap = new Map()) {
    const rawKey = String(market?.key || market?.marketKey || "").toUpperCase();
    const aliases = {
      HOME_WIN: "HOME",
      AWAY_WIN: "AWAY",
      BTTS: "BTTS_YES",
      NO_BTTS: "BTTS_NO",
      OVER_25: "OVER25",
      UNDER_25: "UNDER25",
    };
    const marketKey = aliases[rawKey] || rawKey;
    const stored = oddsMap.get(`${Number(fixtureId)}:${marketKey}`);
    if (!stored) return market;

    // La saisie manuelle reste prioritaire.
    const hasManualOdd =
      Number(market?.manualMarketOdd ?? market?.manual_market_odd) > 1 &&
      market?.manualOddMatchesMarket !== false;
    if (hasManualOdd) return market;

    return {
      ...market,
      bookmakerOdds: stored.odd,
      bookmakerOdd: stored.odd,
      oddsAvailable: true,
      oddsFresh: Date.now() - new Date(stored.capturedAt).getTime() <= 12 * 60 * 60 * 1000,
      bookmaker: stored.bookmaker,
      oddsSource: stored.source,
      bookmakerSource: stored.source,
      bookmakerOddUpdatedAt: stored.updatedAt,
      fairOdds: {
        ...(market?.fairOdds || {}),
        bookmakerOdds: stored.odd,
        bookmaker: stored.bookmaker,
        bookmakerSource: stored.source,
        bookmakerOddUpdatedAt: stored.updatedAt,
      },
    };
  }

  function withAdminGuard(handler) {
    if (typeof adminGuard !== "function") return handler;
    return [adminGuard, handler];
  }

  function registerRoutes() {
    app.get("/public/odds/daily", async (req, res) => {
      try {
        await ensureTables();
        const date = String(req.query.date || parisDate());
        const result = await pool.query(
          `
            SELECT DISTINCT ON (mo.fixture_id, mo.market_key)
              mo.fixture_id,
              mo.market_key,
              mo.bookmaker_id,
              mo.bookmaker_name,
              mo.odd,
              mo.source,
              mo.api_updated_at,
              mo.captured_at,
              p.home_team_name,
              p.away_team_name,
              p.league_name,
              p.fixture_date
            FROM market_odds mo
            LEFT JOIN LATERAL (
              SELECT home_team_name, away_team_name, league_name, fixture_date
              FROM predictions p2
              WHERE p2.fixture_id = mo.fixture_id
              ORDER BY p2.updated_at DESC NULLS LAST, p2.id DESC
              LIMIT 1
            ) p ON TRUE
            WHERE (p.fixture_date AT TIME ZONE $2)::date = $1::date
              AND mo.is_current = TRUE
            ORDER BY
              mo.fixture_id,
              mo.market_key,
              CASE
                WHEN mo.bookmaker_id = 4 THEN 1
                WHEN mo.bookmaker_id = 8 THEN 2
                WHEN mo.bookmaker_id = 16 THEN 3
                ELSE 100
              END,
              mo.captured_at DESC
          `,
          [date, DEFAULT_TIMEZONE]
        );

        return res.json({
          ok: true,
          date,
          count: result.rows.length,
          odds: result.rows.map((row) => ({
            fixtureId: Number(row.fixture_id),
            marketKey: row.market_key,
            bookmakerId: row.bookmaker_id === null ? null : Number(row.bookmaker_id),
            bookmaker: row.bookmaker_name,
            odd: Number(row.odd),
            source: row.source,
            apiUpdatedAt: row.api_updated_at,
            capturedAt: row.captured_at,
            homeTeam: row.home_team_name,
            awayTeam: row.away_team_name,
            leagueName: row.league_name,
            kickoff: row.fixture_date,
          })),
        });
      } catch (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }
    });

    const syncDateHandler = async (req, res) => {
      try {
        return res.json(await syncDate(String(req.body?.date || req.query?.date || parisDate())));
      } catch (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }
    };
    const dateHandlers = withAdminGuard(syncDateHandler);
    app.post("/internal/odds/sync/date", ...(Array.isArray(dateHandlers) ? dateHandlers : [dateHandlers]));

    const syncFixtureHandler = async (req, res) => {
      try {
        return res.json(await syncFixture(req.params.fixtureId));
      } catch (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }
    };
    const fixtureHandlers = withAdminGuard(syncFixtureHandler);
    app.post("/internal/odds/sync/fixture/:fixtureId", ...(Array.isArray(fixtureHandlers) ? fixtureHandlers : [fixtureHandlers]));
  }

  function startScheduler() {
    if (!schedulersEnabled) return;
    if (dateTimer || nearKickoffTimer) return;

    initialTimer = setTimeout(() => {
      syncDate().catch((error) => console.error("ERREUR ODDS SYNC INITIAL :", error));
      syncNearKickoff().catch((error) => console.error("ERREUR ODDS SYNC PROXIMITÉ INITIAL :", error));
    }, 20000);

    dateTimer = setInterval(() => {
      syncDate().catch((error) => console.error("ERREUR ODDS SYNC DATE :", error));
    }, DEFAULT_SYNC_HOURS * 60 * 60 * 1000);

    nearKickoffTimer = setInterval(() => {
      syncNearKickoff().catch((error) => console.error("ERREUR ODDS SYNC PROXIMITÉ :", error));
    }, DEFAULT_NEAR_KICKOFF_INTERVAL_MINUTES * 60 * 1000);
  }

  function stopScheduler() {
    if (initialTimer) clearTimeout(initialTimer);
    if (dateTimer) clearInterval(dateTimer);
    if (nearKickoffTimer) clearInterval(nearKickoffTimer);
    initialTimer = null;
    dateTimer = null;
    nearKickoffTimer = null;
  }

  return {
    ensureTables,
    registerRoutes,
    startScheduler,
    stopScheduler,
    syncDate,
    syncFixture,
    syncNearKickoff,
    getCurrentOddsMap,
    applyOddsToMarket,
    normalizeMarketKeyFromApi,
    bookmakerPriority,
  };
}

module.exports = {
  createOddsSyncService,
  normalizeMarketKeyFromApi,
};
