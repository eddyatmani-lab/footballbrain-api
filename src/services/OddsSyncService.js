"use strict";

const DEFAULT_TIMEZONE = "Europe/Paris";
const DEFAULT_SYNC_HOURS = 3;
const DEFAULT_NEAR_KICKOFF_INTERVAL_MINUTES = 15;
const DEFAULT_NEAR_KICKOFF_MAX_MINUTES = 100;
const DEFAULT_NEAR_KICKOFF_MIN_MINUTES = 20;

const BOOKMAKER_POLICY_VERSION = "FR_PINNACLE_V1";

const AUTO_ODDS_POLICY_VERSION = "BEST_ALLOWED_COHERENT_V2";

/*
 * Une cote très éloignée de la probabilité IA est généralement un marché
 * mal apparié, une ligne alternative ou une donnée bookmaker erronée.
 *
 * La meilleure cote reste choisie, mais seulement parmi les cotes cohérentes.
 */
const AUTO_ODDS_MIN_FAIR_MULTIPLIER = 0.55;
const AUTO_ODDS_MAX_FAIR_MULTIPLIER = 2.0;
const AUTO_ODDS_ABSOLUTE_MAX = 15;

/*
 * Politique de cotes Football AI Pro :
 * - Pinnacle reste la référence prioritaire lorsqu'il est disponible ;
 * - sinon, seuls les opérateurs de paris sportifs autorisés en France
 *   sont acceptés ;
 * - tous les autres bookmakers sont ignorés à la synchronisation et
 *   exclus des anciennes lignes déjà présentes en base.
 *
 * Les alias correspondent aux noms susceptibles d'être renvoyés par
 * API-Football. La normalisation supprime accents, espaces et ponctuation.
 */
const ALLOWED_BOOKMAKER_ALIASES = Object.freeze({
  PINNACLE: [
    "pinnacle",
    "pinnacle sports",
  ],

  BETCLIC: [
    "betclic",
    "betclic fr",
  ],

  WINAMAX: [
    "winamax",
  ],

  UNIBET: [
    "unibet",
    "unibet fr",
  ],

  BET365: [
    "bet365",
    "bet 365",
    "bet365 fr",
  ],

  BWIN: [
    "bwin",
    "bwin fr",
  ],

  NETBET: [
    "netbet",
    "netbet fr",
    "netbet sport",
    "netbetsport",
  ],

  PMU: [
    "pmu",
    "pmu sport",
    "pmu sports",
  ],

  PARIONS_SPORT: [
    "parions sport",
    "parionssport",
    "parions web",
    "parionsweb",
    "fdj",
    "fdj sport",
  ],

  POKERSTARS_SPORTS: [
    "pokerstars sports",
    "pokerstarssports",
    "betstars",
    "poker stars sports",
  ],

  VBET: [
    "vbet",
    "vbet france",
  ],

  BETSSON: [
    "betsson",
    "betsson france",
  ],

  CIRCUSBET: [
    "circusbet",
    "circus bet",
  ],

  DAZN_BET: [
    "dazn bet",
    "daznbet",
  ],

  OLYBET: [
    "olybet",
    "oly bet",
  ],

  FEELINGBET: [
    "feelingbet",
    "feeling bet",
  ],

  GENYBET: [
    "genybet",
    "geny bet",
  ],

  YES_OR_NO: [
    "yesorno",
    "yes or no",
    "yesorno jeu",
  ],
});

const BOOKMAKER_PRIORITY_ORDER = Object.freeze([
  "PINNACLE",
  "BETCLIC",
  "WINAMAX",
  "UNIBET",
  "BET365",
  "BWIN",
  "PARIONS_SPORT",
  "PMU",
  "NETBET",
  "POKERSTARS_SPORTS",
  "VBET",
  "BETSSON",
  "CIRCUSBET",
  "DAZN_BET",
  "OLYBET",
  "FEELINGBET",
  "GENYBET",
  "YES_OR_NO",
]);


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


function compactBookmakerName(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "");
}

const BOOKMAKER_ALIAS_INDEX = (() => {
  const index = new Map();

  for (const [canonicalName, aliases] of Object.entries(
    ALLOWED_BOOKMAKER_ALIASES
  )) {
    index.set(
      compactBookmakerName(canonicalName),
      canonicalName
    );

    for (const alias of aliases) {
      index.set(
        compactBookmakerName(alias),
        canonicalName
      );
    }
  }

  return index;
})();

function canonicalBookmakerName(name, id = null) {
  /*
   * Identifiants API-Football déjà confirmés dans l'ancien service.
   */
  if (Number(id) === 4) return "PINNACLE";
  if (Number(id) === 8) return "BET365";
  if (Number(id) === 16) return "UNIBET";

  const compact = compactBookmakerName(name);

  if (!compact) return null;

  const exact = BOOKMAKER_ALIAS_INDEX.get(compact);
  if (exact) return exact;

  /*
   * Secours contrôlé pour les noms enrichis du type
   * "Pinnacle Sports EU" ou "Betclic France".
   */
  for (const [alias, canonicalName] of BOOKMAKER_ALIAS_INDEX.entries()) {
    if (
      alias.length >= 4 &&
      (
        compact === alias ||
        compact.startsWith(alias) ||
        alias.startsWith(compact)
      )
    ) {
      return canonicalName;
    }
  }

  return null;
}

function isAllowedBookmaker(name, id = null) {
  return canonicalBookmakerName(name, id) !== null;
}

function publicBookmakerName(canonicalName, fallback = null) {
  return (
    {
      PINNACLE: "Pinnacle",
      BETCLIC: "Betclic",
      WINAMAX: "Winamax",
      UNIBET: "Unibet",
      BET365: "Bet365",
      BWIN: "Bwin",
      NETBET: "NetBet",
      PMU: "PMU",
      PARIONS_SPORT: "Parions Sport",
      POKERSTARS_SPORTS: "PokerStars Sports",
      VBET: "VBET",
      BETSSON: "Betsson",
      CIRCUSBET: "Circusbet",
      DAZN_BET: "DAZN BET",
      OLYBET: "OlyBet",
      FEELINGBET: "Feelingbet",
      GENYBET: "Genybet",
      YES_OR_NO: "YesOrNo",
    }[canonicalName] ||
    fallback ||
    canonicalName
  );
}

function bookmakerPriority(name, id) {
  const canonicalName =
    canonicalBookmakerName(name, id);

  if (!canonicalName) return 1000;

  const index =
    BOOKMAKER_PRIORITY_ORDER.indexOf(
      canonicalName
    );

  return index >= 0 ? index + 1 : 999;
}

function allowedBookmakerSql(columnName = "bookmaker_name") {
  /*
   * PostgreSQL : même logique de normalisation que côté JavaScript.
   * Ce filtre protège aussi les anciennes lignes enregistrées avant
   * l'activation de la liste blanche.
   */
  const normalizedColumn =
    `REGEXP_REPLACE(LOWER(COALESCE(${columnName}, '')), '[^a-z0-9]+', '', 'g')`;

  const aliases = Array.from(
    new Set(
      Object.values(ALLOWED_BOOKMAKER_ALIASES)
        .flat()
        .map(compactBookmakerName)
        .filter(Boolean)
    )
  );

  return `${normalizedColumn} = ANY(ARRAY[${aliases
    .map((alias) => `'${alias.replaceAll("'", "''")}'`)
    .join(", ")}]::text[])`;
}

function bookmakerPrioritySql(
  nameColumn = "bookmaker_name",
  idColumn = "bookmaker_id"
) {
  const clauses = BOOKMAKER_PRIORITY_ORDER.map(
    (canonicalName, index) => {
      const aliases = (
        ALLOWED_BOOKMAKER_ALIASES[
          canonicalName
        ] || []
      )
        .map(compactBookmakerName)
        .filter(Boolean);

      const normalizedColumn =
        `REGEXP_REPLACE(LOWER(COALESCE(${nameColumn}, '')), '[^a-z0-9]+', '', 'g')`;

      const ids =
        canonicalName === "PINNACLE"
          ? [4]
          : canonicalName === "BET365"
            ? [8]
            : canonicalName === "UNIBET"
              ? [16]
              : [];

      const checks = [];

      if (ids.length > 0) {
        checks.push(
          `${idColumn} IN (${ids.join(", ")})`
        );
      }

      if (aliases.length > 0) {
        checks.push(
          `${normalizedColumn} = ANY(ARRAY[${aliases
            .map((alias) => `'${alias.replaceAll("'", "''")}'`)
            .join(", ")}]::text[])`
        );
      }

      return `WHEN ${checks.join(" OR ")} THEN ${index + 1}`;
    }
  );

  return `CASE ${clauses.join(" ")} ELSE 1000 END`;
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


function normalizeStoredMarketKey(value = "") {
  const compact = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (["HOME", "HOMEWIN", "1"].includes(compact)) return "HOME";
  if (["DRAW", "X", "N"].includes(compact)) return "DRAW";
  if (["AWAY", "AWAYWIN", "2"].includes(compact)) return "AWAY";
  if (["BTTS", "BTTSYES", "GG"].includes(compact)) return "BTTS_YES";
  if (["NOBTTS", "BTTSNO", "NG"].includes(compact)) return "BTTS_NO";
  if (["OVER25", "OVER250", "PLUS25"].includes(compact)) return "OVER25";
  if (["UNDER25", "UNDER250", "MOINS25"].includes(compact)) return "UNDER25";

  return compact || null;
}

function normalizedMarketSql(columnName) {
  const compact =
    `REGEXP_REPLACE(UPPER(COALESCE(${columnName}, '')), '[^A-Z0-9]+', '', 'g')`;

  return `CASE
    WHEN ${compact} IN ('HOME', 'HOMEWIN', '1') THEN 'HOME'
    WHEN ${compact} IN ('DRAW', 'X', 'N') THEN 'DRAW'
    WHEN ${compact} IN ('AWAY', 'AWAYWIN', '2') THEN 'AWAY'
    WHEN ${compact} IN ('BTTS', 'BTTSYES', 'GG') THEN 'BTTS_YES'
    WHEN ${compact} IN ('NOBTTS', 'BTTSNO', 'NG') THEN 'BTTS_NO'
    WHEN ${compact} IN ('OVER25', 'OVER250', 'PLUS25') THEN 'OVER25'
    WHEN ${compact} IN ('UNDER25', 'UNDER250', 'MOINS25') THEN 'UNDER25'
    ELSE ${compact}
  END`;
}

function parisDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
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
      const rawBookmakerName = bookmaker?.name || null;
      const canonicalName = canonicalBookmakerName(
        rawBookmakerName,
        bookmakerId
      );

      /*
       * Liste blanche : Pinnacle + opérateurs français uniquement.
       */
      if (!canonicalName) {
        continue;
      }

      const bookmakerName = publicBookmakerName(
        canonicalName,
        rawBookmakerName
      );

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
              bookmakerPolicyVersion:
                BOOKMAKER_POLICY_VERSION,
              bookmakerCanonicalName:
                canonicalName,
              bookmakerRawName:
                rawBookmakerName,
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
          AND (
            bookmaker_id IN (4, 8, 16)
            OR ${allowedBookmakerSql("bookmaker_name")}
          )
        ORDER BY
          fixture_id,
          market_key,
          ${bookmakerPrioritySql(
            "bookmaker_name",
            "bookmaker_id"
          )},
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


  async function applyBestAvailableOdds({
    fixtureIds = [],
    daysAhead = 7,
    overwriteAutomatic = true,
    enteredBy = "automatic-odds",
  } = {}) {
    await ensureTables();

    const normalizedFixtureIds = [
      ...new Set(
        (Array.isArray(fixtureIds) ? fixtureIds : [])
          .map(Number)
          .filter(
            (fixtureId) =>
              Number.isInteger(fixtureId) &&
              fixtureId > 0
          )
      ),
    ];

    const safeDaysAhead = Math.max(
      1,
      Math.min(30, Number(daysAhead) || 7)
    );

    const allowedSql = allowedBookmakerSql(
      "mo.bookmaker_name"
    );

    const predictionMarketSql =
      normalizedMarketSql("p.studio_market_key");

    const oddsMarketSql =
      normalizedMarketSql("mo.market_key");

    const fixtureFilter =
      normalizedFixtureIds.length > 0
        ? "AND p.fixture_id = ANY($1::bigint[])"
        : `
          AND p.fixture_date >= NOW() - INTERVAL '2 hours'
          AND p.fixture_date < NOW() + ($1::text || ' days')::interval
        `;

    const firstParameter =
      normalizedFixtureIds.length > 0
        ? normalizedFixtureIds
        : String(safeDaysAhead);

    /*
     * Une cote saisie réellement à la main reste protégée.
     * Seules les cotes absentes ou déjà issues de l'automatisation
     * peuvent être remplacées lors d'une actualisation.
     */
    const overwriteFilter = overwriteAutomatic
      ? `AND (
          p.manual_market_odd IS NULL
          OR p.manual_odd_source LIKE 'AUTO_BEST_ODD%'
        )`
      : "AND p.manual_market_odd IS NULL";

    const candidates = await pool.query(
      `
        SELECT DISTINCT ON (p.fixture_id)
          p.fixture_id,
          p.studio_market_key,
          p.studio_market_label,
          p.studio_probability,
          p.studio_decision_score,
          p.manual_stake_units,

          best_odd.odd,
          best_odd.bookmaker_id,
          best_odd.bookmaker_name,
          best_odd.source,
          best_odd.api_updated_at,
          best_odd.captured_at

        FROM predictions p

        JOIN LATERAL (
          SELECT
            mo.odd,
            mo.bookmaker_id,
            mo.bookmaker_name,
            mo.source,
            mo.api_updated_at,
            mo.captured_at
          FROM market_odds mo
          WHERE mo.fixture_id = p.fixture_id
            AND mo.is_current = TRUE
            AND mo.odd > 1
            AND mo.odd <= ${AUTO_ODDS_ABSOLUTE_MAX}
            AND (
              mo.bookmaker_id IN (4, 8, 16)
              OR ${allowedSql}
            )
            AND ${oddsMarketSql} = ${predictionMarketSql}

            /*
             * Contrôle de cohérence par rapport à la probabilité du marché
             * principal. Exemple : une cote 4.00 sur un marché évalué à 74 %
             * est rejetée comme anomalie ou mauvais appariement.
             */
            AND (
              p.studio_probability IS NULL
              OR p.studio_probability <= 0
              OR (
                mo.odd >=
                  (100.0 / p.studio_probability) *
                  ${AUTO_ODDS_MIN_FAIR_MULTIPLIER}
                AND mo.odd <=
                  (100.0 / p.studio_probability) *
                  ${AUTO_ODDS_MAX_FAIR_MULTIPLIER}
              )
            )

          ORDER BY
            mo.odd DESC,
            mo.captured_at DESC,
            ${bookmakerPrioritySql(
              "mo.bookmaker_name",
              "mo.bookmaker_id"
            )} ASC
          LIMIT 1
        ) best_odd ON TRUE

        WHERE NULLIF(
          BTRIM(COALESCE(p.studio_market_key, '')),
          ''
        ) IS NOT NULL
          ${fixtureFilter}
          ${overwriteFilter}

        ORDER BY
          p.fixture_id,
          p.updated_at DESC NULLS LAST,
          p.id DESC
      `,
      [firstParameter]
    );

    let updated = 0;
    const applied = [];

    for (const candidate of candidates.rows) {
      const fixtureId = Number(candidate.fixture_id);
      const odd = Number(candidate.odd);

      if (
        !Number.isInteger(fixtureId) ||
        !Number.isFinite(odd) ||
        odd <= 1
      ) {
        continue;
      }

      const bookmaker =
        candidate.bookmaker_name ||
        "Bookmaker autorisé";

      const source =
        `AUTO_BEST_ODD · ${bookmaker}`;

      const result = await pool.query(
        `
          UPDATE predictions
          SET
            manual_market_odd = $2,
            manual_market_key = studio_market_key,
            manual_stake_units = COALESCE(
              NULLIF(manual_stake_units, 0),
              1
            ),
            manual_profit_units = NULL,
            manual_roi_percent = NULL,
            manual_odd_source = $3,
            manual_odd_entered_at = COALESCE(
              manual_odd_entered_at,
              NOW()
            ),
            manual_odd_updated_at = NOW(),
            manual_odd_entered_by = $4,

            official_tracked_market_key =
              studio_market_key,
            official_tracked_market_label =
              studio_market_label,
            official_tracked_probability =
              studio_probability,
            official_tracked_decision_score =
              studio_decision_score,
            official_tracked_at = NOW(),

            prematch_final_market_key = COALESCE(
              prematch_final_market_key,
              studio_market_key
            ),
            prematch_final_market_label = COALESCE(
              prematch_final_market_label,
              studio_market_label
            ),
            prematch_final_probability = COALESCE(
              prematch_final_probability,
              studio_probability
            ),
            prematch_final_decision_score = COALESCE(
              prematch_final_decision_score,
              studio_decision_score
            ),
            prematch_final_captured_at = COALESCE(
              prematch_final_captured_at,
              NOW()
            ),

            official_market_won = NULL,
            prematch_final_market_won = NULL,
            market_changed = NULL,
            market_change_outcome = NULL,
            updated_at = NOW()

          WHERE fixture_id = $1
          RETURNING fixture_id
        `,
        [
          fixtureId,
          odd,
          source,
          String(enteredBy || "automatic-odds")
            .trim()
            .slice(0, 200),
        ]
      );

      if (result.rowCount > 0) {
        updated += 1;
        applied.push({
          fixtureId,
          marketKey:
            normalizeStoredMarketKey(
              candidate.studio_market_key
            ),
          odd,
          bookmaker,
          probability:
            candidate.studio_probability != null
              ? Number(candidate.studio_probability)
              : null,
          fairOdd:
            Number(candidate.studio_probability) > 0
              ? Number(
                  (
                    100 /
                    Number(candidate.studio_probability)
                  ).toFixed(3)
                )
              : null,
          capturedAt:
            candidate.captured_at,
        });
      }
    }

    return {
      ok: true,
      policyVersion:
        BOOKMAKER_POLICY_VERSION,
      autoOddsPolicyVersion:
        AUTO_ODDS_POLICY_VERSION,
      mode: "BEST_AVAILABLE_COHERENT",
      candidates: candidates.rows.length,
      updated,
      skipped:
        Math.max(
          0,
          candidates.rows.length - updated
        ),
      applied,
      generatedAt:
        new Date().toISOString(),
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
              AND mo.odd > 1
              AND (
                mo.bookmaker_id IN (4, 8, 16)
                OR ${allowedBookmakerSql("mo.bookmaker_name")}
              )
            ORDER BY
              mo.fixture_id,
              mo.market_key,
              ${bookmakerPrioritySql(
                "mo.bookmaker_name",
                "mo.bookmaker_id"
              )},
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

    const applyBestOddsHandler =
      async (req, res) => {
        try {
          const result =
            await applyBestAvailableOdds({
              fixtureIds:
                req.body?.fixtureIds,
              daysAhead:
                req.body?.daysAhead,
              overwriteAutomatic:
                req.body?.overwriteAutomatic !==
                false,
              enteredBy:
                req.body?.enteredBy ||
                "Admin Football AI Pro",
            });

          return res.json(result);
        } catch (error) {
          console.error(
            "ERREUR APPLICATION COTES AUTOMATIQUES :",
            error
          );

          return res.status(500).json({
            ok: false,
            error:
              error?.message ||
              "Impossible d'appliquer les meilleures cotes.",
          });
        }
      };

    const applyBestOddsHandlers =
      withAdminGuard(applyBestOddsHandler);

    app.post(
      "/internal/odds/apply-best",
      ...(Array.isArray(applyBestOddsHandlers)
        ? applyBestOddsHandlers
        : [applyBestOddsHandlers])
    );

    app.get("/public/odds/bookmakers", (req, res) => {
      return res.json({
        ok: true,
        policyVersion:
          BOOKMAKER_POLICY_VERSION,
        referenceBookmaker: "Pinnacle",
        priority:
          BOOKMAKER_PRIORITY_ORDER.map(
            (canonicalName, index) => ({
              rank: index + 1,
              canonicalName,
              bookmaker:
                publicBookmakerName(
                  canonicalName
                ),
            })
          ),
        allowed:
          BOOKMAKER_PRIORITY_ORDER.map(
            (canonicalName) =>
              publicBookmakerName(
                canonicalName
              )
          ),
      });
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

  async function syncAndApplyTodayOdds({
    source = "scheduler",
  } = {}) {
    const dateResult = await syncDate();

    const applyResult =
      await applyBestAvailableOdds({
        daysAhead: 2,
        overwriteAutomatic: true,
        enteredBy:
          `automatic-odds:${source}`,
      });

    return {
      ok: true,
      dateSync: dateResult,
      appliedOdds: applyResult,
      completedAt:
        new Date().toISOString(),
    };
  }

  async function syncNearKickoffAndApply() {
    const proximityResult =
      await syncNearKickoff();

    const fixtureIds =
      Array.isArray(
        proximityResult?.details
      )
        ? proximityResult.details
            .map(
              (item) =>
                Number(item?.fixtureId)
            )
            .filter(
              (fixtureId) =>
                Number.isInteger(fixtureId) &&
                fixtureId > 0
            )
        : [];

    const applyResult =
      await applyBestAvailableOdds({
        fixtureIds,
        daysAhead: 2,
        overwriteAutomatic: true,
        enteredBy:
          "automatic-odds:near-kickoff",
      });

    return {
      ok: true,
      proximitySync:
        proximityResult,
      appliedOdds:
        applyResult,
      completedAt:
        new Date().toISOString(),
    };
  }

  function startScheduler() {
    if (!schedulersEnabled) return;
    if (dateTimer || nearKickoffTimer) return;

    /*
     * Avant ce correctif, le scheduler alimentait uniquement market_odds.
     * Il ne recopiait jamais la meilleure cote dans les champs officiels
     * du panneau Admin. Le bouton manuel était donc encore nécessaire.
     */
    initialTimer = setTimeout(() => {
      syncAndApplyTodayOdds({
        source: "initial",
      }).catch((error) =>
        console.error(
          "ERREUR ODDS SYNC + APPLY INITIAL :",
          error
        )
      );

      syncNearKickoffAndApply()
        .catch((error) =>
          console.error(
            "ERREUR ODDS PROXIMITÉ + APPLY INITIAL :",
            error
          )
        );
    }, 20000);

    dateTimer = setInterval(() => {
      syncAndApplyTodayOdds({
        source: "date-scheduler",
      }).catch((error) =>
        console.error(
          "ERREUR ODDS SYNC + APPLY DATE :",
          error
        )
      );
    }, DEFAULT_SYNC_HOURS * 60 * 60 * 1000);

    nearKickoffTimer = setInterval(() => {
      syncNearKickoffAndApply()
        .catch((error) =>
          console.error(
            "ERREUR ODDS PROXIMITÉ + APPLY :",
            error
          )
        );
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
    syncAndApplyTodayOdds,
    syncNearKickoffAndApply,
    getCurrentOddsMap,
    applyOddsToMarket,
    applyBestAvailableOdds,
    normalizeMarketKeyFromApi,
    bookmakerPriority,
    canonicalBookmakerName,
    isAllowedBookmaker,
    BOOKMAKER_POLICY_VERSION,
  };
}

module.exports = {
  createOddsSyncService,
  normalizeMarketKeyFromApi,
  canonicalBookmakerName,
  isAllowedBookmaker,
  bookmakerPriority,
  BOOKMAKER_POLICY_VERSION,
};
