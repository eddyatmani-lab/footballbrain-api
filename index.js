require("dotenv").config();
function parseEnvironmentBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "oui", "on"].includes(
    String(value).trim().toLowerCase()
  );
}

/*
 * Interrupteur général des appels externes API-Football.
 *
 * true  = les appels API-Football sont autorisés
 * false = aucun appel API-Football n'est autorisé
 */
const API_FOOTBALL_ENABLED = parseEnvironmentBoolean(
  process.env.API_FOOTBALL_ENABLED,
  true
);

/*
 * Interrupteur des tâches automatiques internes.
 *
 * true  = watchers et schedulers actifs
 * false = aucun setInterval/setTimeout métier n'est lancé
 */
const AUTOMATIC_SCHEDULERS_ENABLED = parseEnvironmentBoolean(
  process.env.AUTOMATIC_SCHEDULERS_ENABLED,
  true
);
const express = require("express");
const axios = require("axios");

const PORT =
  Number(process.env.PORT) || 3000;
const {
  computeAdvancedXGModel,
} = require("./src/services/FootballXGModel");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { createOddsSyncService } = require("./src/services/OddsSyncService");
const cors = require("cors");
const {
  FootballMonteCarlo,
} = require("./FootballMonteCarlo");
const {
  createAIEventEngine,
} = require("./core/events/eventEngine");
const {
  registerAIEventRoutes,
} = require("./routes/aiEventRoutes");
const {
  createDecisionExplainability,
  createMarketExplainability,
} = require("./core/explainability/decisionExplainability");
const app = express();
app.use(
  cors({
    origin: true,
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Admin-Key",
    ],
  })
);
// Les snapshots Brain Studio contiennent tous les marchés et peuvent
// dépasser la limite Express par défaut de 100 Ko.
app.use(
  express.json({
    limit: "10mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
  })
);
const analysisCache = new Map();
const ANALYSIS_CACHE_TTL = 60 * 60 * 1000;
const FINISHED_FIXTURE_STATUSES = new Set([
  "FT",
  "AET",
  "PEN",
]);
const API_BASE_URL =
  "https://v3.football.api-sports.io";

const DEFAULT_BOOKMAKER = 4; // Pinnacle


/*
 * Protection centrale API-Football.
 * Tous les appels externes passent par cette file unique afin d'éviter
 * les pics simultanés provoqués par Brain Studio, les watchers et les
 * reconstructions historiques.
 */
const API_FOOTBALL_MIN_INTERVAL_MS = Math.max(
  1000,
  Number(process.env.API_FOOTBALL_MIN_INTERVAL_MS) || 1500
);
const API_FOOTBALL_MAX_RETRIES = Math.max(
  0,
  Math.min(6, Number(process.env.API_FOOTBALL_MAX_RETRIES) || 4)
);
const API_FOOTBALL_CACHE_ENABLED = parseEnvironmentBoolean(
  process.env.API_FOOTBALL_CACHE_ENABLED,
  true
);

let apiFootballQueue = Promise.resolve();
let apiFootballLastRequestAt = 0;
const apiFootballResponseCache = new Map();

function waitApiFootball(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stableApiFootballCacheKey(endpoint, params = {}) {
  const normalized = Object.keys(params)
    .sort()
    .reduce((accumulator, key) => {
      accumulator[key] = params[key];
      return accumulator;
    }, {});

  return `${endpoint}:${JSON.stringify(normalized)}`;
}

function getApiFootballCacheTtl(endpoint, params = {}) {
  if (endpoint === "/fixtures/lineups") return 5 * 60 * 1000;
  if (endpoint === "/injuries") return 20 * 60 * 1000;
  if (endpoint === "/odds") return 10 * 60 * 1000;
  if (endpoint === "/fixtures/headtohead") return 6 * 60 * 60 * 1000;
  if (endpoint === "/teams/statistics") return 60 * 60 * 1000;

  if (endpoint === "/fixtures") {
    if (params?.date) return 5 * 60 * 1000;
    if (params?.last) return 30 * 60 * 1000;
    if (params?.id) return 2 * 60 * 1000;
    return 5 * 60 * 1000;
  }

  return 2 * 60 * 1000;
}

function getRetryAfterMilliseconds(error, attempt) {
  const retryAfter = error?.response?.headers?.["retry-after"];
  const numericRetryAfter = Number(retryAfter);

  if (Number.isFinite(numericRetryAfter) && numericRetryAfter > 0) {
    return Math.min(120000, numericRetryAfter * 1000);
  }

  return Math.min(60000, 5000 * (2 ** attempt));
}

async function executeQueuedApiFootballRequest(endpoint, params = {}) {
  const elapsed = Date.now() - apiFootballLastRequestAt;
  const remainingDelay = API_FOOTBALL_MIN_INTERVAL_MS - elapsed;

  if (remainingDelay > 0) {
    await waitApiFootball(remainingDelay);
  }

  for (let attempt = 0; attempt <= API_FOOTBALL_MAX_RETRIES; attempt += 1) {
    try {
      apiFootballLastRequestAt = Date.now();

      return await axios.get(`${API_BASE_URL}${endpoint}`, {
        headers: {
          "x-apisports-key": getApiKey(),
        },
        params,
        timeout: 20000,
      });
    } catch (error) {
      const status = error?.response?.status || error?.status || null;
      const retryable =
        status === 429 ||
        status === 408 ||
        status >= 500 ||
        ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(
          error?.code
        );

      if (!retryable || attempt >= API_FOOTBALL_MAX_RETRIES) {
        throw error;
      }

      const delay =
        status === 429
          ? getRetryAfterMilliseconds(error, attempt)
          : Math.min(30000, 2000 * (2 ** attempt));

      console.warn("API-FOOTBALL : nouvelle tentative", {
        endpoint,
        status,
        attempt: attempt + 1,
        delayMs: delay,
      });

      await waitApiFootball(delay);
    }
  }

  throw new Error("Échec API-Football après plusieurs tentatives.");
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});
const aiEventEngine =
  createAIEventEngine({
    pool,
  });

registerAIEventRoutes({
  app,
  aiEventEngine,
});
const HISTORY_FILE = path.join(__dirname, "predictions-history.json");

function getApiKey() {
  const apiKey =
    process.env.API_FOOTBALL_KEY;

  if (!apiKey) {
    throw new Error(
      "API_FOOTBALL_KEY manquante"
    );
  }

  return apiKey.trim();
}

async function callApiFootball(
  endpoint,
  params = {},
  options = {}
) {
  if (!API_FOOTBALL_ENABLED) {
    const error = new Error(
      "API-Football temporairement désactivée par configuration."
    );

    error.code = "API_FOOTBALL_DISABLED";
    error.status = 503;
    error.endpoint = endpoint;
    throw error;
  }

  const forceRefresh = options?.forceRefresh === true;
  const cacheKey = stableApiFootballCacheKey(endpoint, params);
  const cacheTtl = getApiFootballCacheTtl(endpoint, params);

  if (API_FOOTBALL_CACHE_ENABLED && !forceRefresh) {
    const cached = apiFootballResponseCache.get(cacheKey);

    if (cached && Date.now() - cached.createdAt < cacheTtl) {
      return cached.response;
    }
  }

  const task = apiFootballQueue.then(() =>
    executeQueuedApiFootballRequest(endpoint, params)
  );

  apiFootballQueue = task.catch(() => undefined);
  const response = await task;

  if (API_FOOTBALL_CACHE_ENABLED) {
    apiFootballResponseCache.set(cacheKey, {
      createdAt: Date.now(),
      response,
    });
  }

  return response;
}
const oddsSyncService = createOddsSyncService({
  app,
  pool,
  callApiFootball,
  schedulersEnabled: AUTOMATIC_SCHEDULERS_ENABLED,
});

oddsSyncService.registerRoutes();

function isExcludedFixture(
  fixture = {}
) {
  const leagueName = String(
    fixture?.league?.name ||
    fixture?.league_name ||
    ""
  )
    .trim()
    .toLowerCase();

  const homeTeamName = String(
    fixture?.teams?.home?.name ||
    fixture?.homeTeam?.name ||
    fixture?.home_team_name ||
    ""
  )
    .trim()
    .toLowerCase();

  const awayTeamName = String(
    fixture?.teams?.away?.name ||
    fixture?.awayTeam?.name ||
    fixture?.away_team_name ||
    ""
  )
    .trim()
    .toLowerCase();

  const combinedText =
    `${leagueName} ${homeTeamName} ${awayTeamName}`;

  /*
   * Détecte :
   * U17, U-17, U 17
   * Under 17
   * moins de 17 ans
   *
   * De U15 jusqu'à U23.
   */
  const youthAgePattern =
    /\b(?:u[\s-]?(?:15|16|17|18|19|20|21|22|23)|under[\s-]?(?:15|16|17|18|19|20|21|22|23))\b/i;

  const friendlyKeywords = [
    "friendly",
    "friendlies",
    "amical",
    "amicaux",
  ];

  const youthKeywords = [
    "youth",
    "junior",
    "juniors",
    "academy",
    "academia",
    "akademiya",
    "primavera",
    "juvenil",
    "jeunes",
    "espoirs",
  ];

  const isFriendly =
    friendlyKeywords.some((keyword) =>
      combinedText.includes(keyword)
    );

  const isYouth =
    youthAgePattern.test(combinedText) ||
    youthKeywords.some((keyword) =>
      combinedText.includes(keyword)
    );

  return isFriendly || isYouth;
}
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service:
      "FootballBrain API",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service:
      "FootballBrain API",
    apiKeyConfigured:
      Boolean(
        process.env
          .API_FOOTBALL_KEY
      ),
    apiFootballEnabled:
      API_FOOTBALL_ENABLED,
    automaticSchedulersEnabled:
      AUTOMATIC_SCHEDULERS_ENABLED,
  });
});



/**
 * Renvoie les compétitions Railway associées à une liste de fixtures.
 * Une seule requête SQL est utilisée, même pour plusieurs milliers d'IDs.
 */
app.post("/internal/fixture-competitions", async (req, res) => {
  try {
    const rawFixtureIds = Array.isArray(req.body?.fixtureIds)
      ? req.body.fixtureIds
      : [];

    const fixtureIds = [
      ...new Set(
        rawFixtureIds
          .map((value) => Number(value))
          .filter(
            (value) =>
              Number.isInteger(value) && value > 0
          )
      ),
    ];

    if (fixtureIds.length === 0) {
      return res.json({
        ok: true,
        requested: 0,
        found: 0,
        missingFixtureIds: [],
        competitions: {},
      });
    }

    if (fixtureIds.length > 20000) {
      return res.status(400).json({
        ok: false,
        error:
          "Trop de fixtureIds envoyés en une seule requête (maximum 20 000).",
      });
    }

    const result = await pool.query(
      `
        SELECT DISTINCT ON (fixture_id)
          fixture_id,
          league_id,
          league_name
        FROM predictions
        WHERE fixture_id = ANY($1::int[])
          AND league_name IS NOT NULL
          AND BTRIM(league_name) <> ''
        ORDER BY fixture_id, updated_at DESC NULLS LAST, id DESC
      `,
      [fixtureIds]
    );

    const competitions = {};

    for (const row of result.rows) {
      competitions[String(row.fixture_id)] = {
        fixtureId: Number(row.fixture_id),
        leagueId:
          row.league_id === null || row.league_id === undefined
            ? null
            : Number(row.league_id),
        leagueName: String(row.league_name).trim(),
      };
    }

    const missingFixtureIds = fixtureIds.filter(
      (fixtureId) =>
        !competitions[String(fixtureId)]
    );

    return res.json({
      ok: true,
      requested: fixtureIds.length,
      found: Object.keys(competitions).length,
      missingFixtureIds,
      competitions,
    });
  } catch (error) {
    console.error(
      "ERREUR /internal/fixture-competitions :",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Impossible de récupérer les compétitions.",
    });
  }
});

app.get(
  "/timezone",
  async (req, res) => {
    try {
      const response =
        await callApiFootball(
          "/timezone"
        );

      return res.json({
        ok: true,
        httpStatus:
          response.status,
        data:
          response.data,
      });
   

} catch (error) {
  console.error("ERREUR ANALYSE COMPLÈTE :", error);

  return res
    .status(error.response?.status || 500)
    .json({
      ok: false,

      message:
        error.message ||
        "Erreur inconnue",

      code:
        error.code || null,

      status:
        error.response?.status || null,

      endpoint:
        error.config?.url || null,

      apiData:
        error.response?.data || null,

      stack:
        process.env.NODE_ENV === "production"
          ? undefined
          : error.stack,
    });
}

  }
);

app.get(
  "/fixtures",
  async (req, res) => {
    try {
      const date =
        req.query.date;

      if (!date) {
        return res.status(400).json({
          ok: false,
          error:
            "Le paramètre date est obligatoire. Exemple : /fixtures?date=2026-07-22",
        });
      }

      const dateFormat =
        /^\d{4}-\d{2}-\d{2}$/;

      if (
        !dateFormat.test(date)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "La date doit être au format YYYY-MM-DD.",
        });
      }

      const response =
        await callApiFootball(
          "/fixtures",
          {
  date,
  league: 2,
  season: 2026,
  timezone: "Europe/Paris",
}
        );

      const fixtures =
        Array.isArray(
          response.data?.response
        )
          ? response.data.response
          : [];

      const matches =
        fixtures.map((item) => ({
          fixtureId:
            item.fixture?.id,
          date:
            item.fixture?.date,
          timestamp:
            item.fixture
              ?.timestamp,
          status:
            item.fixture?.status,
          venue:
            item.fixture?.venue,

          league: {
            id:
              item.league?.id,
            name:
              item.league?.name,
            country:
              item.league?.country,
            season:
              item.league?.season,
            round:
              item.league?.round,
            logo:
              item.league?.logo,
          },

          homeTeam: {
            id:
              item.teams?.home
                ?.id,
            name:
              item.teams?.home
                ?.name,
            logo:
              item.teams?.home
                ?.logo,
          },

          awayTeam: {
            id:
              item.teams?.away
                ?.id,
            name:
              item.teams?.away
                ?.name,
            logo:
              item.teams?.away
                ?.logo,
          },
        }));

      return res.json({
        ok: true,
        date,
        count:
          matches.length,
        matches,
      });
    } catch (error) {
      return res.status(
        error.response?.status ||
          500
      ).json({
        ok: false,
        error:
          error.response?.data ||
          error.message,
      });
    }
  }
);
app.get("/fixtures-test", async (req, res) => {
  try {
    const response =
      await callApiFootball(
        "/fixtures",
        {
          live: "all",
        }
      );

    res.json(response.data);
  } catch (error) {
    res.json(
      error.response?.data
    );
  }
});

/*
 * ============================================================
 * LEAGUE MANAGER — CATALOGUE ET RÉGLAGES PERSISTANTS
 * ============================================================
 *
 * Sprint 1 :
 * - synchronise le catalogue API-Football vers PostgreSQL ;
 * - permet d'activer/désactiver une compétition ;
 * - ne filtre pas encore les analyses automatiques.
 */
const LEAGUE_MANAGER_PRIORITIES = new Set([
  "LOW",
  "NORMAL",
  "HIGH",
  "CRITICAL",
]);

function normalizeLeagueManagerPriority(value) {
  const normalized = String(value || "NORMAL")
    .trim()
    .toUpperCase();

  return LEAGUE_MANAGER_PRIORITIES.has(normalized)
    ? normalized
    : "NORMAL";
}

function normalizeLeagueManagerType(value) {
  const normalized = String(value || "unknown")
    .trim()
    .toLowerCase();

  if (normalized === "league") return "league";
  if (normalized === "cup") return "cup";

  return normalized || "unknown";
}

function selectLeagueManagerSeason(seasons = []) {
  if (!Array.isArray(seasons) || seasons.length === 0) {
    return null;
  }

  const current = seasons.find(
    (season) => season?.current === true
  );

  if (current) return current;

  return [...seasons].sort(
    (first, second) =>
      Number(second?.year || 0) -
      Number(first?.year || 0)
  )[0] || null;
}

function computeLeagueCoverageScore(coverage = {}) {
  const fixtures = coverage?.fixtures || {};
  const odds = coverage?.odds || {};

  const flags = [
    fixtures?.events,
    fixtures?.lineups,
    fixtures?.statistics_fixtures,
    fixtures?.statistics_players,
    coverage?.standings,
    coverage?.players,
    coverage?.top_scorers,
    coverage?.top_assists,
    coverage?.top_cards,
    coverage?.injuries,
    coverage?.predictions,
    odds?.pre_match,
    odds?.live,
  ];

  const available = flags.filter(Boolean).length;

  return Math.round(
    (available / Math.max(1, flags.length)) * 100
  );
}

async function ensureLeagueManagerTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS league_settings (
      league_id BIGINT PRIMARY KEY,
      league_name TEXT NOT NULL,
      country_name TEXT,
      country_code TEXT,
      country_flag TEXT,
      league_logo TEXT,
      league_type TEXT NOT NULL DEFAULT 'unknown',
      current_season INTEGER,
      season_start DATE,
      season_end DATE,
      coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
      coverage_score INTEGER NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      priority TEXT NOT NULL DEFAULT 'NORMAL',
      notes TEXT,
      last_catalog_sync_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_league_settings_enabled
    ON league_settings(enabled);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_league_settings_country
    ON league_settings(country_name);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_league_settings_type
    ON league_settings(league_type);
  `);
}
async function getEnabledLeagueIds() {
  await ensureLeagueManagerTables();

  const result = await pool.query(`
    SELECT league_id
    FROM league_settings
    WHERE enabled = TRUE
  `);

  return new Set(
    result.rows
      .map((row) => Number(row.league_id))
      .filter(
        (leagueId) =>
          Number.isInteger(leagueId) &&
          leagueId > 0
      )
  );
}

function isLeagueEnabled(
  fixture = {},
  enabledLeagueIds = new Set()
) {
  const leagueId = Number(
    fixture?.league?.id ??
      fixture?.league_id ??
      fixture?.leagueId
  );

  return (
    Number.isInteger(leagueId) &&
    enabledLeagueIds.has(leagueId)
  );
}
async function syncLeagueManagerCatalogue({ forceRefresh = false } = {}) {
  const response = await callApiFootball(
    "/leagues",
    { current: "true" },
    { forceRefresh }
  );

  const entries = Array.isArray(response.data?.response)
    ? response.data.response
    : [];

  let synced = 0;

  for (const entry of entries) {
    const leagueId = Number(entry?.league?.id);

    if (!Number.isInteger(leagueId) || leagueId <= 0) {
      continue;
    }

    const selectedSeason = selectLeagueManagerSeason(
      entry?.seasons
    );

    const coverage = selectedSeason?.coverage || {};
    const coverageScore = computeLeagueCoverageScore(
      coverage
    );

    await pool.query(
      `
        INSERT INTO league_settings (
          league_id,
          league_name,
          country_name,
          country_code,
          country_flag,
          league_logo,
          league_type,
          current_season,
          season_start,
          season_end,
          coverage,
          coverage_score,
          last_catalog_sync_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11::jsonb, $12,
          NOW(), NOW()
        )
        ON CONFLICT (league_id)
        DO UPDATE SET
          league_name = EXCLUDED.league_name,
          country_name = EXCLUDED.country_name,
          country_code = EXCLUDED.country_code,
          country_flag = EXCLUDED.country_flag,
          league_logo = EXCLUDED.league_logo,
          league_type = EXCLUDED.league_type,
          current_season = EXCLUDED.current_season,
          season_start = EXCLUDED.season_start,
          season_end = EXCLUDED.season_end,
          coverage = EXCLUDED.coverage,
          coverage_score = EXCLUDED.coverage_score,
          last_catalog_sync_at = NOW(),
          updated_at = NOW()
      `,
      [
        leagueId,
        String(entry?.league?.name || `Ligue ${leagueId}`),
        entry?.country?.name || null,
        entry?.country?.code || null,
        entry?.country?.flag || null,
        entry?.league?.logo || null,
        normalizeLeagueManagerType(entry?.league?.type),
        Number.isFinite(Number(selectedSeason?.year))
          ? Number(selectedSeason.year)
          : null,
        selectedSeason?.start || null,
        selectedSeason?.end || null,
        JSON.stringify(coverage),
        coverageScore,
      ]
    );

    synced += 1;
  }

  return {
    received: entries.length,
    synced,
  };
}

app.get(
  "/internal/league-manager/leagues",
  async (req, res) => {
    try {
      await ensureLeagueManagerTables();

      const search = String(req.query.search || "")
        .trim()
        .toLowerCase();
      const country = String(req.query.country || "")
        .trim();
      const type = String(req.query.type || "")
        .trim()
        .toLowerCase();
      const enabled = String(req.query.enabled || "")
        .trim()
        .toLowerCase();

      const values = [];
      const where = [];

      if (search) {
        values.push(`%${search}%`);
        where.push(
          `(LOWER(league_name) LIKE $${values.length} OR CAST(league_id AS TEXT) LIKE $${values.length})`
        );
      }

      if (country) {
        values.push(country);
        where.push(`country_name = $${values.length}`);
      }

      if (type) {
        values.push(type);
        where.push(`league_type = $${values.length}`);
      }

      if (enabled === "true" || enabled === "false") {
        values.push(enabled === "true");
        where.push(`enabled = $${values.length}`);
      }

      const result = await pool.query(
        `
          SELECT
            league_id,
            league_name,
            country_name,
            country_code,
            country_flag,
            league_logo,
            league_type,
            current_season,
            season_start,
            season_end,
            coverage,
            coverage_score,
            enabled,
            priority,
            notes,
            last_catalog_sync_at,
            updated_at
          FROM league_settings
          ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY
            enabled DESC,
            CASE priority
              WHEN 'CRITICAL' THEN 4
              WHEN 'HIGH' THEN 3
              WHEN 'NORMAL' THEN 2
              ELSE 1
            END DESC,
            country_name ASC NULLS LAST,
            league_name ASC
        `,
        values
      );

      const summaryResult = await pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE enabled = TRUE)::int AS enabled,
          COUNT(DISTINCT country_name)::int AS countries,
          ROUND(AVG(coverage_score))::int AS average_coverage
        FROM league_settings
      `);

      const countriesResult = await pool.query(`
        SELECT DISTINCT country_name
        FROM league_settings
        WHERE country_name IS NOT NULL
          AND BTRIM(country_name) <> ''
        ORDER BY country_name ASC
      `);

      return res.json({
        ok: true,
        summary: summaryResult.rows[0] || {
          total: 0,
          enabled: 0,
          countries: 0,
          average_coverage: 0,
        },
        countries: countriesResult.rows.map(
          (row) => row.country_name
        ),
        leagues: result.rows.map((row) => ({
          leagueId: Number(row.league_id),
          name: row.league_name,
          country: row.country_name,
          countryCode: row.country_code,
          countryFlag: row.country_flag,
          logo: row.league_logo,
          type: row.league_type,
          currentSeason: row.current_season,
          seasonStart: row.season_start,
          seasonEnd: row.season_end,
          coverage: row.coverage || {},
          coverageScore: Number(row.coverage_score || 0),
          enabled: row.enabled === true,
          priority: row.priority || "NORMAL",
          notes: row.notes || "",
          lastCatalogSyncAt: row.last_catalog_sync_at,
          updatedAt: row.updated_at,
        })),
      });
    } catch (error) {
      console.error("ERREUR LEAGUE MANAGER LISTE :", error);

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Impossible de charger le League Manager.",
      });
    }
  }
);

app.post(
  "/internal/league-manager/sync",
  async (req, res) => {
    try {
      await ensureLeagueManagerTables();

      const result = await syncLeagueManagerCatalogue({
        forceRefresh: req.query.force === "1",
      });

      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      console.error("ERREUR SYNCHRONISATION LIGUES :", error);

      return res
        .status(error?.status || error?.response?.status || 500)
        .json({
          ok: false,
          error:
            error?.message ||
            "Impossible de synchroniser les compétitions.",
        });
    }
  }
);

app.patch(
  "/internal/league-manager/leagues/:leagueId",
  async (req, res) => {
    try {
      await ensureLeagueManagerTables();

      const leagueId = Number(req.params.leagueId);

      if (!Number.isInteger(leagueId) || leagueId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "leagueId invalide",
        });
      }

      const currentResult = await pool.query(
        `
          SELECT enabled, priority, notes
          FROM league_settings
          WHERE league_id = $1
          LIMIT 1
        `,
        [leagueId]
      );

      if (currentResult.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error:
            "Compétition introuvable. Lancez d'abord la synchronisation.",
        });
      }

      const current = currentResult.rows[0];
      const enabled =
        typeof req.body?.enabled === "boolean"
          ? req.body.enabled
          : current.enabled === true;
      const priority =
        req.body?.priority !== undefined
          ? normalizeLeagueManagerPriority(req.body.priority)
          : normalizeLeagueManagerPriority(current.priority);
      const notes =
        req.body?.notes !== undefined
          ? String(req.body.notes || "").slice(0, 1000)
          : current.notes || "";

      const result = await pool.query(
        `
          UPDATE league_settings
          SET
            enabled = $2,
            priority = $3,
            notes = $4,
            updated_at = NOW()
          WHERE league_id = $1
          RETURNING *
        `,
        [leagueId, enabled, priority, notes]
      );

      const row = result.rows[0];

      return res.json({
        ok: true,
        league: {
          leagueId: Number(row.league_id),
          enabled: row.enabled === true,
          priority: row.priority,
          notes: row.notes || "",
          updatedAt: row.updated_at,
        },
      });
    } catch (error) {
      console.error("ERREUR MISE À JOUR LIGUE :", error);

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Impossible de modifier cette compétition.",
      });
    }
  }
);

app.post(
  "/internal/league-manager/bulk",
  async (req, res) => {
    try {
      await ensureLeagueManagerTables();

      const rawIds = Array.isArray(req.body?.leagueIds)
        ? req.body.leagueIds
        : [];
      const leagueIds = [
        ...new Set(
          rawIds
            .map((value) => Number(value))
            .filter(
              (value) => Number.isInteger(value) && value > 0
            )
        ),
      ];

      if (leagueIds.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "Aucune compétition valide sélectionnée.",
        });
      }

      if (typeof req.body?.enabled !== "boolean") {
        return res.status(400).json({
          ok: false,
          error: "Le champ enabled doit être un booléen.",
        });
      }

      const result = await pool.query(
        `
          UPDATE league_settings
          SET enabled = $2, updated_at = NOW()
          WHERE league_id = ANY($1::bigint[])
          RETURNING league_id
        `,
        [leagueIds, req.body.enabled]
      );

      return res.json({
        ok: true,
        updated: result.rowCount,
      });
    } catch (error) {
      console.error("ERREUR MISE À JOUR GROUPÉE LIGUES :", error);

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Impossible de modifier les compétitions sélectionnées.",
      });
    }
  }
);

app.get("/leagues", async (req, res) => {
  try {
    const response = await callApiFootball("/leagues");

    res.json({
      count: response.data.response.length,
      data: response.data.response.slice(0, 20),
    });
  } catch (error) {
    res.status(500).json({
      error: error.response?.data || error.message,
    });
  }
});
app.get("/status", async (req, res) => {
  try {
    const response = await callApiFootball(
      "/status"
    );

    return res.json(response.data);
  } catch (error) {
    return res
      .status(error.status || error.response?.status || 500)
      .json({
        ok: false,
        code: error.code || null,
        error:
          error.response?.data ||
          error.message,
      });
  }
});
app.get("/internal/match/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    const response = await callApiFootball("/fixtures", {
      id: fixtureId,
      timezone: "Europe/Paris",
    });

    const apiData = response.data;

    if (
      apiData.errors &&
      Object.keys(apiData.errors).length > 0
    ) {
      return res.status(502).json({
        ok: false,
        error: apiData.errors,
      });
    }

    const item = apiData.response?.[0];

    if (!item) {
      return res.status(404).json({
        ok: false,
        error: "Match introuvable",
      });
    }

    return res.json({
      ok: true,
      match: {
        fixtureId: item.fixture?.id,
        date: item.fixture?.date,
        timestamp: item.fixture?.timestamp,
        status: item.fixture?.status,
        venue: item.fixture?.venue,

        league: {
          id: item.league?.id,
          name: item.league?.name,
          season: item.league?.season,
          round: item.league?.round,
          logo: item.league?.logo,
        },

        homeTeam: {
          id: item.teams?.home?.id,
          name: item.teams?.home?.name,
          logo: item.teams?.home?.logo,
        },

        awayTeam: {
          id: item.teams?.away?.id,
          name: item.teams?.away?.name,
          logo: item.teams?.away?.logo,
        },

        goals: item.goals,
        score: item.score,
      },
    });
  } catch (error) {
    return res.status(error.response?.status || 500).json({
      ok: false,
      error:
        error.response?.data ||
        error.message,
    });
  }
});
app.get("/internal/match/:fixtureId/context", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    const fixtureResponse = await callApiFootball("/fixtures", {
      id: fixtureId,
      timezone: "Europe/Paris",
    });

    const fixture = fixtureResponse.data?.response?.[0];

    if (!fixture) {
      return res.status(404).json({
        ok: false,
        error: "Match introuvable",
      });
    }

    const leagueId = fixture.league?.id;
    const season = fixture.league?.season;
    const homeTeamId = fixture.teams?.home?.id;
    const awayTeamId = fixture.teams?.away?.id;

    const [
  homeStatsResponse,
  awayStatsResponse,
  homeRecentResponse,
  awayRecentResponse,
  h2hResponse,
] = await Promise.all([
      callApiFootball("/teams/statistics", {
        league: leagueId,
        season,
        team: homeTeamId,
      }),

      callApiFootball("/teams/statistics", {
        league: leagueId,
        season,
        team: awayTeamId,
      }),

      callApiFootball("/fixtures", {
        team: homeTeamId,
        last: 5,
        timezone: "Europe/Paris",
      }),

      callApiFootball("/fixtures", {
        team: awayTeamId,
        last: 5,
        timezone: "Europe/Paris",
      }),
    callApiFootball("/fixtures/headtohead", {
  h2h: `${homeTeamId}-${awayTeamId}`,
  last: 10,
  timezone: "Europe/Paris",
}),

      ]);

    function simplifyRecentMatch(item, teamId) {
      const isHome = item.teams?.home?.id === teamId;

      const goalsFor = isHome
        ? item.goals?.home
        : item.goals?.away;

      const goalsAgainst = isHome
        ? item.goals?.away
        : item.goals?.home;

      let result = "D";

      if (goalsFor > goalsAgainst) {
        result = "W";
      } else if (goalsFor < goalsAgainst) {
        result = "L";
      }

      return {
        fixtureId: item.fixture?.id,
        date: item.fixture?.date,
        competition: item.league?.name,
        opponent: isHome
          ? item.teams?.away?.name
          : item.teams?.home?.name,
        location: isHome ? "home" : "away",
        goalsFor,
        goalsAgainst,
        result,
      };
    }

    const homeRecentMatches =
      homeRecentResponse.data?.response || [];

    const awayRecentMatches =
      awayRecentResponse.data?.response || [];
const h2hMatches =
  h2hResponse.data?.response || [];

const headToHead = h2hMatches.map((item) => ({
  fixtureId: item.fixture?.id,
  date: item.fixture?.date,
  competition: item.league?.name,

  homeTeam: {
    id: item.teams?.home?.id,
    name: item.teams?.home?.name,
  },

  awayTeam: {
    id: item.teams?.away?.id,
    name: item.teams?.away?.name,
  },

  goals: {
    home: item.goals?.home,
    away: item.goals?.away,
  },
}));
    return res.json({
      ok: true,

      match: {
        fixtureId,
        date: fixture.fixture?.date,
        league: fixture.league,
        homeTeam: fixture.teams?.home,
        awayTeam: fixture.teams?.away,
      },

      internalContext: {
        homeTeamStatistics:
          homeStatsResponse.data?.response || null,

        awayTeamStatistics:
          awayStatsResponse.data?.response || null,

        homeRecentForm: homeRecentMatches.map((item) =>
          simplifyRecentMatch(item, homeTeamId)
        ),

        awayRecentForm: awayRecentMatches.map((item) =>
          simplifyRecentMatch(item, awayTeamId)
        ),
     headToHead,
 },
    });


} catch (error) {
  console.error("DEBUG CATCH ANALYSE :", error);

  return res.status(error.response?.status || 500).json({
    ok: false,
    debugCatch: "NOUVEAU_CATCH_ACTIF",
    message: error.message || "Erreur inconnue",
    code: error.code || null,
    status: error.response?.status || null,
    endpoint: error.config?.url || null,
    apiData: error.response?.data ?? null,
  });
}

});

app.get("/internal/analyze/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    // ...

   const forceRefresh =
  req.query.refresh === "1" ||
  req.query.refresh === "true";

const cached =
  analysisCache.get(fixtureId);

if (
  !forceRefresh &&
  cached &&
  Date.now() - cached.createdAt <
    ANALYSIS_CACHE_TTL
) {
  return res.json({
    ...cached.data,
    cached: true,
  });
}

if (forceRefresh) {
  analysisCache.delete(fixtureId);
}
 const fixtureResponse = await callApiFootball("/fixtures", {
      id: fixtureId,
      timezone: "Europe/Paris",
    });

    const fixture = fixtureResponse.data?.response?.[0];

    if (!fixture) {
      return res.status(404).json({
        ok: false,
        error: "Match introuvable",
      });
    }
if (
  isExcludedFixture(fixture)
) {
  analysisCache.delete(
    fixtureId
  );

  return res.status(422).json({
    ok: false,
    skipped: true,
    reason:
      "FRIENDLY_MATCH_EXCLUDED",
  });
}
    const homeTeamId = fixture.teams?.home?.id;
    const awayTeamId = fixture.teams?.away?.id;

    const [
      homeRecentResponse,
      awayRecentResponse,
      h2hResponse,
      oddsResponse,
injuriesResponse,
lineupsResponse,
    ] = await Promise.all([
      callApiFootball("/fixtures", {
        team: homeTeamId,
        last: 5,
        timezone: "Europe/Paris",
      }),

      callApiFootball("/fixtures", {
        team: awayTeamId,
        last: 5,
        timezone: "Europe/Paris",
      }),

      callApiFootball("/fixtures/headtohead", {
        h2h: `${homeTeamId}-${awayTeamId}`,
        last: 10,
        timezone: "Europe/Paris",
      }),

      callApiFootball("/odds", {
  fixture: fixtureId,
  bookmaker: DEFAULT_BOOKMAKER,
}),
callApiFootball("/injuries", {
  fixture: fixtureId,
}),

callApiFootball("/fixtures/lineups", {
  fixture: fixtureId,
}),
    ]);
const homeRecentForm =
  homeRecentResponse.data?.response || [];

const awayRecentForm =
  awayRecentResponse.data?.response || [];
const getTeamResult = (match, teamId) => {
  const isHome =
    match.teams?.home?.id === teamId;

  const goalsFor = isHome
    ? match.goals?.home
    : match.goals?.away;

  const goalsAgainst = isHome
    ? match.goals?.away
    : match.goals?.home;

  if (goalsFor > goalsAgainst) return "W";
  if (goalsFor < goalsAgainst) return "L";

  return "D";
};

const homeResults = homeRecentForm.map(
  (match) => getTeamResult(match, homeTeamId)
);

const awayResults = awayRecentForm.map(
  (match) => getTeamResult(match, awayTeamId)
);
const rawOdds = oddsResponse.data?.response || [];

const market = summarizeMatchWinnerOdds(rawOdds);

const injuries =
  injuriesResponse.data?.response || [];

const lineups =
  lineupsResponse.data?.response || [];

const poissonModel =
  computePoissonModel({
    homeRecentForm,
    awayRecentForm,
    homeTeamId,
    awayTeamId,
  });

const extractGoals = (matches, teamId) => {
  const goalsFor = [];
  const goalsAgainst = [];

  for (const match of matches) {
    const isHome =
      match.teams?.home?.id === teamId;

    const scored = isHome
      ? match.goals?.home
      : match.goals?.away;

    const conceded = isHome
      ? match.goals?.away
      : match.goals?.home;

    if (
      Number.isFinite(scored) &&
      Number.isFinite(conceded)
    ) {
      goalsFor.push(scored);
      goalsAgainst.push(conceded);
    }
  }

  return {
    goalsFor,
    goalsAgainst,
  };
};

const homeGoalsData = extractGoals(
  homeRecentForm,
  homeTeamId
);

const awayGoalsData = extractGoals(
  awayRecentForm,
  awayTeamId
);

const advancedXGModel =
  computeAdvancedXGModel({
    leagueAverageGoals: {
      home: 1.4,
      away: 1.1,
    },

    /*
     * Le Poisson reste un baseline unique.
     * Il n'est plus recopié dans season et venue.
     */
    baselineExpectedGoals: {
      home:
        poissonModel.expectedGoals.home,
      away:
        poissonModel.expectedGoals.away,
    },

    home: {
      recent: {
        goalsFor:
          homeGoalsData.goalsFor,
        goalsAgainst:
          homeGoalsData.goalsAgainst,
      },

      /*
       * À remplacer plus tard par de vraies statistiques saison.
       */
      season: {
        goalsForPerMatch: null,
        goalsAgainstPerMatch: null,
      },

      /*
       * À remplacer plus tard par de vraies statistiques à domicile.
       */
      venue: {
        goalsForPerMatch: null,
        goalsAgainstPerMatch: null,
      },

      injuryImpact: 0,
      lineupImpact: 0,
      fatigueImpact: 0,
      motivationImpact: 0,
    },

    away: {
      recent: {
        goalsFor:
          awayGoalsData.goalsFor,
        goalsAgainst:
          awayGoalsData.goalsAgainst,
      },

      /*
       * À remplacer plus tard par de vraies statistiques saison.
       */
      season: {
        goalsForPerMatch: null,
        goalsAgainstPerMatch: null,
      },

      /*
       * À remplacer plus tard par de vraies statistiques à l'extérieur.
       */
      venue: {
        goalsForPerMatch: null,
        goalsAgainstPerMatch: null,
      },

      injuryImpact: 0,
      lineupImpact: 0,
      fatigueImpact: 0,
      motivationImpact: 0,
    },

    metadata: {
      hasLineups:
        Array.isArray(lineups) &&
        lineups.length >= 2,

      hasInjuries:
        Array.isArray(injuries),
    },
  });
const xgConfidence =
  computeXgConfidence({
    homeRecentForm,
    awayRecentForm,
    injuries,
    lineups,
  });

const xgSource =
  poissonModel.source ||
  "recent-form-goals";

const xgQuality =
  poissonModel.quality ||
  "low";

const officialXgHome =
  advancedXGModel?.expectedGoals?.home ??
  poissonModel.expectedGoals.home;

const officialXgAway =
  advancedXGModel?.expectedGoals?.away ??
  poissonModel.expectedGoals.away;

const officialXgSource =
  advancedXGModel
    ? "advanced-xg-v1"
    : "poisson";

const monteCarloModel =
  FootballMonteCarlo(
    {
      id: fixtureId,
     xg_home: officialXgHome,
xg_away: officialXgAway,
    },
    {
      match: {
        id: fixtureId,
        xgHome: officialXgHome,
xgAway: officialXgAway,
      },
    },
    10000,
    {
      seed: fixtureId,
    }
  );
const monteCarloFavorite = [
  {
    key: "home",
    probability: monteCarloModel.homeWin,
  },
  {
    key: "draw",
    probability: monteCarloModel.draw,
  },
  {
    key: "away",
    probability: monteCarloModel.awayWin,
  },
].sort(
  (a, b) =>
    b.probability - a.probability
)[0];

const baseFootballBrain =
  computeFootballBrainScore(
    homeResults.map((result) => ({ result })),
    awayResults.map((result) => ({ result }))
  );

const phaseOneContext =
  computePhaseOneContext({
    match: {
      league: fixture.league,
    },
    homeResults,
    awayResults,
    market,
    baseScore: baseFootballBrain,
  });

const phaseTwoContext =
  computePhaseTwoContext({
    fixture,
    homeRecentForm,
    awayRecentForm,
    injuries,
    lineups,
  });

const footballBrain = {
  homeScore:
    phaseOneContext.adjustedHomeScore +
    phaseTwoContext.scoreAdjustment.home,

  awayScore:
    phaseOneContext.adjustedAwayScore +
    phaseTwoContext.scoreAdjustment.away,

  advantage:
    (
      phaseOneContext.adjustedHomeScore +
      phaseTwoContext.scoreAdjustment.home
    ) -
    (
      phaseOneContext.adjustedAwayScore +
      phaseTwoContext.scoreAdjustment.away
    ),

  baseScore: baseFootballBrain,

  context: {
    phaseOne: phaseOneContext,
    phaseTwo: phaseTwoContext,
  },
};
const footballBrainDecision =
  computeFootballBrainDecision(
    footballBrain,
    market,
    monteCarloModel,
    xgConfidence
  );
const monteCarloAgreement = {
  favorite:
    monteCarloFavorite.key,

  probability:
    Number(
      monteCarloFavorite.probability
    ),

  agreesWithDecision:
    monteCarloFavorite.key ===
    footballBrainDecision.selectedOutcome,
};
const headToHead =
  h2hResponse.data?.response || [];

const footballBrainRating =
  computeFootballBrainRating({
    footballBrain,
    footballBrainDecision,
    market,
    headToHead,
  });
const footballBrainPickScore =
  computeFootballBrainPickScore({
    decision: footballBrainDecision,
    market,
    footballBrain,
  });
const result = {
  ok: true,
  analysis: {
    fixtureId,
    match: {
      date: fixture.fixture?.date,
      homeTeam: fixture.teams?.home,
      awayTeam: fixture.teams?.away,
      league: fixture.league,
    },

  homeRecentForm,
    awayRecentForm,
    headToHead,
    market,
    poissonModel,
    advancedXGModel,
    xgConfidence,
    officialXgHome,
officialXgAway,
officialXgSource,
    xgSource,
    xgQuality,
    monteCarloModel,

    context: {
      injuries: {
        available:
          Array.isArray(injuries),
        count:
          Array.isArray(injuries)
            ? injuries.length
            : 0,
        items:
          Array.isArray(injuries)
            ? injuries
            : [],
        impact:
          phaseTwoContext?.injuryImpact ?? 0,
      },

      lineups: {
  available:
    Array.isArray(lineups) &&
    lineups.length > 0,

  count:
    Array.isArray(lineups)
      ? lineups.length
      : 0,

  items:
    Array.isArray(lineups)
      ? lineups
      : [],

  homeFormation:
    lineups?.[0]?.formation ||
    null,

  awayFormation:
    lineups?.[1]?.formation ||
    null,

  homeConfirmed:
    Boolean(
      lineups?.[0]
    ),

  awayConfirmed:
    Boolean(
      lineups?.[1]
    ),

  impact:
    phaseTwoContext?.lineupImpact ??
    0,
},

      fatigue: {
  available:
    phaseTwoContext?.fatigue
      ?.homeRestDays != null ||
    phaseTwoContext?.fatigue
      ?.awayRestDays != null,

  homeRestDays:
    phaseTwoContext?.fatigue
      ?.homeRestDays ??
    null,

  awayRestDays:
    phaseTwoContext?.fatigue
      ?.awayRestDays ??
    null,

  homePenalty:
    phaseTwoContext?.fatigue
      ?.homePenalty ??
    0,

  awayPenalty:
    phaseTwoContext?.fatigue
      ?.awayPenalty ??
    0,

  impact:
    phaseTwoContext?.fatigueImpact ??
    0,
},
      motivation: {
        impact:
          phaseTwoContext?.motivationImpact ?? 0,
      },

      phaseTwoContext:
        phaseTwoContext || null,
    },

    monteCarloAgreement,
    footballBrain,
    footballBrainDecision,
    footballBrainRating,
    footballBrainPickScore,
  },
};
          



await savePredictionToDatabase(
  result.analysis
);

analysisCache.set(fixtureId, {
  createdAt: Date.now(),
  data: result,
});

return res.json({
  ...result,
  cached: false,
});

  } catch (error) {
    console.error(
      "ERREUR /internal/analyze :",
      error
    );

    return res
      .status(error.response?.status || 500)
      .json({
        ok: false,
        debugCatch: "ANALYZE_CATCH_ACTIF",
        message:
          error.message ||
          "Erreur inconnue",
        code:
          error.code || null,
        status:
          error.response?.status || null,
        endpoint:
          error.config?.url || null,
        apiData:
          error.response?.data ?? null,
        apiDataType:
          typeof error.response?.data,
      });
  }
});

function computeFootballBrainScore(
  homeRecent,
  awayRecent
) {
  const scoreMap = {
    W: 3,
    D: 1,
    L: 0,
  };

  const getScore = (matches) =>
    matches.reduce((sum, match) => {
      return sum + scoreMap[match.result];
    }, 0);

  const homeScore = getScore(homeRecent);
  const awayScore = getScore(awayRecent);

  return {
    homeScore,
    awayScore,
    advantage: homeScore - awayScore,
  };
}
function summarizeMatchWinnerOdds(oddsData) {
  const homeOdds = [];
  const drawOdds = [];
  const awayOdds = [];

  for (const fixtureOdds of oddsData) {
    for (const bookmaker of fixtureOdds.bookmakers || []) {
      const matchWinner = (bookmaker.bets || []).find(
        (bet) => bet.name === "Match Winner"
      );

      if (!matchWinner) continue;

      for (const item of matchWinner.values || []) {
        const odd = Number(item.odd);

        if (!Number.isFinite(odd)) continue;

        if (item.value === "Home") homeOdds.push(odd);
        if (item.value === "Draw") drawOdds.push(odd);
        if (item.value === "Away") awayOdds.push(odd);
      }
    }
  }

  const average = (values) => {
    if (values.length === 0) return null;

    return Number(
      (
        values.reduce((sum, value) => sum + value, 0) /
        values.length
      ).toFixed(2)
    );
  };

  const home = average(homeOdds);
  const draw = average(drawOdds);
  const away = average(awayOdds);

  const availableOdds = [
    { key: "home", odd: home },
    { key: "draw", odd: draw },
    { key: "away", odd: away },
  ].filter((item) => item.odd !== null);

  const favorite =
    availableOdds.length > 0
      ? availableOdds.reduce((best, current) =>
          current.odd < best.odd ? current : best
        ).key
      : null;

  return {
    homeAverageOdd: home,
    drawAverageOdd: draw,
    awayAverageOdd: away,
    marketFavorite: favorite,
    bookmakersUsed: homeOdds.length,
  };
}

app.get("/internal/lineups/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    const response = await callApiFootball(
      "/fixtures/lineups",
      {
        fixture: fixtureId,
      }
    );

    res.json({
      ok: true,
      count: response.data.results,
      lineups: response.data.response,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/internal/predictions/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    const fixture = await callApiFootball("/fixtures", {
      id: fixtureId,
    });

    const match = fixture.data.response?.[0];

    const response = await callApiFootball(
      "/predictions",
      {
        fixture: fixtureId,
      }
    );

    res.json({
      ok: true,
      prediction:
        response.data.response?.[0] || null,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

function computeFootballBrainDecision(
  footballBrain,
  market,
  monteCarloModel,
  xgConfidence
) {
    const xgConfidenceLevel =
  xgConfidence?.level || "LOW";

let monteCarloWeight = 0.05;

if (xgConfidenceLevel === "HIGH") {
  monteCarloWeight = 0.25;
} else if (xgConfidenceLevel === "MEDIUM") {
  monteCarloWeight = 0.15;
}

const remainingWeight =
  1 - monteCarloWeight;

const formWeight =
  remainingWeight * (35 / 75);

const marketWeight =
  remainingWeight * (40 / 75);
  const homeFormScore = footballBrain.homeScore || 0;
  const awayFormScore = footballBrain.awayScore || 0;

  const totalFormScore = homeFormScore + awayFormScore;

  let homeFormProbability =
    totalFormScore > 0
      ? homeFormScore / totalFormScore
      : 0.5;

  let awayFormProbability =
    totalFormScore > 0
      ? awayFormScore / totalFormScore
      : 0.5;
const drawFormProbability =
  Math.max(
    0.1,
    1 -
      Math.abs(
        homeFormProbability -
        awayFormProbability
      )
  );
  const homeOdd = market?.homeAverageOdd;
  const drawOdd = market?.drawAverageOdd;
  const awayOdd = market?.awayAverageOdd;

  let homeMarketProbability =
    homeOdd && homeOdd > 0
      ? 1 / homeOdd
      : 0.33;

  let drawMarketProbability =
    drawOdd && drawOdd > 0
      ? 1 / drawOdd
      : 0.33;

  let awayMarketProbability =
    awayOdd && awayOdd > 0
      ? 1 / awayOdd
      : 0.33;

  const marketTotal =
    homeMarketProbability +
    drawMarketProbability +
    awayMarketProbability;

  homeMarketProbability /= marketTotal;
  drawMarketProbability /= marketTotal;
  awayMarketProbability /= marketTotal;
const monteCarloHome =
  Number(monteCarloModel?.homeWin);

const monteCarloDraw =
  Number(monteCarloModel?.draw);

const monteCarloAway =
  Number(monteCarloModel?.awayWin);

const monteCarloAvailable =
  Number.isFinite(monteCarloHome) &&
  Number.isFinite(monteCarloDraw) &&
  Number.isFinite(monteCarloAway);

const monteCarloHomeProbability =
  monteCarloAvailable
    ? monteCarloHome / 100
    : homeMarketProbability;

const monteCarloDrawProbability =
  monteCarloAvailable
    ? monteCarloDraw / 100
    : drawMarketProbability;

const monteCarloAwayProbability =
  monteCarloAvailable
    ? monteCarloAway / 100
    : awayMarketProbability;
  const homeProbability =
  homeFormProbability * formWeight +
  homeMarketProbability * marketWeight +
  monteCarloHomeProbability *
    monteCarloWeight;

const awayProbability =
  awayFormProbability * formWeight +
  awayMarketProbability * marketWeight +
  monteCarloAwayProbability *
    monteCarloWeight;

const drawProbability =
  drawFormProbability * formWeight +
  drawMarketProbability * marketWeight +
  monteCarloDrawProbability *
    monteCarloWeight;
  const probabilityTotal =
    homeProbability +
    drawProbability +
    awayProbability;

  const probabilities = {
    home: Number(
      ((homeProbability / probabilityTotal) * 100).toFixed(1)
    ),
    draw: Number(
      ((drawProbability / probabilityTotal) * 100).toFixed(1)
    ),
    away: Number(
      ((awayProbability / probabilityTotal) * 100).toFixed(1)
    ),
  };

  const options = [
    {
      key: "home",
      probability: probabilities.home,
      odd: homeOdd,
    },
    {
      key: "draw",
      probability: probabilities.draw,
      odd: drawOdd,
    },
    {
      key: "away",
      probability: probabilities.away,
      odd: awayOdd,
    },
  ];

  const bestOption = options.reduce((best, current) =>
    current.probability > best.probability
      ? current
      : best
  );

  const secondProbability = options
    .map((item) => item.probability)
    .sort((a, b) => b - a)[1];

  const probabilityGap =
    bestOption.probability - secondProbability;

  const confidence = Math.min(
    90,
    Math.max(
      40,
      Math.round(
        bestOption.probability +
        probabilityGap * 1.5
      )
    )
  );

  let risk = "élevé";

  if (confidence >= 75) {
    risk = "faible";
  } else if (confidence >= 60) {
    risk = "modéré";
  }

  const fairOdd =
    bestOption.probability > 0
      ? Number(
          (100 / bestOption.probability).toFixed(2)
        )
      : null;

  const value =
    bestOption.odd && fairOdd
      ? Number(
          (
            ((bestOption.odd / fairOdd) - 1) *
            100
          ).toFixed(1)
        )
      : null;

  const labelMap = {
    home: "Victoire domicile",
    draw: "Match nul",
    away: "Victoire extérieur",
  };

let decision = labelMap[bestOption.key];
let reason = "Issue la plus probable selon FootballBrain";
let valueLevel = "aucune";
let betStatus = "NO_BET";

if (value !== null) {
  if (value >= 10) {
    valueLevel = "forte";
    betStatus = "VALUE_BET";
  } else if (value >= 5) {
    valueLevel = "intéressante";
    betStatus = "VALUE_BET";
  } else if (value >= 3) {
    valueLevel = "faible";
    betStatus = "À_SURVEILLER";
  }
}



if (value === null || value < 3) {
  decision = "Pas de pari";
  reason =
    "La cote proposée n'offre pas suffisamment de value selon FootballBrain";
  betStatus = "NO_BET";
}

const selectedLabel = labelMap[bestOption.key]; 

const explanation =
  decision === "Pas de pari"
    ? `${selectedLabel} est actuellement le scénario le plus probable à ${bestOption.probability} %, mais la cote de ${bestOption.odd ?? "N/A"} est inférieure à la cote juste estimée à ${fairOdd ?? "N/A"}. FootballBrain ne détecte donc pas de value suffisante.`
    : `FootballBrain recommande ${decision}. La probabilité estimée est de ${bestOption.probability} %, avec une cote juste de ${fairOdd ?? "N/A"} et une value de ${value ?? "N/A"} %.`;
const monteCarloFavorite = [
  {
    key: "home",
    probability: monteCarloHome,
  },
  {
    key: "draw",
    probability: monteCarloDraw,
  },
  {
    key: "away",
    probability: monteCarloAway,
  },
]
  .filter((item) =>
    Number.isFinite(item.probability)
  )
  .sort(
    (a, b) =>
      b.probability - a.probability
  )[0] || null;

const monteCarloAgreement =
  monteCarloFavorite
    ? monteCarloFavorite.key ===
      bestOption.key
    : null;
const decisionTrace = [
  `xgConfidence = ${xgConfidenceLevel}`,

  `Poids forme = ${Number(
    (formWeight * 100).toFixed(1)
  )}%`,

  `Poids marché = ${Number(
    (marketWeight * 100).toFixed(1)
  )}%`,

  `Poids Monte Carlo = ${Number(
    (monteCarloWeight * 100).toFixed(1)
  )}%`,

  `Monte Carlo favorise ${
    monteCarloFavorite?.key || "inconnu"
  } à ${
    monteCarloFavorite?.probability ?? "N/A"
  }%`,

  `FootballBrain favorise ${
    bestOption.key
  } à ${
    bestOption.probability
  }%`,

  `Cote marché = ${
    bestOption.odd ?? "N/A"
  }`,

  `Cote juste = ${
    fairOdd ?? "N/A"
  }`,

  `Value = ${
    value ?? "N/A"
  }%`,

  `Décision finale = ${betStatus}`,

];

const explainability =
  createDecisionExplainability({
    selectedOutcome: bestOption.key,
    selectedProbability:
      bestOption.probability,
    probabilities,
    weights: {
      form: formWeight,
      market: marketWeight,
      monteCarlo: monteCarloWeight,
    },
    modelInputs: {
      form: {
        home: homeFormProbability,
        draw: drawFormProbability,
        away: awayFormProbability,
      },
      market: {
        home: homeMarketProbability,
        draw: drawMarketProbability,
        away: awayMarketProbability,
      },
      monteCarlo: {
        home: monteCarloHomeProbability,
        draw: monteCarloDrawProbability,
        away: monteCarloAwayProbability,
      },
    },
    monteCarlo: {
      available: monteCarloAvailable,
      favorite:
        monteCarloFavorite?.key || null,
      probability:
        monteCarloFavorite?.probability || null,
      agrees: monteCarloAgreement,
    },
    confidence,
    risk,
    fairOdd,
    marketOdd: bestOption.odd || null,
    value,
    betStatus,
    probabilityGap,
  });

return {
  probabilities,
  decision,
  reason,
  explanation,
  betStatus,
  valueLevel,
  confidence,
  risk,
  fairOdd,
  marketOdd: bestOption.odd || null,
  value,
  selectedOutcome: bestOption.key,

  weights: {
    form: Number(formWeight.toFixed(3)),
    market: Number(marketWeight.toFixed(3)),
    monteCarlo: Number(
      monteCarloWeight.toFixed(3)
    ),
    xgConfidenceLevel,
  },
modelInputs: {
  form: {
    home: Number(
      homeFormProbability.toFixed(4)
    ),
    draw: Number(
      drawFormProbability.toFixed(4)
    ),
    away: Number(
      awayFormProbability.toFixed(4)
    ),
  },

  market: {
    home: Number(
      homeMarketProbability.toFixed(4)
    ),
    draw: Number(
      drawMarketProbability.toFixed(4)
    ),
    away: Number(
      awayMarketProbability.toFixed(4)
    ),
  },

  monteCarlo: {
    home: Number(
      monteCarloHomeProbability.toFixed(4)
    ),
    draw: Number(
      monteCarloDrawProbability.toFixed(4)
    ),
    away: Number(
      monteCarloAwayProbability.toFixed(4)
    ),
  },
},

decisionTrace,
explainability,

monteCarlo: {
  available: monteCarloAvailable,
  favorite:
    monteCarloFavorite?.key || null,
  probability:
    monteCarloFavorite?.probability || null,
  agrees:
    monteCarloAgreement,
},
};
}
function computeFootballBrainRating({
  footballBrain,
  footballBrainDecision,
  market,
  headToHead,
}) {
  const homeScore = footballBrain?.homeScore || 0;
  const awayScore = footballBrain?.awayScore || 0;
  const totalFormScore = homeScore + awayScore;

  const formScore =
    totalFormScore > 0
      ? Math.round(
          (Math.max(homeScore, awayScore) /
            totalFormScore) *
            100
        )
      : 50;

  const marketScore =
    footballBrainDecision?.selectedOutcome ===
    market?.marketFavorite
      ? 80
      : 45;

  let h2hScore = 50;

  if (Array.isArray(headToHead) && headToHead.length > 0) {
    const draws = headToHead.filter(
      (match) =>
        match.goals?.home === match.goals?.away
    ).length;

    h2hScore = Math.round(
      (draws / headToHead.length) * 100
    );
  }

  const valueScore =
    footballBrainDecision?.value === null
      ? 50
      : Math.max(
          0,
          Math.min(
            100,
            Math.round(
              50 + footballBrainDecision.value * 2
            )
          )
        );

  const confidenceScore =
    footballBrainDecision?.confidence || 50;

  const globalScore = Math.round(
    formScore * 0.3 +
      marketScore * 0.25 +
      h2hScore * 0.15 +
      valueScore * 0.15 +
      confidenceScore * 0.15
  );

  return {
    form: formScore,
    market: marketScore,
    h2h: h2hScore,
    value: valueScore,
    confidence: confidenceScore,
    global: globalScore,
  };
}
function readPredictionHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return [];
    }

    const content = fs.readFileSync(HISTORY_FILE, "utf8");

    return content ? JSON.parse(content) : [];
  } catch (error) {
    console.error("Erreur lecture historique :", error.message);
    return [];
  }
}

function savePredictionHistory(history) {
  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(history, null, 2),
    "utf8"
  );
}

function saveFootballBrainPrediction(analysis) {
  const history = readPredictionHistory();

  const alreadyExists = history.some(
    (item) => item.fixtureId === analysis.fixtureId
  );

  if (alreadyExists) {
    return false;
  }

  history.push({
    fixtureId: analysis.fixtureId,
    createdAt: new Date().toISOString(),

    match: {
      date: analysis.match?.date,
      homeTeam: analysis.match?.homeTeam?.name,
      awayTeam: analysis.match?.awayTeam?.name,
      league: analysis.match?.league?.name,
    },

    prediction: {
      probabilities:
        analysis.footballBrainDecision?.probabilities,

      decision:
        analysis.footballBrainDecision?.decision,

      selectedOutcome:
        analysis.footballBrainDecision?.selectedOutcome,

      confidence:
        analysis.footballBrainDecision?.confidence,

      risk:
        analysis.footballBrainDecision?.risk,

      fairOdd:
        analysis.footballBrainDecision?.fairOdd,

      marketOdd:
        analysis.footballBrainDecision?.marketOdd,

      value:
        analysis.footballBrainDecision?.value,

      betStatus:
        analysis.footballBrainDecision?.betStatus,

      explanation:
        analysis.footballBrainDecision?.explanation,

      explainability:
        analysis.footballBrainDecision?.explainability,
    },

    result: {
      status: "PENDING",
      homeGoals: null,
      awayGoals: null,
      won: null,
      profit: null,
    },
  });

  savePredictionHistory(history);

  return true;
}
function computeHistoryStats(history) {
  const totalPredictions = history.length;

  const completed = history.filter(
    (item) => item.result?.status === "COMPLETED"
  );

  const noBet = history.filter(
    (item) => item.prediction?.betStatus === "NO_BET"
  ).length;

  const settledBets = completed.filter(
    (item) =>
      item.prediction?.betStatus !== "NO_BET" &&
      typeof item.result?.won === "boolean"
  );

  const wins = settledBets.filter(
    (item) => item.result.won === true
  ).length;

  const losses = settledBets.filter(
    (item) => item.result.won === false
  ).length;

  const totalProfit = settledBets.reduce(
    (sum, item) =>
      sum + Number(item.result?.profit || 0),
    0
  );

  const totalStake = settledBets.length;

  const winRate =
    settledBets.length > 0
      ? Number(
          (
            (wins / settledBets.length) *
            100
          ).toFixed(1)
        )
      : 0;

  const roi =
    totalStake > 0
      ? Number(
          (
            (totalProfit / totalStake) *
            100
          ).toFixed(1)
        )
      : 0;

  const averageConfidence =
    totalPredictions > 0
      ? Number(
          (
            history.reduce(
              (sum, item) =>
                sum +
                Number(
                  item.prediction?.confidence || 0
                ),
              0
            ) / totalPredictions
          ).toFixed(1)
        )
      : 0;

  const decisions = history.reduce(
    (acc, item) => {
      const decision =
        item.prediction?.decision || "Inconnue";

      acc[decision] =
        (acc[decision] || 0) + 1;

      return acc;
    },
    {}
  );

  return {
    totalPredictions,
    completedPredictions: completed.length,
    pendingPredictions:
      totalPredictions - completed.length,
    noBet,
    settledBets: settledBets.length,
    wins,
    losses,
    winRate,
    totalProfit: Number(totalProfit.toFixed(2)),
    roi,
    averageConfidence,
    decisions,
  };
}
app.get("/internal/history", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM predictions
      ORDER BY fixture_date DESC NULLS LAST,
               created_at DESC
    `);

    return res.json({
      ok: true,
      count: result.rows.length,
      history: result.rows,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/internal/stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::INTEGER AS total_predictions,

        COUNT(*) FILTER (
          WHERE result_status = 'COMPLETED'
        )::INTEGER AS completed_predictions,

        COUNT(*) FILTER (
          WHERE result_status = 'PENDING'
        )::INTEGER AS pending_predictions,

        COUNT(*) FILTER (
          WHERE bet_status = 'NO_BET'
        )::INTEGER AS no_bet,

        COUNT(*) FILTER (
          WHERE result_status = 'COMPLETED'
            AND bet_status <> 'NO_BET'
            AND won IS NOT NULL
        )::INTEGER AS settled_bets,

        COUNT(*) FILTER (
          WHERE won = TRUE
        )::INTEGER AS wins,

        COUNT(*) FILTER (
          WHERE won = FALSE
        )::INTEGER AS losses,

        COALESCE(
          SUM(profit) FILTER (
            WHERE result_status = 'COMPLETED'
              AND bet_status <> 'NO_BET'
          ),
          0
        )::NUMERIC AS total_profit,

        COALESCE(
          AVG(confidence),
          0
        )::NUMERIC AS average_confidence
      FROM predictions
    `);

    const row = result.rows[0];

    const settledBets =
      Number(row.settled_bets);

    const wins = Number(row.wins);
    const totalProfit =
      Number(row.total_profit);

    const winRate =
      settledBets > 0
        ? Number(
            (
              (wins / settledBets) *
              100
            ).toFixed(1)
          )
        : 0;

    // Chaque pari réglé représente une mise de 1 unité.
    const roi =
      settledBets > 0
        ? Number(
            (
              (totalProfit / settledBets) *
              100
            ).toFixed(1)
          )
        : 0;

    const decisionsResult =
      await pool.query(`
        SELECT
          decision,
          COUNT(*)::INTEGER AS count
        FROM predictions
        GROUP BY decision
        ORDER BY count DESC
      `);

    const decisions = {};

    for (const item of decisionsResult.rows) {
      decisions[
        item.decision || "Inconnue"
      ] = Number(item.count);
    }

    return res.json({
      ok: true,
      stats: {
        totalPredictions:
          Number(row.total_predictions),
        completedPredictions:
          Number(row.completed_predictions),
        pendingPredictions:
          Number(row.pending_predictions),
        noBet:
          Number(row.no_bet),
        settledBets,
        wins,
        losses:
          Number(row.losses),
        winRate,
        totalProfit:
          Number(totalProfit.toFixed(2)),
        roi,
        averageConfidence:
          Number(
            Number(
              row.average_confidence
            ).toFixed(1)
          ),
        decisions,
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
function computePhaseOneContext({
  match,
  homeResults,
  awayResults,
  market,
  baseScore,
}) {
  // Avantage fixe pour l'équipe à domicile
  const homeAdvantageBonus = 2;

  function countWinningStreak(results) {
    let streak = 0;

    for (const result of results) {
      if (result !== "W") break;
      streak += 1;
    }

    return streak;
  }

  const homeWinningStreak =
    countWinningStreak(homeResults);

  const awayWinningStreak =
    countWinningStreak(awayResults);

  // Bonus limité à 3 points
  const homeStreakBonus =
    Math.min(homeWinningStreak, 3);

  const awayStreakBonus =
    Math.min(awayWinningStreak, 3);

  const leagueName =
    match?.league?.name || "";

  const round =
    match?.league?.round || "";

  let matchImportance = "normale";
  let importanceScore = 1;

  if (
    leagueName.includes("Champions League") ||
    leagueName.includes("Europa League")
  ) {
    matchImportance = "élevée";
    importanceScore = 2;
  }

  if (
    round.includes("Final") ||
    round.includes("Semi") ||
    round.includes("Quarter")
  ) {
    matchImportance = "très élevée";
    importanceScore = 3;
  }

  if (leagueName.includes("Friendlies")) {
    matchImportance = "faible";
    importanceScore = 0;
  }

  const adjustedHomeScore =
    baseScore.homeScore +
    homeAdvantageBonus +
    homeStreakBonus;

  const adjustedAwayScore =
    baseScore.awayScore +
    awayStreakBonus;

  let footballBrainFavorite = "draw";

  if (adjustedHomeScore > adjustedAwayScore) {
    footballBrainFavorite = "home";
  }

  if (adjustedAwayScore > adjustedHomeScore) {
    footballBrainFavorite = "away";
  }

  const marketFavorite =
    market?.marketFavorite || null;

  const marketAgreement =
    marketFavorite !== null &&
    footballBrainFavorite === marketFavorite;

  return {
    adjustedHomeScore,
    adjustedAwayScore,
    adjustedAdvantage:
      adjustedHomeScore - adjustedAwayScore,

    homeAdvantageBonus,

    winningStreaks: {
      home: homeWinningStreak,
      away: awayWinningStreak,
    },

    streakBonuses: {
      home: homeStreakBonus,
      away: awayStreakBonus,
    },

    matchImportance,
    importanceScore,

    marketAgreement: {
      agrees: marketAgreement,
      marketFavorite,
      footballBrainFavorite,
    },
  };
}
function computePhaseTwoContext({
  fixture,
  homeRecentForm,
  awayRecentForm,
  injuries,
  lineups,
}) {
  const homeTeamId = fixture.teams?.home?.id;
  const awayTeamId = fixture.teams?.away?.id;

  const homeInjuries = injuries.filter(
    (item) => item.team?.id === homeTeamId
  );

  const awayInjuries = injuries.filter(
    (item) => item.team?.id === awayTeamId
  );

  function injuryWeight(item) {
    const type = String(item.player?.type || "").toLowerCase();
    const reason = String(
      item.player?.reason || item.player?.type || ""
    ).toLowerCase();

    if (type.includes("suspension")) return 2;

    if (
      reason.includes("knee") ||
      reason.includes("hamstring") ||
      reason.includes("fracture")
    ) {
      return 2;
    }

    return 1;
  }

  const homeInjuryPenalty = Math.min(
    6,
    homeInjuries.reduce(
      (sum, item) => sum + injuryWeight(item),
      0
    )
  );

  const awayInjuryPenalty = Math.min(
    6,
    awayInjuries.reduce(
      (sum, item) => sum + injuryWeight(item),
      0
    )
  );

  function getRestDays(recentMatches, kickoffDate) {
    const latestFinishedMatch = recentMatches.find(
      (item) =>
        item.fixture?.status?.short === "FT" &&
        item.fixture?.date
    );

    if (!latestFinishedMatch) return null;

    const kickoff = new Date(kickoffDate);
    const previousMatch = new Date(
      latestFinishedMatch.fixture.date
    );

    const difference =
      kickoff.getTime() - previousMatch.getTime();

    return Math.max(
      0,
      Math.floor(difference / (1000 * 60 * 60 * 24))
    );
  }

  const homeRestDays = getRestDays(
    homeRecentForm,
    fixture.fixture?.date
  );

  const awayRestDays = getRestDays(
    awayRecentForm,
    fixture.fixture?.date
  );

  function fatiguePenalty(restDays) {
    if (restDays === null) return 0;
    if (restDays <= 2) return 3;
    if (restDays <= 4) return 2;
    if (restDays <= 6) return 1;
    return 0;
  }

  const homeFatiguePenalty =
    fatiguePenalty(homeRestDays);

  const awayFatiguePenalty =
    fatiguePenalty(awayRestDays);

  const homeLineup = lineups.find(
    (item) => item.team?.id === homeTeamId
  );

  const awayLineup = lineups.find(
    (item) => item.team?.id === awayTeamId
  );

  const homeLineupConfirmed =
    Array.isArray(homeLineup?.startXI) &&
    homeLineup.startXI.length >= 11;

  const awayLineupConfirmed =
    Array.isArray(awayLineup?.startXI) &&
    awayLineup.startXI.length >= 11;

  return {
    injuries: {
      homeCount: homeInjuries.length,
      awayCount: awayInjuries.length,
      homePenalty: homeInjuryPenalty,
      awayPenalty: awayInjuryPenalty,
    },

    fatigue: {
      homeRestDays,
      awayRestDays,
      homePenalty: homeFatiguePenalty,
      awayPenalty: awayFatiguePenalty,
    },

    lineups: {
      homeConfirmed: homeLineupConfirmed,
      awayConfirmed: awayLineupConfirmed,
      homeFormation: homeLineup?.formation || null,
      awayFormation: awayLineup?.formation || null,
    },

    scoreAdjustment: {
      home:
        -homeInjuryPenalty -
        homeFatiguePenalty,

      away:
        -awayInjuryPenalty -
        awayFatiguePenalty,
    },
  };
}

app.get("/internal/db-test", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT NOW() AS current_time"
    );

    return res.json({
      ok: true,
      database: "connected",
      time: result.rows[0].current_time,
    });
  } catch (error) {
    console.error("ERREUR DB TEST :", error);

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Erreur inconnue",
      code:
        error.code || null,
      host:
        error.address || null,
      port:
        error.port || null,
    });
  }
});


async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      api_team_id INTEGER UNIQUE NOT NULL,
      name TEXT NOT NULL,
      country TEXT,
      logo TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS elo_ratings (
      id SERIAL PRIMARY KEY,
      team_id INTEGER UNIQUE NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      rating NUMERIC(8,2) NOT NULL DEFAULT 1500,
      matches_played INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS elo_history (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      fixture_id INTEGER NOT NULL,
      rating_before NUMERIC(8,2) NOT NULL,
      rating_after NUMERIC(8,2) NOT NULL,
      rating_change NUMERIC(8,2) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
CREATE UNIQUE INDEX IF NOT EXISTS elo_history_team_fixture_unique
ON elo_history (team_id, fixture_id);
    CREATE TABLE IF NOT EXISTS predictions (
      id SERIAL PRIMARY KEY,
      fixture_id INTEGER UNIQUE NOT NULL,
      fixture_date TIMESTAMPTZ,
      league_id INTEGER,
      league_name TEXT,
      home_team_id INTEGER,
      home_team_name TEXT,
      away_team_id INTEGER,
      away_team_name TEXT,

      decision TEXT,
      selected_outcome TEXT,
      bet_status TEXT,
      confidence NUMERIC(5,2),
      risk TEXT,

      home_probability NUMERIC(5,2),
      draw_probability NUMERIC(5,2),
      away_probability NUMERIC(5,2),

      fair_odd NUMERIC(8,2),
      market_odd NUMERIC(8,2),
      value_percentage NUMERIC(8,2),

      explanation TEXT,

      result_status TEXT DEFAULT 'PENDING',
      home_goals INTEGER,
      away_goals INTEGER,
      won BOOLEAN,
      profit NUMERIC(10,2),

      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS official_xg_home NUMERIC(8,3);

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS official_xg_away NUMERIC(8,3);

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS xg_source TEXT;

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS xg_confidence_score NUMERIC(5,2);

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS xg_confidence_level TEXT;

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS form_weight NUMERIC(6,4);

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS market_weight NUMERIC(6,4);

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS monte_carlo_weight NUMERIC(6,4);

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS decision_trace JSONB;

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS model_inputs JSONB;
 ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS monte_carlo_model JSONB;
      `);
}
app.get("/internal/db-init", async (req, res) => {
  try {
    await initializeDatabase();

    return res.json({
      ok: true,
      message: "Tables FootballBrain créées",
      tables: [
        "teams",
        "elo_ratings",
        "elo_history",
        "predictions",
      ],
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
async function savePredictionToDatabase(
  analysis
) {
  const decision =
    analysis.footballBrainDecision ||
    {};

  const probabilities =
    decision.probabilities || {};

  const weights =
    decision.weights || {};

  const xgConfidence =
    analysis.xgConfidence || {};

  const decisionTrace =
    Array.isArray(
      decision.decisionTrace
    )
      ? decision.decisionTrace
      : [];

  const modelInputs =
    decision.modelInputs || {};

  const monteCarloModel =
    analysis.monteCarloModel || {};

  const analysisContext =
    analysis.context || {};

  /*
   * Snapshot Brain Studio.
   *
   * Plusieurs emplacements sont acceptés
   * afin de rester compatible avec les
   * différentes versions du moteur.
   */
  const studioSnapshot =
    analysis.studioSnapshot ||
    analysis.brainStudioSnapshot ||
    analysis.studio_snapshot ||
    analysis.studio ||
    null;

  const primaryMarket =
    studioSnapshot?.primaryMarket ||
    analysis.primaryMarket ||
    decision.primaryMarket ||
    {};

  const studioDecision =
    primaryMarket?.decision ||
    studioSnapshot?.decision ||
    {};

  const studioMarketKey =
    analysis.studioMarketKey ||
    analysis.studio_market_key ||
    primaryMarket.key ||
    primaryMarket.marketKey ||
    null;

  const studioMarketLabel =
    analysis.studioMarketLabel ||
    analysis.studio_market_label ||
    primaryMarket.label ||
    primaryMarket.marketLabel ||
    null;

  const studioProbability =
    analysis.studioProbability ??
    analysis.studio_probability ??
    primaryMarket.probability ??
    primaryMarket?.fairOdds
      ?.calibratedProbability ??
    null;

  const studioDecisionScore =
    analysis.studioDecisionScore ??
    analysis.studio_decision_score ??
    studioDecision.score ??
    primaryMarket.decisionScore ??
    primaryMarket.score ??
    null;

  const studioDecisionType =
    analysis.studioDecisionType ||
    analysis.studio_decision_type ||
    studioDecision.type ||
    primaryMarket.decisionType ||
    null;

  const studioDecisionGrade =
    analysis.studioDecisionGrade ||
    analysis.studio_decision_grade ||
    studioDecision.grade ||
    primaryMarket.decisionGrade ||
    null;

  const studioAnalysisVersion =
    analysis.studioAnalysisVersion ||
    analysis.studio_analysis_version ||
    studioSnapshot?.analysisVersion ||
    studioSnapshot?.version ||
    null;

  const hasStudioData =
    Boolean(
      studioMarketKey ||
      studioMarketLabel ||
      studioDecisionType ||
      studioSnapshot
    );

  const studioSavedAt =
    hasStudioData
      ? new Date().toISOString()
      : null;

  const savedPrediction =
    await pool.query(
      `
        INSERT INTO predictions (
          fixture_id,
          fixture_date,

          league_id,
          league_name,

          home_team_id,
          home_team_name,

          away_team_id,
          away_team_name,

          decision,
          selected_outcome,
          bet_status,

          confidence,
          risk,

          home_probability,
          draw_probability,
          away_probability,

          fair_odd,
          market_odd,
          value_percentage,

          explanation,

          studio_market_key,
          studio_market_label,
          studio_probability,
          studio_decision_score,
          studio_decision_type,
          studio_decision_grade,
          studio_analysis_version,
          studio_snapshot,
          studio_saved_at,

          official_xg_home,
          official_xg_away,
          xg_source,
          xg_confidence_score,
          xg_confidence_level,

          form_weight,
          market_weight,
          monte_carlo_weight,

          decision_trace,
          model_inputs,
          monte_carlo_model,
          analysis_context
        )

        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25,
          $26, $27, $28, $29, $30,
          $31, $32, $33, $34, $35,
          $36, $37, $38, $39, $40,
          $41
        )

        ON CONFLICT (fixture_id)
        DO UPDATE SET
          fixture_date =
            EXCLUDED.fixture_date,

          league_id =
            EXCLUDED.league_id,

          league_name =
            EXCLUDED.league_name,

          home_team_id =
            EXCLUDED.home_team_id,

          home_team_name =
            EXCLUDED.home_team_name,

          away_team_id =
            EXCLUDED.away_team_id,

          away_team_name =
            EXCLUDED.away_team_name,

          decision =
            EXCLUDED.decision,

          selected_outcome =
            EXCLUDED.selected_outcome,

          bet_status =
            EXCLUDED.bet_status,

          confidence =
            EXCLUDED.confidence,

          risk =
            EXCLUDED.risk,

          home_probability =
            EXCLUDED.home_probability,

          draw_probability =
            EXCLUDED.draw_probability,

          away_probability =
            EXCLUDED.away_probability,

          fair_odd =
            EXCLUDED.fair_odd,

          market_odd =
            EXCLUDED.market_odd,

          value_percentage =
            EXCLUDED.value_percentage,

          explanation =
            EXCLUDED.explanation,

          /*
           * Une valeur vide ne doit jamais
           * effacer un snapshot Brain Studio
           * déjà enregistré.
           */
          studio_market_key =
            COALESCE(
              EXCLUDED.studio_market_key,
              predictions.studio_market_key
            ),

          studio_market_label =
            COALESCE(
              EXCLUDED.studio_market_label,
              predictions.studio_market_label
            ),

          studio_probability =
            COALESCE(
              EXCLUDED.studio_probability,
              predictions.studio_probability
            ),

          studio_decision_score =
            COALESCE(
              EXCLUDED.studio_decision_score,
              predictions.studio_decision_score
            ),

          studio_decision_type =
            COALESCE(
              EXCLUDED.studio_decision_type,
              predictions.studio_decision_type
            ),

          studio_decision_grade =
            COALESCE(
              EXCLUDED.studio_decision_grade,
              predictions.studio_decision_grade
            ),

          studio_analysis_version =
            COALESCE(
              EXCLUDED.studio_analysis_version,
              predictions.studio_analysis_version
            ),

          studio_snapshot =
            COALESCE(
              EXCLUDED.studio_snapshot,
              predictions.studio_snapshot
            ),

          studio_saved_at =
            COALESCE(
              EXCLUDED.studio_saved_at,
              predictions.studio_saved_at
            ),

          official_xg_home =
            EXCLUDED.official_xg_home,

          official_xg_away =
            EXCLUDED.official_xg_away,

          xg_source =
            EXCLUDED.xg_source,

          xg_confidence_score =
            EXCLUDED.xg_confidence_score,

          xg_confidence_level =
            EXCLUDED.xg_confidence_level,

          form_weight =
            EXCLUDED.form_weight,

          market_weight =
            EXCLUDED.market_weight,

          monte_carlo_weight =
            EXCLUDED.monte_carlo_weight,

          decision_trace =
            EXCLUDED.decision_trace,

          model_inputs =
            EXCLUDED.model_inputs,

          monte_carlo_model =
            EXCLUDED.monte_carlo_model,

          analysis_context =
            EXCLUDED.analysis_context,

          updated_at = NOW()

        RETURNING
          fixture_id,

          studio_market_key,
          studio_market_label,
          studio_probability,
          studio_decision_score,
          studio_decision_type,
          studio_decision_grade,
          studio_analysis_version,
          studio_saved_at,

          official_xg_home,
          official_xg_away,

          monte_carlo_model,
          analysis_context,
          decision_trace,

          updated_at
      `,
      [
        analysis.fixtureId,

        analysis.match?.date ||
          null,

        analysis.match?.league?.id ||
          null,

        analysis.match?.league?.name ||
          null,

        analysis.match?.homeTeam?.id ||
          null,

        analysis.match?.homeTeam?.name ||
          null,

        analysis.match?.awayTeam?.id ||
          null,

        analysis.match?.awayTeam?.name ||
          null,

        decision.decision ||
          null,

        decision.selectedOutcome ||
          null,

        decision.betStatus ||
          null,

        decision.confidence ??
          null,

        decision.risk ||
          null,

        probabilities.home ??
          null,

        probabilities.draw ??
          null,

        probabilities.away ??
          null,

        decision.fairOdd ??
          null,

        decision.marketOdd ??
          null,

        decision.value ??
          null,

        decision.explanation ||
          null,

        studioMarketKey,

        studioMarketLabel,

        studioProbability,

        studioDecisionScore,

        studioDecisionType,

        studioDecisionGrade,

        studioAnalysisVersion,

        studioSnapshot
          ? JSON.stringify(
              studioSnapshot
            )
          : null,

        studioSavedAt,

        analysis.officialXgHome ??
          null,

        analysis.officialXgAway ??
          null,

        analysis.officialXgSource ||
          null,

        xgConfidence.score ??
          null,

        xgConfidence.level ||
          null,

        weights.form ??
          null,

        weights.market ??
          null,

        weights.monteCarlo ??
          null,

        JSON.stringify(
          decisionTrace
        ),

        JSON.stringify(
          modelInputs
        ),

        JSON.stringify(
          monteCarloModel
        ),

        JSON.stringify(
          analysisContext
        ),
      ]
    );

  return savedPrediction.rows[0];
}
async function upsertTeam(
  team,
  country = null
) {
  const result =
    await pool.query(
      `
        INSERT INTO teams (
          api_team_id,
          name,
          country,
          logo,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          NOW()
        )

        ON CONFLICT (api_team_id)
        DO UPDATE SET
          name =
            EXCLUDED.name,

          country =
            COALESCE(
              EXCLUDED.country,
              teams.country
            ),

          logo =
            EXCLUDED.logo,

          updated_at =
            NOW()

        RETURNING *
      `,
      [
        team.id,
        team.name,
        country,
        team.logo || null,
      ]
    );

  return result.rows[0];
}

async function getOrCreateTeamElo(
  teamDatabaseId
) {
  const result =
    await pool.query(
      `
        INSERT INTO elo_ratings (
          team_id,
          rating,
          matches_played
        )
        VALUES (
          $1,
          1500,
          0
        )

        ON CONFLICT (team_id)
        DO UPDATE SET
          team_id =
            EXCLUDED.team_id

        RETURNING *
      `,
      [teamDatabaseId]
    );

  return result.rows[0];
} 

function calculateExpectedElo(ratingA, ratingB) {
  return 1 / (
    1 + Math.pow(10, (ratingB - ratingA) / 400)
  );
}

function calculateEloResult(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) {
    return {
      homeResult: 1,
      awayResult: 0,
    };
  }

  if (homeGoals < awayGoals) {
    return {
      homeResult: 0,
      awayResult: 1,
    };
  }

  return {
    homeResult: 0.5,
    awayResult: 0.5,
  };
}

async function updateEloFromFinishedFixture(fixture) {
  const status = fixture.fixture?.status?.short;

  if (!["FT", "AET", "PEN"].includes(status)) {
    throw new Error(
      "Le match n'est pas encore terminé"
    );
  }

  const fixtureId = fixture.fixture.id;

  const homeApiTeam = fixture.teams.home;
  const awayApiTeam = fixture.teams.away;

  const homeGoals = fixture.goals?.home;
  const awayGoals = fixture.goals?.away;

  if (
    !Number.isFinite(homeGoals) ||
    !Number.isFinite(awayGoals)
  ) {
    throw new Error(
      "Le score final du match est indisponible"
    );
  }

  const homeTeam = await upsertTeam(
    homeApiTeam,
    fixture.league?.country || null
  );

  const awayTeam = await upsertTeam(
    awayApiTeam,
    fixture.league?.country || null
  );

  const homeElo = await getOrCreateTeamElo(
    homeTeam.id
  );

  const awayElo = await getOrCreateTeamElo(
    awayTeam.id
  );

  const alreadyProcessed = await pool.query(
    `
      SELECT id
      FROM elo_history
      WHERE fixture_id = $1
      LIMIT 1
    `,
    [fixtureId]
  );

  if (alreadyProcessed.rows.length > 0) {
    return {
      alreadyProcessed: true,

      home: {
        team: homeTeam.name,
        rating: Number(homeElo.rating),
      },

      away: {
        team: awayTeam.name,
        rating: Number(awayElo.rating),
      },
    };
  }

  const homeRatingBefore =
    Number(homeElo.rating);

  const awayRatingBefore =
    Number(awayElo.rating);

  const expectedHome = calculateExpectedElo(
    homeRatingBefore + 60,
    awayRatingBefore
  );

  const expectedAway = 1 - expectedHome;

  const {
    homeResult,
    awayResult,
  } = calculateEloResult(
    homeGoals,
    awayGoals
  );

  const K_FACTOR = 32;

  const homeChange = Number(
    (
      K_FACTOR *
      (homeResult - expectedHome)
    ).toFixed(2)
  );

  const awayChange = Number(
    (
      K_FACTOR *
      (awayResult - expectedAway)
    ).toFixed(2)
  );

  const homeRatingAfter = Number(
    (homeRatingBefore + homeChange).toFixed(2)
  );

  const awayRatingAfter = Number(
    (awayRatingBefore + awayChange).toFixed(2)
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        UPDATE elo_ratings
        SET
          rating = $1,
          matches_played = matches_played + 1,
          updated_at = NOW()
        WHERE team_id = $2
      `,
      [
        homeRatingAfter,
        homeTeam.id,
      ]
    );

    await client.query(
      `
        UPDATE elo_ratings
        SET
          rating = $1,
          matches_played = matches_played + 1,
          updated_at = NOW()
        WHERE team_id = $2
      `,
      [
        awayRatingAfter,
        awayTeam.id,
      ]
    );

    await client.query(
      `
        INSERT INTO elo_history (
          team_id,
          fixture_id,
          rating_before,
          rating_after,
          rating_change
        )
        VALUES
          ($1, $2, $3, $4, $5),
          ($6, $2, $7, $8, $9)
      `,
      [
        homeTeam.id,
        fixtureId,
        homeRatingBefore,
        homeRatingAfter,
        homeChange,

        awayTeam.id,
        awayRatingBefore,
        awayRatingAfter,
        awayChange,
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    alreadyProcessed: false,

    fixtureId,

    score: {
      home: homeGoals,
      away: awayGoals,
    },

    home: {
      teamId: homeApiTeam.id,
      team: homeTeam.name,
      ratingBefore: homeRatingBefore,
      ratingAfter: homeRatingAfter,
      change: homeChange,
    },

    away: {
      teamId: awayApiTeam.id,
      team: awayTeam.name,
      ratingBefore: awayRatingBefore,
      ratingAfter: awayRatingAfter,
      change: awayChange,
    },
  };
}
app.get(
  "/internal/elo/process/:fixtureId",
  async (req, res) => {
    try {
      const fixtureId =
        Number(req.params.fixtureId);

      if (
        !Number.isInteger(fixtureId) ||
        fixtureId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "fixtureId invalide",
        });
      }

      const response =
        await callApiFootball(
          "/fixtures",
          {
            id: fixtureId,
            timezone: "Europe/Paris",
          }
        );

      const fixture =
        response.data?.response?.[0];

      if (!fixture) {
        return res.status(404).json({
          ok: false,
          error: "Match introuvable",
        });
      }

      const eloResult =
        await updateEloFromFinishedFixture(
          fixture
        );

      return res.json({
        ok: true,
        elo: eloResult,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
app.get(
  "/internal/team/:apiTeamId",
  async (req, res) => {
    try {
      const apiTeamId =
        Number(req.params.apiTeamId);

      const result = await pool.query(
        `
          SELECT
            t.api_team_id,
            t.name,
            t.country,
            t.logo,
            e.rating,
            e.matches_played,
            e.updated_at
          FROM teams t
          LEFT JOIN elo_ratings e
            ON e.team_id = t.id
          WHERE t.api_team_id = $1
        `,
        [apiTeamId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error:
            "Équipe absente du classement Elo",
        });
      }

      return res.json({
        ok: true,
        team: result.rows[0],
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
app.get(
  "/internal/team/:apiTeamId",
  async (req, res) => {
    try {
      const apiTeamId =
        Number(req.params.apiTeamId);

      const result = await pool.query(
        `
          SELECT
            t.api_team_id,
            t.name,
            t.country,
            t.logo,
            e.rating,
            e.matches_played,
            e.updated_at
          FROM teams t
          LEFT JOIN elo_ratings e
            ON e.team_id = t.id
          WHERE t.api_team_id = $1
        `,
        [apiTeamId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error:
            "Équipe absente du classement Elo",
        });
      }

      return res.json({
        ok: true,
        team: result.rows[0],
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
app.get(
  "/internal/elo-rankings",
  async (req, res) => {
    try {
      const limit = Math.min(
        100,
        Math.max(
          1,
          Number(req.query.limit) || 50
        )
      );

      const result = await pool.query(
        `
          SELECT
            t.api_team_id,
            t.name,
            t.country,
            t.logo,
            e.rating,
            e.matches_played,
            e.updated_at
          FROM elo_ratings e
          JOIN teams t
            ON t.id = e.team_id
          ORDER BY e.rating DESC
          LIMIT $1
        `,
        [limit]
      );

      return res.json({
        ok: true,
        count: result.rows.length,
        rankings: result.rows.map(
          (team, index) => ({
            rank: index + 1,
            ...team,
          })
        ),
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

function formatDateForApi(date) {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  ).format(date);
}

function getResultSyncDates() {
  const now = new Date();
  const dates = [];

  /*
   * Aujourd’hui + les 6 jours précédents.
   * Cela permet de rattraper les anciennes
   * prédictions restées bloquées.
   */
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(
      now.getTime() -
        offset *
          24 *
          60 *
          60 *
          1000
    );

    dates.push(
      formatDateForApi(date)
    );
  }

  return dates;
}

async function fetchFixturesByDate(date) {
  const response =
    await callApiFootball(
      "/fixtures",
      {
        date,
        timezone: "Europe/Paris",
      }
    );

  return Array.isArray(
    response.data?.response
  )
    ? response.data.response
    : [];
}

async function synchronizeFinishedPredictionsByDate() {
  const dates = getResultSyncDates();

  const summary = {
    dates,
    apiCalls: 0,
    fixturesReceived: 0,
    pendingPredictions: 0,
    matchedPredictions: 0,
    completed: 0,
    stillPending: 0,
    fixtureNotFound: 0,
    notFinished: 0,
    errors: 0,
    items: [],
  };

  /*
   * 1. Récupération groupée des fixtures
   *
   * Un seul appel API-Football par date.
   */
  const fixtureMap = new Map();

  for (const date of dates) {
    try {
      const fixtures =
        await fetchFixturesByDate(date);

      summary.apiCalls += 1;
      summary.fixturesReceived +=
        fixtures.length;

      for (const fixture of fixtures) {
        const fixtureId = Number(
          fixture?.fixture?.id
        );

        if (
          !Number.isInteger(fixtureId) ||
          fixtureId <= 0
        ) {
          continue;
        }

        fixtureMap.set(
          fixtureId,
          fixture
        );
      }
    } catch (error) {
      summary.apiCalls += 1;
      summary.errors += 1;

      summary.items.push({
        date,
        type: "API_DATE_ERROR",
        updated: false,
        error:
          error?.message ||
          "Erreur API-Football",
      });

      console.error(
        `RESULT SYNC : erreur pour la date ${date}`,
        error?.message || error
      );
    }
  }

  /*
   * 2. Sélection des prédictions anciennes
   * d’au moins 105 minutes.
   *
   * Fenêtre temporaire de 7 jours pour
   * rattraper les anciens matchs bloqués.
   */
  const pendingResult =
    await pool.query(
      `
        SELECT *
        FROM predictions
        WHERE
          (
            result_status = 'PENDING'
            OR result_status IS NULL
          )
          AND fixture_date >=
            NOW() - INTERVAL '7 days'
          AND fixture_date <=
            NOW() - INTERVAL '105 minutes'
        ORDER BY
          fixture_date DESC,
          created_at DESC
      `
    );

  const pendingPredictions =
    pendingResult.rows;

  summary.pendingPredictions =
    pendingPredictions.length;

  /*
   * 3. Comparaison locale entre PostgreSQL
   * et les fixtures récupérées.
   */
  for (
    const prediction
    of pendingPredictions
  ) {
    const fixtureId = Number(
      prediction.fixture_id
    );

    if (
      !Number.isInteger(fixtureId) ||
      fixtureId <= 0
    ) {
      summary.errors += 1;

      summary.items.push({
        fixtureId:
          prediction.fixture_id,
        type: "INVALID_FIXTURE_ID",
        updated: false,
        error: "fixture_id invalide",
      });

      continue;
    }

    const fixture =
      fixtureMap.get(fixtureId);

    /*
     * IMPORTANT :
     * on vérifie l’existence de fixture
     * avant de déclarer et d’utiliser status.
     */
    if (!fixture) {
      summary.stillPending += 1;
      summary.fixtureNotFound += 1;

      summary.items.push({
        fixtureId,
        fixtureDate:
          prediction.fixture_date,
        home:
          prediction.home_team_name,
        away:
          prediction.away_team_name,
        type:
          "FIXTURE_NOT_FOUND_IN_DATE_BATCH",
        updated: false,
      });

      continue;
    }

    summary.matchedPredictions += 1;

    const status = String(
      fixture?.fixture?.status?.short ||
        ""
    ).toUpperCase();

    /*
     * Le match existe, mais API-Football
     * ne le considère pas encore terminé.
     */
    if (
      !FINISHED_FIXTURE_STATUSES.has(
        status
      )
    ) {
      summary.stillPending += 1;
      summary.notFinished += 1;

      summary.items.push({
        fixtureId,
        fixtureDate:
          prediction.fixture_date,
        home:
          prediction.home_team_name,
        away:
          prediction.away_team_name,
        status:
          status || "UNKNOWN",
        type: "MATCH_NOT_FINISHED",
        updated: false,
      });

      continue;
    }

    /*
     * 4. Règlement de la prédiction.
     */
    try {
      const settlement =
        settlePrediction(
          prediction,
          fixture
        );

      const updateResult =
        await pool.query(
          `
            UPDATE predictions
            SET
              result_status = 'COMPLETED',
              home_goals = $1,
              away_goals = $2,
              won = $3,
              profit = $4,
              updated_at = NOW()
            WHERE fixture_id = $5
              AND (
                result_status = 'PENDING'
                OR result_status IS NULL
              )
            RETURNING
              fixture_id,
              result_status,
              home_goals,
              away_goals,
              won,
              profit
          `,
          [
            settlement.homeGoals,
            settlement.awayGoals,
            settlement.won,
            settlement.profit,
            fixtureId,
          ]
        );

      /*
       * Une autre synchronisation a peut-être
       * déjà terminé le match entre-temps.
       */
      if (
        updateResult.rows.length === 0
      ) {
        continue;
      }

      summary.completed += 1;

      summary.items.push({
        fixtureId,
        fixtureDate:
          prediction.fixture_date,
        home:
          prediction.home_team_name,
        away:
          prediction.away_team_name,
        status,
        score: {
          home:
            settlement.homeGoals,
          away:
            settlement.awayGoals,
        },
        selectedOutcome:
          prediction.selected_outcome,
        actualOutcome:
          settlement.actualOutcome,
        betStatus:
          prediction.bet_status,
        won:
          settlement.won,
        profit:
          settlement.profit,
        type: "COMPLETED",
        updated: true,
      });

      /*
       * La mise à jour ELO est secondaire.
       * Son éventuelle erreur ne doit jamais
       * remettre le match en PENDING.
       */
      try {
        await updateEloFromFinishedFixture(
          fixture
        );
      } catch (eloError) {
        console.warn(
          `RESULT SYNC : ELO non mis à jour pour ${fixtureId}`,
          eloError?.message ||
            eloError
        );
      }
    } catch (error) {
      summary.errors += 1;

      summary.items.push({
        fixtureId,
        fixtureDate:
          prediction.fixture_date,
        home:
          prediction.home_team_name,
        away:
          prediction.away_team_name,
        status,
        type: "SETTLEMENT_ERROR",
        updated: false,
        error:
          error?.message ||
          "Erreur de règlement",
      });

      console.error(
        `RESULT SYNC : erreur fixture ${fixtureId}`,
        error?.message || error
      );
    }
  }

  return summary;
}

app.get(
  "/internal/cron/update-results",
  async (req, res) => {
    const secret = req.query.secret;

    if (
      !process.env
        .INTERNAL_CRON_SECRET ||
      secret !==
        process.env
          .INTERNAL_CRON_SECRET
    ) {
      return res.status(401).json({
        ok: false,
        error: "Accès refusé",
      });
    }

    try {
      const summary =
        await synchronizeFinishedPredictionsByDate();

      return res.json({
        ok: true,
        summary,
      });
    } catch (error) {
      console.error(
        "ERREUR RESULT SYNC :",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Erreur inconnue",
      });
    }
  }
);

app.get("/public/analysis/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    const result = await pool.query(
      `
        SELECT
          fixture_id,
          fixture_date,
          league_name,
          home_team_name,
          away_team_name,
          decision,
          bet_status,
          confidence,
          risk,
          home_probability,
          draw_probability,
          away_probability,
          value_percentage,
          explanation,
          result_status
        FROM predictions
        WHERE fixture_id = $1
        LIMIT 1
      `,
      [fixtureId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Analyse indisponible",
      });
    }

    const item = result.rows[0];

    return res.json({
      ok: true,

      match: {
        fixtureId: item.fixture_id,
        date: item.fixture_date,
        league: item.league_name,
        homeTeam: item.home_team_name,
        awayTeam: item.away_team_name,
      },

      analysis: {
        decision: item.decision,
        betStatus: item.bet_status,

        probabilities: {
          home: Number(item.home_probability),
          draw: Number(item.draw_probability),
          away: Number(item.away_probability),
        },

        confidence: Number(item.confidence),
        risk: item.risk,
        value: Number(item.value_percentage),
        explanation: item.explanation,
      },

      status: item.result_status,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

   
function computeXgConfidence({
  homeRecentForm,
  awayRecentForm,
  injuries,
  lineups,
}) {
  let score = 0;

  const reasons = [];

  if (
    homeRecentForm.length >= 5 &&
    awayRecentForm.length >= 5
  ) {
    score += 40;
    reasons.push(
      "5 matchs récents disponibles"
    );
  }

  if (
    Array.isArray(lineups) &&
    lineups.length >= 2
  ) {
    score += 30;
    reasons.push(
      "Compositions disponibles"
    );
  }

  if (
    Array.isArray(injuries) &&
    injuries.length <= 4
  ) {
    score += 20;
    reasons.push(
      "Impact des blessures limité"
    );
  }

  score += 10;

  let level = "LOW";

  if (score >= 80) {
    level = "HIGH";
  } else if (score >= 60) {
    level = "MEDIUM";
  }

  return {
    score,
    level,
    reasons,
  };
}

function computeFootballBrainPickScore({
  decision,
  market,
  footballBrain,
}) {
  const confidence =
    Number(decision?.confidence || 0);

  const value =
    Number(decision?.value || 0);

  const phaseOne =
    footballBrain?.context?.phaseOne || {};

  const phaseTwo =
    footballBrain?.context?.phaseTwo || {};

  // 30 points maximum pour la confiance
  const confidencePoints = Math.min(
    30,
    Math.max(0, confidence * 0.3)
  );

  // 25 points maximum pour la value
  let valuePoints = 0;

  if (value >= 15) {
    valuePoints = 25;
  } else if (value >= 10) {
    valuePoints = 20;
  } else if (value >= 5) {
    valuePoints = 15;
  } else if (value >= 3) {
    valuePoints = 8;
  }

  // 15 points si les cotes sont disponibles
  const hasOdds =
    Number.isFinite(
      Number(market?.homeAverageOdd)
    ) ||
    Number.isFinite(
      Number(market?.drawAverageOdd)
    ) ||
    Number.isFinite(
      Number(market?.awayAverageOdd)
    );

  const oddsPoints = hasOdds ? 15 : 0;

  // 10 points selon l’accord avec le marché
  const marketAgreement =
    phaseOne?.marketAgreement?.agrees;

  const marketAgreementPoints =
    marketAgreement === true ? 10 : 5;

  // 10 points pour la qualité des données
  let dataQualityPoints = 0;

  if (
    phaseTwo?.fatigue?.homeRestDays !== null &&
    phaseTwo?.fatigue?.awayRestDays !== null
  ) {
    dataQualityPoints += 4;
  }

  if (
    typeof phaseTwo?.injuries?.homeCount ===
      "number" &&
    typeof phaseTwo?.injuries?.awayCount ===
      "number"
  ) {
    dataQualityPoints += 3;
  }

  if (
    phaseTwo?.lineups?.homeConfirmed &&
    phaseTwo?.lineups?.awayConfirmed
  ) {
    dataQualityPoints += 3;
  }

  // 10 points liés au statut final
  let decisionPoints = 0;

  if (decision?.betStatus === "VALUE_BET") {
    decisionPoints = 10;
  } else if (
    decision?.betStatus === "À_SURVEILLER"
  ) {
    decisionPoints = 5;
  }
const monteCarlo =
  decision?.monteCarlo || {};

let monteCarloPoints = 0;

if (monteCarlo.available) {
  if (monteCarlo.agrees === true) {
    monteCarloPoints = 10;
  } else if (monteCarlo.agrees === false) {
    monteCarloPoints = -5;
  }

  if (
    Number(monteCarlo.probability) >= 70 &&
    monteCarlo.agrees === true
  ) {
    monteCarloPoints = 15;
  }
}
  const rawScore = Math.round(
  confidencePoints +
    valuePoints +
    oddsPoints +
    marketAgreementPoints +
    dataQualityPoints +
    decisionPoints +
    monteCarloPoints
);

const score = Math.max(
  0,
  Math.min(100, rawScore)
);

  let level = "PAS DE PARI";

  if (score >= 90) {
    level = "EXCELLENT";
  } else if (score >= 80) {
    level = "TRÈS FORT";
  } else if (score >= 70) {
    level = "INTÉRESSANT";
  } else if (score >= 60) {
    level = "À SURVEILLER";
  }

  // Sécurité : aucun pari recommandé sans cotes
  if (!hasOdds) {
    level = "DONNÉES INCOMPLÈTES";
  }

  // Sécurité : une value insuffisante reste un NO BET
  if (
    decision?.betStatus === "NO_BET"
  ) {
    level = "PAS DE PARI";
  }

  return {
    score,
    level,

    breakdown: {
      confidence:
        Number(confidencePoints.toFixed(1)),
      value: valuePoints,
      odds: oddsPoints,
      marketAgreement:
        marketAgreementPoints,
      dataQuality:
        dataQualityPoints,
      decision:
        decisionPoints,
    monteCarlo: monteCarloPoints,
},

    hasOdds,
  };
}
function computePoissonModel({
  homeRecentForm,
  awayRecentForm,
  homeTeamId,
  awayTeamId,
}) {
  function computeTeamAverages(matches, teamId) {
    if (!Array.isArray(matches) || matches.length === 0) {
      return {
        goalsForAverage: 1,
        goalsAgainstAverage: 1,
      };
    }

    let goalsForTotal = 0;
    let goalsAgainstTotal = 0;
    let validMatches = 0;

    for (const match of matches) {
      const isHome =
        match.teams?.home?.id === teamId;

      const goalsFor = isHome
        ? match.goals?.home
        : match.goals?.away;

      const goalsAgainst = isHome
        ? match.goals?.away
        : match.goals?.home;

      if (
        !Number.isFinite(goalsFor) ||
        !Number.isFinite(goalsAgainst)
      ) {
        continue;
      }

      goalsForTotal += goalsFor;
      goalsAgainstTotal += goalsAgainst;
      validMatches += 1;
    }

    if (validMatches === 0) {
      return {
        goalsForAverage: 1,
        goalsAgainstAverage: 1,
      };
    }

    return {
      goalsForAverage:
        goalsForTotal / validMatches,

      goalsAgainstAverage:
        goalsAgainstTotal / validMatches,
    };
  }

  const homeAverages =
    computeTeamAverages(
      homeRecentForm,
      homeTeamId
    );

  const awayAverages =
    computeTeamAverages(
      awayRecentForm,
      awayTeamId
    );

  const expectedHomeGoals = Number(
    (
      (
        homeAverages.goalsForAverage +
        awayAverages.goalsAgainstAverage
      ) / 2
    ).toFixed(2)
  );

  const expectedAwayGoals = Number(
    (
      (
        awayAverages.goalsForAverage +
        homeAverages.goalsAgainstAverage
      ) / 2
    ).toFixed(2)
  );

  return {
    expectedGoals: {
      home: Math.max(0.05, expectedHomeGoals),
      away: Math.max(0.05, expectedAwayGoals),
      total: Number(
        (
          expectedHomeGoals +
          expectedAwayGoals
        ).toFixed(2)
      ),
    },

    source: "recent-form-goals",
    quality:
      homeRecentForm.length >= 5 &&
      awayRecentForm.length >= 5
        ? "medium"
        : "low",
  };
}
app.get("/test-fixtures", async (req, res) => {
  try {
    const response = await callApiFootball(
      "/fixtures",
      {
        date: "2026-07-19",
        timezone: "Europe/Paris",
      }
    );

    const fixtures =
      response.data?.response || [];

    res.json({
      ok: true,
      count: fixtures.length,
      fixtures: fixtures.map((item) => ({
        fixtureId: item.fixture?.id,
        date: item.fixture?.date,
        home: item.teams?.home?.name,
        away: item.teams?.away?.name,
        status: item.fixture?.status?.short,
      })),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
  }
});




function getApiKey() {
  const apiKey =
    process.env.API_FOOTBALL_KEY;

  if (!apiKey) {
    throw new Error(
      "API_FOOTBALL_KEY manquante"
    );
  }

  return apiKey.trim();
}

async function callApiFootball(
  endpoint,
  params = {},
  options = {}
) {
  if (!API_FOOTBALL_ENABLED) {
    const error = new Error(
      "API-Football temporairement désactivée par configuration."
    );

    error.code = "API_FOOTBALL_DISABLED";
    error.status = 503;
    error.endpoint = endpoint;
    throw error;
  }

  const forceRefresh = options?.forceRefresh === true;
  const cacheKey = stableApiFootballCacheKey(endpoint, params);
  const cacheTtl = getApiFootballCacheTtl(endpoint, params);

  if (API_FOOTBALL_CACHE_ENABLED && !forceRefresh) {
    const cached = apiFootballResponseCache.get(cacheKey);

    if (cached && Date.now() - cached.createdAt < cacheTtl) {
      return cached.response;
    }
  }

  const task = apiFootballQueue.then(() =>
    executeQueuedApiFootballRequest(endpoint, params)
  );

  apiFootballQueue = task.catch(() => undefined);
  const response = await task;

  if (API_FOOTBALL_CACHE_ENABLED) {
    apiFootballResponseCache.set(cacheKey, {
      createdAt: Date.now(),
      response,
    });
  }

  return response;
}
function isFriendlyFixture(
  fixture = {}
) {
  const leagueName = String(
    fixture?.league?.name ||
    fixture?.league_name ||
    ""
  )
    .trim()
    .toLowerCase();

  return (
    leagueName.includes("friendl") ||
    leagueName.includes("amical")
  );
}

function isFriendlyLeagueName(
  leagueName = ""
) {
  const normalized = String(
    leagueName
  )
    .trim()
    .toLowerCase();

  return (
    normalized.includes("friendl") ||
    normalized.includes("amical")
  );
}
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service:
      "FootballBrain API",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service:
      "FootballBrain API",
    apiKeyConfigured:
      Boolean(
        process.env
          .API_FOOTBALL_KEY
      ),
  });
});

app.get(
  "/timezone",
  async (req, res) => {
    try {
      const response =
        await callApiFootball(
          "/timezone"
        );

      return res.json({
        ok: true,
        httpStatus:
          response.status,
        data:
          response.data,
      });
   

} catch (error) {
  console.error("ERREUR ANALYSE COMPLÈTE :", error);

  return res
    .status(error.response?.status || 500)
    .json({
      ok: false,

      message:
        error.message ||
        "Erreur inconnue",

      code:
        error.code || null,

      status:
        error.response?.status || null,

      endpoint:
        error.config?.url || null,

      apiData:
        error.response?.data || null,

      stack:
        process.env.NODE_ENV === "production"
          ? undefined
          : error.stack,
    });
}

  }
);

app.get(
  "/fixtures",
  async (req, res) => {
    try {
      const date =
        req.query.date;

      if (!date) {
        return res.status(400).json({
          ok: false,
          error:
            "Le paramètre date est obligatoire. Exemple : /fixtures?date=2026-07-22",
        });
      }

      const dateFormat =
        /^\d{4}-\d{2}-\d{2}$/;

      if (
        !dateFormat.test(date)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "La date doit être au format YYYY-MM-DD.",
        });
      }

      const response =
        await callApiFootball(
          "/fixtures",
          {
  date,
  league: 2,
  season: 2026,
  timezone: "Europe/Paris",
}
        );

      const fixtures =
        Array.isArray(
          response.data?.response
        )
          ? response.data.response
          : [];

      const matches =
        fixtures.map((item) => ({
          fixtureId:
            item.fixture?.id,
          date:
            item.fixture?.date,
          timestamp:
            item.fixture
              ?.timestamp,
          status:
            item.fixture?.status,
          venue:
            item.fixture?.venue,

          league: {
            id:
              item.league?.id,
            name:
              item.league?.name,
            country:
              item.league?.country,
            season:
              item.league?.season,
            round:
              item.league?.round,
            logo:
              item.league?.logo,
          },

          homeTeam: {
            id:
              item.teams?.home
                ?.id,
            name:
              item.teams?.home
                ?.name,
            logo:
              item.teams?.home
                ?.logo,
          },

          awayTeam: {
            id:
              item.teams?.away
                ?.id,
            name:
              item.teams?.away
                ?.name,
            logo:
              item.teams?.away
                ?.logo,
          },
        }));

      return res.json({
        ok: true,
        date,
        count:
          matches.length,
        matches,
      });
    } catch (error) {
      return res.status(
        error.response?.status ||
          500
      ).json({
        ok: false,
        error:
          error.response?.data ||
          error.message,
      });
    }
  }
);
app.get("/fixtures-test", async (req, res) => {
  try {
    const response =
      await callApiFootball(
        "/fixtures",
        {
          live: "all",
        }
      );

    res.json(response.data);
  } catch (error) {
    res.json(
      error.response?.data
    );
  }
});
app.get("/leagues", async (req, res) => {
  try {
    const response = await callApiFootball("/leagues");

    res.json({
      count: response.data.response.length,
      data: response.data.response.slice(0, 20),
    });
  } catch (error) {
    res.status(500).json({
      error: error.response?.data || error.message,
    });
  }
});
app.get("/status", async (req, res) => {
  try {
    const response = await callApiFootball(
      "/status"
    );

    return res.json(response.data);
  } catch (error) {
    return res
      .status(error.status || error.response?.status || 500)
      .json({
        ok: false,
        code: error.code || null,
        error:
          error.response?.data ||
          error.message,
      });
  }
});
app.get("/internal/match/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    const response = await callApiFootball("/fixtures", {
      id: fixtureId,
      timezone: "Europe/Paris",
    });

    const apiData = response.data;

    if (
      apiData.errors &&
      Object.keys(apiData.errors).length > 0
    ) {
      return res.status(502).json({
        ok: false,
        error: apiData.errors,
      });
    }

    const item = apiData.response?.[0];

    if (!item) {
      return res.status(404).json({
        ok: false,
        error: "Match introuvable",
      });
    }

    return res.json({
      ok: true,
      match: {
        fixtureId: item.fixture?.id,
        date: item.fixture?.date,
        timestamp: item.fixture?.timestamp,
        status: item.fixture?.status,
        venue: item.fixture?.venue,

        league: {
          id: item.league?.id,
          name: item.league?.name,
          season: item.league?.season,
          round: item.league?.round,
          logo: item.league?.logo,
        },

        homeTeam: {
          id: item.teams?.home?.id,
          name: item.teams?.home?.name,
          logo: item.teams?.home?.logo,
        },

        awayTeam: {
          id: item.teams?.away?.id,
          name: item.teams?.away?.name,
          logo: item.teams?.away?.logo,
        },

        goals: item.goals,
        score: item.score,
      },
    });
  } catch (error) {
    return res.status(error.response?.status || 500).json({
      ok: false,
      error:
        error.response?.data ||
        error.message,
    });
  }
});
app.get("/internal/match/:fixtureId/context", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    const fixtureResponse = await callApiFootball("/fixtures", {
      id: fixtureId,
      timezone: "Europe/Paris",
    });

    const fixture = fixtureResponse.data?.response?.[0];

    if (!fixture) {
      return res.status(404).json({
        ok: false,
        error: "Match introuvable",
      });
    }

    const leagueId = fixture.league?.id;
    const season = fixture.league?.season;
    const homeTeamId = fixture.teams?.home?.id;
    const awayTeamId = fixture.teams?.away?.id;

    const [
  homeStatsResponse,
  awayStatsResponse,
  homeRecentResponse,
  awayRecentResponse,
  h2hResponse,
] = await Promise.all([
      callApiFootball("/teams/statistics", {
        league: leagueId,
        season,
        team: homeTeamId,
      }),

      callApiFootball("/teams/statistics", {
        league: leagueId,
        season,
        team: awayTeamId,
      }),

      callApiFootball("/fixtures", {
        team: homeTeamId,
        last: 5,
        timezone: "Europe/Paris",
      }),

      callApiFootball("/fixtures", {
        team: awayTeamId,
        last: 5,
        timezone: "Europe/Paris",
      }),
    callApiFootball("/fixtures/headtohead", {
  h2h: `${homeTeamId}-${awayTeamId}`,
  last: 10,
  timezone: "Europe/Paris",
}),

      ]);

    function simplifyRecentMatch(item, teamId) {
      const isHome = item.teams?.home?.id === teamId;

      const goalsFor = isHome
        ? item.goals?.home
        : item.goals?.away;

      const goalsAgainst = isHome
        ? item.goals?.away
        : item.goals?.home;

      let result = "D";

      if (goalsFor > goalsAgainst) {
        result = "W";
      } else if (goalsFor < goalsAgainst) {
        result = "L";
      }

      return {
        fixtureId: item.fixture?.id,
        date: item.fixture?.date,
        competition: item.league?.name,
        opponent: isHome
          ? item.teams?.away?.name
          : item.teams?.home?.name,
        location: isHome ? "home" : "away",
        goalsFor,
        goalsAgainst,
        result,
      };
    }

    const homeRecentMatches =
      homeRecentResponse.data?.response || [];

    const awayRecentMatches =
      awayRecentResponse.data?.response || [];
const h2hMatches =
  h2hResponse.data?.response || [];

const headToHead = h2hMatches.map((item) => ({
  fixtureId: item.fixture?.id,
  date: item.fixture?.date,
  competition: item.league?.name,

  homeTeam: {
    id: item.teams?.home?.id,
    name: item.teams?.home?.name,
  },

  awayTeam: {
    id: item.teams?.away?.id,
    name: item.teams?.away?.name,
  },

  goals: {
    home: item.goals?.home,
    away: item.goals?.away,
  },
}));
    return res.json({
      ok: true,

      match: {
        fixtureId,
        date: fixture.fixture?.date,
        league: fixture.league,
        homeTeam: fixture.teams?.home,
        awayTeam: fixture.teams?.away,
      },

      internalContext: {
        homeTeamStatistics:
          homeStatsResponse.data?.response || null,

        awayTeamStatistics:
          awayStatsResponse.data?.response || null,

        homeRecentForm: homeRecentMatches.map((item) =>
          simplifyRecentMatch(item, homeTeamId)
        ),

        awayRecentForm: awayRecentMatches.map((item) =>
          simplifyRecentMatch(item, awayTeamId)
        ),
     headToHead,
 },
    });


} catch (error) {
  console.error("DEBUG CATCH ANALYSE :", error);

  return res.status(error.response?.status || 500).json({
    ok: false,
    debugCatch: "NOUVEAU_CATCH_ACTIF",
    message: error.message || "Erreur inconnue",
    code: error.code || null,
    status: error.response?.status || null,
    endpoint: error.config?.url || null,
    apiData: error.response?.data ?? null,
  });
}

});

function computeFootballBrainScore(
  homeRecent,
  awayRecent
) {
  const scoreMap = {
    W: 3,
    D: 1,
    L: 0,
  };

  const getScore = (matches) =>
    matches.reduce((sum, match) => {
      return sum + scoreMap[match.result];
    }, 0);

  const homeScore = getScore(homeRecent);
  const awayScore = getScore(awayRecent);

  return {
    homeScore,
    awayScore,
    advantage: homeScore - awayScore,
  };
}
        
app.get("/internal/injuries/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    const fixture = await callApiFootball("/fixtures", {
      id: fixtureId,
    });

    const match = fixture.data.response?.[0];

    if (!match) {
      return res.status(404).json({
        ok: false,
        error: "Match introuvable",
      });
    }

    const [home, away] = await Promise.all([
      callApiFootball("/injuries", {
        team: match.teams.home.id,
        season: match.league.season,
      }),
      callApiFootball("/injuries", {
        team: match.teams.away.id,
        season: match.league.season,
      }),
    ]);

    res.json({
      ok: true,
      home: home.data.response,
      away: away.data.response,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/internal/lineups/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    const response = await callApiFootball(
      "/fixtures/lineups",
      {
        fixture: fixtureId,
      }
    );

    res.json({
      ok: true,
      count: response.data.results,
      lineups: response.data.response,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/internal/predictions/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    const fixture = await callApiFootball("/fixtures", {
      id: fixtureId,
    });

    const match = fixture.data.response?.[0];

    const response = await callApiFootball(
      "/predictions",
      {
        fixture: fixtureId,
      }
    );

    res.json({
      ok: true,
      prediction:
        response.data.response?.[0] || null,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

function computeFootballBrainRating({
  footballBrain,
  footballBrainDecision,
  market,
  headToHead,
}) {
  const homeScore = footballBrain?.homeScore || 0;
  const awayScore = footballBrain?.awayScore || 0;
  const totalFormScore = homeScore + awayScore;

  const formScore =
    totalFormScore > 0
      ? Math.round(
          (Math.max(homeScore, awayScore) /
            totalFormScore) *
            100
        )
      : 50;

  const marketScore =
    footballBrainDecision?.selectedOutcome ===
    market?.marketFavorite
      ? 80
      : 45;

  let h2hScore = 50;

  if (Array.isArray(headToHead) && headToHead.length > 0) {
    const draws = headToHead.filter(
      (match) =>
        match.goals?.home === match.goals?.away
    ).length;

    h2hScore = Math.round(
      (draws / headToHead.length) * 100
    );
  }

  const valueScore =
    footballBrainDecision?.value === null
      ? 50
      : Math.max(
          0,
          Math.min(
            100,
            Math.round(
              50 + footballBrainDecision.value * 2
            )
          )
        );

  const confidenceScore =
    footballBrainDecision?.confidence || 50;

  const globalScore = Math.round(
    formScore * 0.3 +
      marketScore * 0.25 +
      h2hScore * 0.15 +
      valueScore * 0.15 +
      confidenceScore * 0.15
  );

  return {
    form: formScore,
    market: marketScore,
    h2h: h2hScore,
    value: valueScore,
    confidence: confidenceScore,
    global: globalScore,
  };
}
function readPredictionHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return [];
    }

    const content = fs.readFileSync(HISTORY_FILE, "utf8");

    return content ? JSON.parse(content) : [];
  } catch (error) {
    console.error("Erreur lecture historique :", error.message);
    return [];
  }
}

function savePredictionHistory(history) {
  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(history, null, 2),
    "utf8"
  );
}

function saveFootballBrainPrediction(analysis) {
  const history = readPredictionHistory();

  const alreadyExists = history.some(
    (item) => item.fixtureId === analysis.fixtureId
  );

  if (alreadyExists) {
    return false;
  }

  history.push({
    fixtureId: analysis.fixtureId,
    createdAt: new Date().toISOString(),

    match: {
      date: analysis.match?.date,
      homeTeam: analysis.match?.homeTeam?.name,
      awayTeam: analysis.match?.awayTeam?.name,
      league: analysis.match?.league?.name,
    },

    prediction: {
      probabilities:
        analysis.footballBrainDecision?.probabilities,

      decision:
        analysis.footballBrainDecision?.decision,

      selectedOutcome:
        analysis.footballBrainDecision?.selectedOutcome,

      confidence:
        analysis.footballBrainDecision?.confidence,

      risk:
        analysis.footballBrainDecision?.risk,

      fairOdd:
        analysis.footballBrainDecision?.fairOdd,

      marketOdd:
        analysis.footballBrainDecision?.marketOdd,

      value:
        analysis.footballBrainDecision?.value,

      betStatus:
        analysis.footballBrainDecision?.betStatus,

      explanation:
        analysis.footballBrainDecision?.explanation,
    },

    result: {
      status: "PENDING",
      homeGoals: null,
      awayGoals: null,
      won: null,
      profit: null,
    },
  });

  savePredictionHistory(history);

  return true;
}
function computeHistoryStats(history) {
  const totalPredictions = history.length;

  const completed = history.filter(
    (item) => item.result?.status === "COMPLETED"
  );

  const noBet = history.filter(
    (item) => item.prediction?.betStatus === "NO_BET"
  ).length;

  const settledBets = completed.filter(
    (item) =>
      item.prediction?.betStatus !== "NO_BET" &&
      typeof item.result?.won === "boolean"
  );

  const wins = settledBets.filter(
    (item) => item.result.won === true
  ).length;

  const losses = settledBets.filter(
    (item) => item.result.won === false
  ).length;

  const totalProfit = settledBets.reduce(
    (sum, item) =>
      sum + Number(item.result?.profit || 0),
    0
  );

  const totalStake = settledBets.length;

  const winRate =
    settledBets.length > 0
      ? Number(
          (
            (wins / settledBets.length) *
            100
          ).toFixed(1)
        )
      : 0;

  const roi =
    totalStake > 0
      ? Number(
          (
            (totalProfit / totalStake) *
            100
          ).toFixed(1)
        )
      : 0;

  const averageConfidence =
    totalPredictions > 0
      ? Number(
          (
            history.reduce(
              (sum, item) =>
                sum +
                Number(
                  item.prediction?.confidence || 0
                ),
              0
            ) / totalPredictions
          ).toFixed(1)
        )
      : 0;

  const decisions = history.reduce(
    (acc, item) => {
      const decision =
        item.prediction?.decision || "Inconnue";

      acc[decision] =
        (acc[decision] || 0) + 1;

      return acc;
    },
    {}
  );

  return {
    totalPredictions,
    completedPredictions: completed.length,
    pendingPredictions:
      totalPredictions - completed.length,
    noBet,
    settledBets: settledBets.length,
    wins,
    losses,
    winRate,
    totalProfit: Number(totalProfit.toFixed(2)),
    roi,
    averageConfidence,
    decisions,
  };
}
app.get("/internal/history", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM predictions
      ORDER BY fixture_date DESC NULLS LAST,
               created_at DESC
    `);

    return res.json({
      ok: true,
      count: result.rows.length,
      history: result.rows,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/internal/stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::INTEGER AS total_predictions,

        COUNT(*) FILTER (
          WHERE result_status = 'COMPLETED'
        )::INTEGER AS completed_predictions,

        COUNT(*) FILTER (
          WHERE result_status = 'PENDING'
        )::INTEGER AS pending_predictions,

        COUNT(*) FILTER (
          WHERE bet_status = 'NO_BET'
        )::INTEGER AS no_bet,

        COUNT(*) FILTER (
          WHERE result_status = 'COMPLETED'
            AND bet_status <> 'NO_BET'
            AND won IS NOT NULL
        )::INTEGER AS settled_bets,

        COUNT(*) FILTER (
          WHERE won = TRUE
        )::INTEGER AS wins,

        COUNT(*) FILTER (
          WHERE won = FALSE
        )::INTEGER AS losses,

        COALESCE(
          SUM(profit) FILTER (
            WHERE result_status = 'COMPLETED'
              AND bet_status <> 'NO_BET'
          ),
          0
        )::NUMERIC AS total_profit,

        COALESCE(
          AVG(confidence),
          0
        )::NUMERIC AS average_confidence
      FROM predictions
    `);

    const row = result.rows[0];

    const settledBets =
      Number(row.settled_bets);

    const wins = Number(row.wins);
    const totalProfit =
      Number(row.total_profit);

    const winRate =
      settledBets > 0
        ? Number(
            (
              (wins / settledBets) *
              100
            ).toFixed(1)
          )
        : 0;

    // Chaque pari réglé représente une mise de 1 unité.
    const roi =
      settledBets > 0
        ? Number(
            (
              (totalProfit / settledBets) *
              100
            ).toFixed(1)
          )
        : 0;

    const decisionsResult =
      await pool.query(`
        SELECT
          decision,
          COUNT(*)::INTEGER AS count
        FROM predictions
        GROUP BY decision
        ORDER BY count DESC
      `);

    const decisions = {};

    for (const item of decisionsResult.rows) {
      decisions[
        item.decision || "Inconnue"
      ] = Number(item.count);
    }

    return res.json({
      ok: true,
      stats: {
        totalPredictions:
          Number(row.total_predictions),
        completedPredictions:
          Number(row.completed_predictions),
        pendingPredictions:
          Number(row.pending_predictions),
        noBet:
          Number(row.no_bet),
        settledBets,
        wins,
        losses:
          Number(row.losses),
        winRate,
        totalProfit:
          Number(totalProfit.toFixed(2)),
        roi,
        averageConfidence:
          Number(
            Number(
              row.average_confidence
            ).toFixed(1)
          ),
        decisions,
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
function computePhaseOneContext({
  match,
  homeResults,
  awayResults,
  market,
  baseScore,
}) {
  // Avantage fixe pour l'équipe à domicile
  const homeAdvantageBonus = 2;

  function countWinningStreak(results) {
    let streak = 0;

    for (const result of results) {
      if (result !== "W") break;
      streak += 1;
    }

    return streak;
  }

  const homeWinningStreak =
    countWinningStreak(homeResults);

  const awayWinningStreak =
    countWinningStreak(awayResults);

  // Bonus limité à 3 points
  const homeStreakBonus =
    Math.min(homeWinningStreak, 3);

  const awayStreakBonus =
    Math.min(awayWinningStreak, 3);

  const leagueName =
    match?.league?.name || "";

  const round =
    match?.league?.round || "";

  let matchImportance = "normale";
  let importanceScore = 1;

  if (
    leagueName.includes("Champions League") ||
    leagueName.includes("Europa League")
  ) {
    matchImportance = "élevée";
    importanceScore = 2;
  }

  if (
    round.includes("Final") ||
    round.includes("Semi") ||
    round.includes("Quarter")
  ) {
    matchImportance = "très élevée";
    importanceScore = 3;
  }

  if (leagueName.includes("Friendlies")) {
    matchImportance = "faible";
    importanceScore = 0;
  }

  const adjustedHomeScore =
    baseScore.homeScore +
    homeAdvantageBonus +
    homeStreakBonus;

  const adjustedAwayScore =
    baseScore.awayScore +
    awayStreakBonus;

  let footballBrainFavorite = "draw";

  if (adjustedHomeScore > adjustedAwayScore) {
    footballBrainFavorite = "home";
  }

  if (adjustedAwayScore > adjustedHomeScore) {
    footballBrainFavorite = "away";
  }

  const marketFavorite =
    market?.marketFavorite || null;

  const marketAgreement =
    marketFavorite !== null &&
    footballBrainFavorite === marketFavorite;

  return {
    adjustedHomeScore,
    adjustedAwayScore,
    adjustedAdvantage:
      adjustedHomeScore - adjustedAwayScore,

    homeAdvantageBonus,

    winningStreaks: {
      home: homeWinningStreak,
      away: awayWinningStreak,
    },

    streakBonuses: {
      home: homeStreakBonus,
      away: awayStreakBonus,
    },

    matchImportance,
    importanceScore,

    marketAgreement: {
      agrees: marketAgreement,
      marketFavorite,
      footballBrainFavorite,
    },
  };
}
function computePhaseTwoContext({
  fixture,
  homeRecentForm,
  awayRecentForm,
  injuries,
  lineups,
}) {
  const homeTeamId = fixture.teams?.home?.id;
  const awayTeamId = fixture.teams?.away?.id;

  const homeInjuries = injuries.filter(
    (item) => item.team?.id === homeTeamId
  );

  const awayInjuries = injuries.filter(
    (item) => item.team?.id === awayTeamId
  );

  function injuryWeight(item) {
    const type = String(item.player?.type || "").toLowerCase();
    const reason = String(
      item.player?.reason || item.player?.type || ""
    ).toLowerCase();

    if (type.includes("suspension")) return 2;

    if (
      reason.includes("knee") ||
      reason.includes("hamstring") ||
      reason.includes("fracture")
    ) {
      return 2;
    }

    return 1;
  }
function getParisDateString() {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  ).format(new Date());
}
  const homeInjuryPenalty = Math.min(
    6,
    homeInjuries.reduce(
      (sum, item) => sum + injuryWeight(item),
      0
    )
  );

  const awayInjuryPenalty = Math.min(
    6,
    awayInjuries.reduce(
      (sum, item) => sum + injuryWeight(item),
      0
    )
  );

  function getRestDays(recentMatches, kickoffDate) {
    const latestFinishedMatch = recentMatches.find(
      (item) =>
        item.fixture?.status?.short === "FT" &&
        item.fixture?.date
    );

    if (!latestFinishedMatch) return null;

    const kickoff = new Date(kickoffDate);
    const previousMatch = new Date(
      latestFinishedMatch.fixture.date
    );

    const difference =
      kickoff.getTime() - previousMatch.getTime();

    return Math.max(
      0,
      Math.floor(difference / (1000 * 60 * 60 * 24))
    );
  }

  const homeRestDays = getRestDays(
    homeRecentForm,
    fixture.fixture?.date
  );

  const awayRestDays = getRestDays(
    awayRecentForm,
    fixture.fixture?.date
  );

  function fatiguePenalty(restDays) {
    if (restDays === null) return 0;
    if (restDays <= 2) return 3;
    if (restDays <= 4) return 2;
    if (restDays <= 6) return 1;
    return 0;
  }

  const homeFatiguePenalty =
    fatiguePenalty(homeRestDays);

  const awayFatiguePenalty =
    fatiguePenalty(awayRestDays);

  const homeLineup = lineups.find(
    (item) => item.team?.id === homeTeamId
  );

  const awayLineup = lineups.find(
    (item) => item.team?.id === awayTeamId
  );

  const homeLineupConfirmed =
    Array.isArray(homeLineup?.startXI) &&
    homeLineup.startXI.length >= 11;

  const awayLineupConfirmed =
    Array.isArray(awayLineup?.startXI) &&
    awayLineup.startXI.length >= 11;

  return {
    injuries: {
      homeCount: homeInjuries.length,
      awayCount: awayInjuries.length,
      homePenalty: homeInjuryPenalty,
      awayPenalty: awayInjuryPenalty,
    },

    fatigue: {
      homeRestDays,
      awayRestDays,
      homePenalty: homeFatiguePenalty,
      awayPenalty: awayFatiguePenalty,
    },

    lineups: {
      homeConfirmed: homeLineupConfirmed,
      awayConfirmed: awayLineupConfirmed,
      homeFormation: homeLineup?.formation || null,
      awayFormation: awayLineup?.formation || null,
    },

    scoreAdjustment: {
      home:
        -homeInjuryPenalty -
        homeFatiguePenalty,

      away:
        -awayInjuryPenalty -
        awayFatiguePenalty,
    },
  };
}
function hasCompleteMonteCarlo(model) {
  return Boolean(
    model &&
      Number(model.simulations) > 0 &&
      Array.isArray(model.topScores) &&
      model.topScores.length > 0 &&
      Number.isFinite(Number(model.btts)) &&
      Number.isFinite(Number(model.over25))
  );
}
app.get("/internal/db-test", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT NOW() AS current_time"
    );

    return res.json({
      ok: true,
      database: "connected",
      time: result.rows[0].current_time,
    });
  } catch (error) {
    console.error("ERREUR DB TEST :", error);

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Erreur inconnue",
      code:
        error.code || null,
      host:
        error.address || null,
      port:
        error.port || null,
    });
  }
});

app.get("/internal/db-init", async (req, res) => {
  try {
    await initializeDatabase();

    return res.json({
      ok: true,
      message: "Tables FootballBrain créées",
      tables: [
        "teams",
        "elo_ratings",
        "elo_history",
        "predictions",
      ],
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

async function upsertTeam(team, country = null) {
  const result = await pool.query(
    `
      INSERT INTO teams (
        api_team_id,
        name,
        country,
        logo,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW())

      ON CONFLICT (api_team_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        country = COALESCE(EXCLUDED.country, teams.country),
        logo = EXCLUDED.logo,
        updated_at = NOW()

      RETURNING *
    `,
    [
      team.id,
      team.name,
      country,
      team.logo || null,
    ]
  );

  return result.rows[0];
}

async function getOrCreateTeamElo(teamDatabaseId) {
  const result = await pool.query(
    `
      INSERT INTO elo_ratings (
        team_id,
        rating,
        matches_played
      )
      VALUES ($1, 1500, 0)

      ON CONFLICT (team_id)
      DO UPDATE SET
        team_id = EXCLUDED.team_id

      RETURNING *
    `,
    [teamDatabaseId]
  );

  return result.rows[0];
}

function calculateExpectedElo(ratingA, ratingB) {
  return 1 / (
    1 + Math.pow(10, (ratingB - ratingA) / 400)
  );
}

function calculateEloResult(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) {
    return {
      homeResult: 1,
      awayResult: 0,
    };
  }

  if (homeGoals < awayGoals) {
    return {
      homeResult: 0,
      awayResult: 1,
    };
  }

  return {
    homeResult: 0.5,
    awayResult: 0.5,
  };
}

async function updateEloFromFinishedFixture(fixture) {
  const status = fixture.fixture?.status?.short;

  if (!["FT", "AET", "PEN"].includes(status)) {
    throw new Error(
      "Le match n'est pas encore terminé"
    );
  }

  const fixtureId = fixture.fixture.id;

  const homeApiTeam = fixture.teams.home;
  const awayApiTeam = fixture.teams.away;

  const homeGoals = fixture.goals?.home;
  const awayGoals = fixture.goals?.away;

  if (
    !Number.isFinite(homeGoals) ||
    !Number.isFinite(awayGoals)
  ) {
    throw new Error(
      "Le score final du match est indisponible"
    );
  }

  const homeTeam = await upsertTeam(
    homeApiTeam,
    fixture.league?.country || null
  );

  const awayTeam = await upsertTeam(
    awayApiTeam,
    fixture.league?.country || null
  );

  const homeElo = await getOrCreateTeamElo(
    homeTeam.id
  );

  const awayElo = await getOrCreateTeamElo(
    awayTeam.id
  );

  const alreadyProcessed = await pool.query(
    `
      SELECT id
      FROM elo_history
      WHERE fixture_id = $1
      LIMIT 1
    `,
    [fixtureId]
  );

  if (alreadyProcessed.rows.length > 0) {
    return {
      alreadyProcessed: true,

      home: {
        team: homeTeam.name,
        rating: Number(homeElo.rating),
      },

      away: {
        team: awayTeam.name,
        rating: Number(awayElo.rating),
      },
    };
  }

  const homeRatingBefore =
    Number(homeElo.rating);

  const awayRatingBefore =
    Number(awayElo.rating);

  const expectedHome = calculateExpectedElo(
    homeRatingBefore + 60,
    awayRatingBefore
  );

  const expectedAway = 1 - expectedHome;

  const {
    homeResult,
    awayResult,
  } = calculateEloResult(
    homeGoals,
    awayGoals
  );

  const K_FACTOR = 32;

  const homeChange = Number(
    (
      K_FACTOR *
      (homeResult - expectedHome)
    ).toFixed(2)
  );

  const awayChange = Number(
    (
      K_FACTOR *
      (awayResult - expectedAway)
    ).toFixed(2)
  );

  const homeRatingAfter = Number(
    (homeRatingBefore + homeChange).toFixed(2)
  );

  const awayRatingAfter = Number(
    (awayRatingBefore + awayChange).toFixed(2)
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        UPDATE elo_ratings
        SET
          rating = $1,
          matches_played = matches_played + 1,
          updated_at = NOW()
        WHERE team_id = $2
      `,
      [
        homeRatingAfter,
        homeTeam.id,
      ]
    );

    await client.query(
      `
        UPDATE elo_ratings
        SET
          rating = $1,
          matches_played = matches_played + 1,
          updated_at = NOW()
        WHERE team_id = $2
      `,
      [
        awayRatingAfter,
        awayTeam.id,
      ]
    );

    await client.query(
      `
        INSERT INTO elo_history (
          team_id,
          fixture_id,
          rating_before,
          rating_after,
          rating_change
        )
        VALUES
          ($1, $2, $3, $4, $5),
          ($6, $2, $7, $8, $9)
      `,
      [
        homeTeam.id,
        fixtureId,
        homeRatingBefore,
        homeRatingAfter,
        homeChange,

        awayTeam.id,
        awayRatingBefore,
        awayRatingAfter,
        awayChange,
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    alreadyProcessed: false,

    fixtureId,

    score: {
      home: homeGoals,
      away: awayGoals,
    },

    home: {
      teamId: homeApiTeam.id,
      team: homeTeam.name,
      ratingBefore: homeRatingBefore,
      ratingAfter: homeRatingAfter,
      change: homeChange,
    },

    away: {
      teamId: awayApiTeam.id,
      team: awayTeam.name,
      ratingBefore: awayRatingBefore,
      ratingAfter: awayRatingAfter,
      change: awayChange,
    },
  };
}
app.get(
  "/internal/elo/process/:fixtureId",
  async (req, res) => {
    try {
      const fixtureId =
        Number(req.params.fixtureId);

      if (
        !Number.isInteger(fixtureId) ||
        fixtureId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "fixtureId invalide",
        });
      }

      const response =
        await callApiFootball(
          "/fixtures",
          {
            id: fixtureId,
            timezone: "Europe/Paris",
          }
        );

      const fixture =
        response.data?.response?.[0];

      if (!fixture) {
        return res.status(404).json({
          ok: false,
          error: "Match introuvable",
        });
      }

      const eloResult =
        await updateEloFromFinishedFixture(
          fixture
        );

      return res.json({
        ok: true,
        elo: eloResult,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
app.get(
  "/internal/team/:apiTeamId",
  async (req, res) => {
    try {
      const apiTeamId =
        Number(req.params.apiTeamId);

      const result = await pool.query(
        `
          SELECT
            t.api_team_id,
            t.name,
            t.country,
            t.logo,
            e.rating,
            e.matches_played,
            e.updated_at
          FROM teams t
          LEFT JOIN elo_ratings e
            ON e.team_id = t.id
          WHERE t.api_team_id = $1
        `,
        [apiTeamId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error:
            "Équipe absente du classement Elo",
        });
      }

      return res.json({
        ok: true,
        team: result.rows[0],
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
app.get(
  "/internal/team/:apiTeamId",
  async (req, res) => {
    try {
      const apiTeamId =
        Number(req.params.apiTeamId);

      const result = await pool.query(
        `
          SELECT
            t.api_team_id,
            t.name,
            t.country,
            t.logo,
            e.rating,
            e.matches_played,
            e.updated_at
          FROM teams t
          LEFT JOIN elo_ratings e
            ON e.team_id = t.id
          WHERE t.api_team_id = $1
        `,
        [apiTeamId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error:
            "Équipe absente du classement Elo",
        });
      }

      return res.json({
        ok: true,
        team: result.rows[0],
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
app.get(
  "/internal/elo-rankings",
  async (req, res) => {
    try {
      const limit = Math.min(
        100,
        Math.max(
          1,
          Number(req.query.limit) || 50
        )
      );

      const result = await pool.query(
        `
          SELECT
            t.api_team_id,
            t.name,
            t.country,
            t.logo,
            e.rating,
            e.matches_played,
            e.updated_at
          FROM elo_ratings e
          JOIN teams t
            ON t.id = e.team_id
          ORDER BY e.rating DESC
          LIMIT $1
        `,
        [limit]
      );

      return res.json({
        ok: true,
        count: result.rows.length,
        rankings: result.rows.map(
          (team, index) => ({
            rank: index + 1,
            ...team,
          })
        ),
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
function normalizeSettlementMarket(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[ÀÁÂÃÄÅ]/g, "A")
    .replace(/[ÈÉÊË]/g, "E")
    .replace(/[ÌÍÎÏ]/g, "I")
    .replace(/[ÒÓÔÕÖ]/g, "O")
    .replace(/[ÙÚÛÜ]/g, "U")
    .replace(/Ç/g, "C")
    .replace(/[\s./-]+/g, "_")
    .replace(/__+/g, "_");
}

function resolveSettlementMarket(
  prediction = {}
) {
  const rawMarket =
    prediction.studio_market_key ||
    prediction.selected_outcome ||
    prediction.decision ||
    "";

  const normalized =
    normalizeSettlementMarket(
      rawMarket
    );

  const aliases = {
    /*
     * 1N2
     */
    "1": "HOME",
    HOME: "HOME",
    HOME_WIN: "HOME",
    DOMICILE: "HOME",
    VICTOIRE_DOMICILE: "HOME",

    X: "DRAW",
    N: "DRAW",
    DRAW: "DRAW",
    MATCH_NUL: "DRAW",

    "2": "AWAY",
    AWAY: "AWAY",
    AWAY_WIN: "AWAY",
    EXTERIEUR: "AWAY",
    VICTOIRE_EXTERIEUR: "AWAY",

    /*
     * Over / Under
     */
    OVER15: "OVER15",
    OVER_15: "OVER15",
    OVER_1_5: "OVER15",
    PLUS_DE_1_5_BUTS: "OVER15",

    UNDER15: "UNDER15",
    UNDER_15: "UNDER15",
    UNDER_1_5: "UNDER15",
    MOINS_DE_1_5_BUTS: "UNDER15",

    OVER25: "OVER25",
    OVER_25: "OVER25",
    OVER_2_5: "OVER25",
    PLUS_DE_2_5_BUTS: "OVER25",

    UNDER25: "UNDER25",
    UNDER_25: "UNDER25",
    UNDER_2_5: "UNDER25",
    MOINS_DE_2_5_BUTS: "UNDER25",

    OVER35: "OVER35",
    OVER_35: "OVER35",
    OVER_3_5: "OVER35",
    PLUS_DE_3_5_BUTS: "OVER35",

    UNDER35: "UNDER35",
    UNDER_35: "UNDER35",
    UNDER_3_5: "UNDER35",
    MOINS_DE_3_5_BUTS: "UNDER35",

    OVER45: "OVER45",
    OVER_45: "OVER45",
    OVER_4_5: "OVER45",
    PLUS_DE_4_5_BUTS: "OVER45",

    UNDER45: "UNDER45",
    UNDER_45: "UNDER45",
    UNDER_4_5: "UNDER45",
    MOINS_DE_4_5_BUTS: "UNDER45",

    /*
     * Les deux équipes marquent
     */
    BTTS: "BTTS_YES",
    BTTS_YES: "BTTS_YES",
    BOTH_TEAMS_TO_SCORE: "BTTS_YES",
    OUI: "BTTS_YES",
    LES_DEUX_EQUIPES_MARQUENT: "BTTS_YES",

    BTTS_NO: "BTTS_NO",
    NO_BTTS: "BTTS_NO",
    NON: "BTTS_NO",
    LES_DEUX_EQUIPES_NE_MARQUENT_PAS:
      "BTTS_NO",

    /*
     * Double chance
     */
    "1X": "1X",
    HOME_OR_DRAW: "1X",
    DOMICILE_OU_NUL: "1X",

    X2: "X2",
    DRAW_OR_AWAY: "X2",
    NUL_OU_EXTERIEUR: "X2",

    "12": "12",
    HOME_OR_AWAY: "12",
    PAS_DE_NUL: "12",

    /*
     * Draw No Bet
     */
    HOME_DNB: "HOME_DNB",
    DNB_HOME: "HOME_DNB",
    DOMICILE_REMBOURSE_SI_NUL:
      "HOME_DNB",

    AWAY_DNB: "AWAY_DNB",
    DNB_AWAY: "AWAY_DNB",
    EXTERIEUR_REMBOURSE_SI_NUL:
      "AWAY_DNB",
  };

  return aliases[normalized] ||
    normalized;
}

function getActualMatchOutcome(
  homeGoals,
  awayGoals
) {
  if (homeGoals > awayGoals) {
    return "HOME";
  }

  if (awayGoals > homeGoals) {
    return "AWAY";
  }

  return "DRAW";
}

function getSettlementProfit({
  outcome,
  marketOdd,
}) {
  if (
    outcome === "NO_BET" ||
    outcome === "PUSH"
  ) {
    return 0;
  }

  if (outcome === "LOSS") {
    return -1;
  }

  const odd =
    Number(marketOdd);

  if (
    !Number.isFinite(odd) ||
    odd <= 1
  ) {
    /*
     * Le résultat sportif est gagné,
     * mais le profit ne peut pas être
     * calculé sans cote exploitable.
     */
    return 0;
  }

  return Number(
    (odd - 1).toFixed(2)
  );
}
function settlePrediction(
  prediction,
  fixture
) {
  const homeGoals =
    Number(fixture.goals?.home);

  const awayGoals =
    Number(fixture.goals?.away);

  if (
    !Number.isFinite(homeGoals) ||
    !Number.isFinite(awayGoals)
  ) {
    throw new Error(
      "Score final indisponible"
    );
  }

  const totalGoals =
    homeGoals + awayGoals;

  const bothTeamsScored =
    homeGoals > 0 &&
    awayGoals > 0;

  const actualOutcome =
    getActualMatchOutcome(
      homeGoals,
      awayGoals
    );

  const market =
    resolveSettlementMarket(
      prediction
    );

  const isNoBet =
    String(
      prediction.bet_status || ""
    ).toUpperCase() === "NO_BET";

  if (isNoBet) {
    return {
      homeGoals,
      awayGoals,
      totalGoals,

      market,
      actualOutcome,

      outcome: "NO_BET",
      won: null,
      profit: 0,

      explanation:
        "Analyse classée NO_BET : aucun pari simulé.",

      settledBy:
        market || "NO_BET",
    };
  }

  let outcome = null;
  let explanation = "";

  switch (market) {
    /*
     * 1N2
     */
    case "HOME":
      outcome =
        actualOutcome === "HOME"
          ? "WIN"
          : "LOSS";

      explanation =
        actualOutcome === "HOME"
          ? `Victoire à domicile confirmée (${homeGoals}-${awayGoals}).`
          : `L'équipe à domicile n'a pas gagné (${homeGoals}-${awayGoals}).`;
      break;

    case "DRAW":
      outcome =
        actualOutcome === "DRAW"
          ? "WIN"
          : "LOSS";

      explanation =
        actualOutcome === "DRAW"
          ? `Match nul confirmé (${homeGoals}-${awayGoals}).`
          : `Le match ne s'est pas terminé sur un nul (${homeGoals}-${awayGoals}).`;
      break;

    case "AWAY":
      outcome =
        actualOutcome === "AWAY"
          ? "WIN"
          : "LOSS";

      explanation =
        actualOutcome === "AWAY"
          ? `Victoire à l'extérieur confirmée (${homeGoals}-${awayGoals}).`
          : `L'équipe à l'extérieur n'a pas gagné (${homeGoals}-${awayGoals}).`;
      break;

    /*
     * Plus de buts
     */
    case "OVER15":
      outcome =
        totalGoals > 1.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "plus" : "pas plus"} de 1,5 but.`;
      break;

    case "OVER25":
      outcome =
        totalGoals > 2.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "plus" : "pas plus"} de 2,5 buts.`;
      break;

    case "OVER35":
      outcome =
        totalGoals > 3.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "plus" : "pas plus"} de 3,5 buts.`;
      break;

    case "OVER45":
      outcome =
        totalGoals > 4.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "plus" : "pas plus"} de 4,5 buts.`;
      break;

    /*
     * Moins de buts
     */
    case "UNDER15":
      outcome =
        totalGoals < 1.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "moins" : "pas moins"} de 1,5 but.`;
      break;

    case "UNDER25":
      outcome =
        totalGoals < 2.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "moins" : "pas moins"} de 2,5 buts.`;
      break;

    case "UNDER35":
      outcome =
        totalGoals < 3.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "moins" : "pas moins"} de 3,5 buts.`;
      break;

    case "UNDER45":
      outcome =
        totalGoals < 4.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "moins" : "pas moins"} de 4,5 buts.`;
      break;

    /*
     * BTTS
     */
    case "BTTS_YES":
      outcome =
        bothTeamsScored
          ? "WIN"
          : "LOSS";

      explanation =
        bothTeamsScored
          ? `Les deux équipes ont marqué (${homeGoals}-${awayGoals}).`
          : `Au moins une équipe n'a pas marqué (${homeGoals}-${awayGoals}).`;
      break;

    case "BTTS_NO":
      outcome =
        !bothTeamsScored
          ? "WIN"
          : "LOSS";

      explanation =
        !bothTeamsScored
          ? `Au moins une équipe n'a pas marqué (${homeGoals}-${awayGoals}).`
          : `Les deux équipes ont marqué (${homeGoals}-${awayGoals}).`;
      break;

    /*
     * Double chance
     */
    case "1X":
      outcome =
        actualOutcome === "HOME" ||
        actualOutcome === "DRAW"
          ? "WIN"
          : "LOSS";

      explanation =
        outcome === "WIN"
          ? `Domicile ou nul validé (${homeGoals}-${awayGoals}).`
          : `Victoire extérieure : double chance 1X perdue (${homeGoals}-${awayGoals}).`;
      break;

    case "X2":
      outcome =
        actualOutcome === "DRAW" ||
        actualOutcome === "AWAY"
          ? "WIN"
          : "LOSS";

      explanation =
        outcome === "WIN"
          ? `Nul ou extérieur validé (${homeGoals}-${awayGoals}).`
          : `Victoire à domicile : double chance X2 perdue (${homeGoals}-${awayGoals}).`;
      break;

    case "12":
      outcome =
        actualOutcome !== "DRAW"
          ? "WIN"
          : "LOSS";

      explanation =
        outcome === "WIN"
          ? `Le match possède un vainqueur (${homeGoals}-${awayGoals}).`
          : `Le match s'est terminé sur un nul (${homeGoals}-${awayGoals}).`;
      break;

    /*
     * Draw No Bet
     */
    case "HOME_DNB":
      if (actualOutcome === "DRAW") {
        outcome = "PUSH";
        explanation =
          `Match nul (${homeGoals}-${awayGoals}) : mise remboursée.`;
      } else if (
        actualOutcome === "HOME"
      ) {
        outcome = "WIN";
        explanation =
          `Victoire à domicile (${homeGoals}-${awayGoals}).`;
      } else {
        outcome = "LOSS";
        explanation =
          `Défaite à domicile (${homeGoals}-${awayGoals}).`;
      }
      break;

    case "AWAY_DNB":
      if (actualOutcome === "DRAW") {
        outcome = "PUSH";
        explanation =
          `Match nul (${homeGoals}-${awayGoals}) : mise remboursée.`;
      } else if (
        actualOutcome === "AWAY"
      ) {
        outcome = "WIN";
        explanation =
          `Victoire à l'extérieur (${homeGoals}-${awayGoals}).`;
      } else {
        outcome = "LOSS";
        explanation =
          `Défaite de l'équipe extérieure (${homeGoals}-${awayGoals}).`;
      }
      break;

    default:
      /*
       * Sécurité :
       * on ne marque jamais automatiquement
       * un marché inconnu comme perdu.
       */
      outcome = "UNSUPPORTED";

      explanation =
        `Marché non pris en charge : ${
          market || "inconnu"
        }.`;
      break;
  }

  const won =
    outcome === "WIN"
      ? true
      : outcome === "LOSS"
      ? false
      : null;

  const profit =
    getSettlementProfit({
      outcome,
      marketOdd:
        prediction.market_odd,
    });

  return {
    homeGoals,
    awayGoals,
    totalGoals,

    market,
    actualOutcome,

    outcome,
    won,
    profit,

    explanation,

    settledBy:
      market,
  };
}
function getApiFootballErrorText(
  value
) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(getApiFootballErrorText)
      .filter(Boolean)
      .join(" ");
  }

  if (typeof value === "object") {
    return Object.values(value)
      .map(getApiFootballErrorText)
      .filter(Boolean)
      .join(" ");
  }

  return String(value);
}

function isApiFootballQuotaMessage(
  value
) {
  const message =
    getApiFootballErrorText(value)
      .toLowerCase();

  return (
    message.includes("request limit") ||
    message.includes("requests limit") ||
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("too many requests") ||
    message.includes("limit for the day") ||
    message.includes("daily limit")
  );
}

function isApiFootballQuotaError(
  error
) {
  if (
    error?.code ===
    "API_FOOTBALL_QUOTA_REACHED"
  ) {
    return true;
  }

  const status =
    error?.response?.status ||
    error?.status ||
    null;

  if (status === 429) {
    return true;
  }

  return isApiFootballQuotaMessage([
    error?.message,
    error?.response?.data,
    error?.response?.data?.errors,
  ]);
}

function createApiFootballQuotaError(
  details
) {
  const error = new Error(
    "Quota API-Football atteint"
  );

  error.code =
    "API_FOOTBALL_QUOTA_REACHED";

  error.details =
    getApiFootballErrorText(details);

  return error;
}
async function updatePendingPredictions(limit = 20) {
  const pendingResult = await pool.query(
    `
      SELECT *
      FROM predictions
      WHERE result_status = 'PENDING'
        AND fixture_date <= NOW()
      ORDER BY fixture_date ASC
      LIMIT $1
    `,
    [limit]
  );

  const summary = {
  checked: 0,
  completed: 0,
  stillPending: 0,
  errors: 0,

  quotaReached: false,
  stoppedEarly: false,
  stopReason: null,

  items: [],
};

  for (const prediction of pendingResult.rows) {
    summary.checked += 1;

    try {
     const response =
  await callApiFootball(
    "/fixtures",
    {
      id:
        prediction.fixture_id,

      timezone:
        "Europe/Paris",
    }
  );

const apiErrors =
  response?.data?.errors;

if (
  apiErrors &&
  Object.keys(apiErrors).length > 0
) {
  if (
    isApiFootballQuotaMessage(
      apiErrors
    )
  ) {
    throw createApiFootballQuotaError(
      apiErrors
    );
  }

  throw new Error(
    `Erreur API-Football : ${
      getApiFootballErrorText(
        apiErrors
      )
    }`
  );
}

const fixture =
  response?.data?.response?.[0];

      if (!fixture) {
        throw new Error("Match introuvable");
      }

      const status =
        fixture.fixture?.status?.short;

      const finishedStatuses = [
        "FT",
        "AET",
        "PEN",
      ];

      if (!finishedStatuses.includes(status)) {
        summary.stillPending += 1;

        summary.items.push({
          fixtureId: prediction.fixture_id,
          status,
          updated: false,
        });

        continue;
      }

      const settlement = settlePrediction(
        prediction,
        fixture
      );
        if (
  settlement.outcome ===
  "UNSUPPORTED"
) {
  summary.errors += 1;

  summary.items.push({
    fixtureId:
      prediction.fixture_id,

    market:
      settlement.market,

    updated: false,

    error:
      settlement.explanation,
  });

  continue;
}

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        await client.query(
          `
            UPDATE predictions
            SET
              result_status = 'COMPLETED',
              home_goals = $1,
              away_goals = $2,
              won = $3,
              profit = $4,
              updated_at = NOW()
            WHERE fixture_id = $5
              AND result_status = 'PENDING'
          `,
          [
            settlement.homeGoals,
            settlement.awayGoals,
            settlement.won,
            settlement.profit,
            prediction.fixture_id,
          ]
        );

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      // Cette fonction possède déjà une protection
      // contre le double traitement d'un même match.
      const elo =
        await updateEloFromFinishedFixture(
          fixture
        );

      summary.completed += 1;

     summary.items.push({
  fixtureId:
    prediction.fixture_id,

  status,

  score: {
    home:
      settlement.homeGoals,

    away:
      settlement.awayGoals,
  },

  totalGoals:
    settlement.totalGoals,

  market:
    settlement.market,

  actualOutcome:
    settlement.actualOutcome,

  settlementOutcome:
    settlement.outcome,

  betStatus:
    prediction.bet_status,

  won:
    settlement.won,

  profit:
    settlement.profit,

  explanation:
    settlement.explanation,

  settledBy:
    settlement.settledBy,

  eloProcessed:
    !elo.alreadyProcessed,

  updated: true,
});
   } catch (error) {
  if (
    isApiFootballQuotaError(
      error
    )
  ) {
    summary.quotaReached = true;
    summary.stoppedEarly = true;
    summary.stopReason =
      "API_FOOTBALL_QUOTA_REACHED";

    summary.items.push({
      fixtureId:
        prediction.fixture_id,

      updated: false,

      error:
        "Quota API-Football atteint. Synchronisation suspendue.",

      details:
        error.details ||
        error.message,
    });

    console.warn(
      [
        "⚠️ Quota API-Football atteint.",
        "Arrêt immédiat de la synchronisation.",
        "Les prédictions restent en PENDING.",
        "Elles seront reprises automatiquement lors de la prochaine exécution disponible.",
      ].join(" ")
    );

    /*
     * Très important :
     * on arrête la boucle pour éviter
     * tous les appels API suivants.
     */
    break;
  }

  summary.errors += 1;

  summary.items.push({
    fixtureId:
      prediction.fixture_id,

    updated: false,

    error:
      error.message,
  });

  console.error(
    `Erreur de règlement du match ${prediction.fixture_id} :`,
    error.message
  );
}
  }

  return summary;
}
app.get(
  "/internal/cron/update-results",
  async (req, res) => {
    const secret = req.query.secret;

if (
  !process.env.INTERNAL_CRON_SECRET ||
  secret !== process.env.INTERNAL_CRON_SECRET
) {
  return res.status(401).json({
    ok: false,
    error: "Accès refusé",
  });
}
try {
      const limit = Math.min(
        50,
        Math.max(
          1,
          Number(req.query.limit) || 20
        )
      );

      const summary =
        await updatePendingPredictions(limit);

      return res.json({
        ok: true,
        summary,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
app.get("/public/analysis/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    const result = await pool.query(
      `
        SELECT
          fixture_id,
          fixture_date,
          league_name,
          home_team_name,
          away_team_name,
          decision,
          bet_status,
          confidence,
          risk,
          home_probability,
          draw_probability,
          away_probability,
          value_percentage,
          explanation,
          result_status
        FROM predictions
        WHERE fixture_id = $1
        LIMIT 1
      `,
      [fixtureId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Analyse indisponible",
      });
    }

    const item = result.rows[0];

    return res.json({
      ok: true,

      match: {
        fixtureId: item.fixture_id,
        date: item.fixture_date,
        league: item.league_name,
        homeTeam: item.home_team_name,
        awayTeam: item.away_team_name,
      },

      analysis: {
        decision: item.decision,
        betStatus: item.bet_status,
        probabilities: {
          home: Number(item.home_probability),
          draw: Number(item.draw_probability),
          away: Number(item.away_probability),
        },
        confidence: Number(item.confidence),
        risk: item.risk,
        value: Number(item.value_percentage),
        explanation: item.explanation,
      },

      status: item.result_status,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/public/analysis/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    const result = await pool.query(
      `
        SELECT
          fixture_id,
          fixture_date,
          league_name,
          home_team_name,
          away_team_name,
          decision,
          bet_status,
          confidence,
          risk,
          home_probability,
          draw_probability,
          away_probability,
          value_percentage,
          explanation,
          result_status
        FROM predictions
        WHERE fixture_id = $1
        LIMIT 1
      `,
      [fixtureId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Analyse indisponible",
      });
    }

    const item = result.rows[0];

    return res.json({
      ok: true,

      match: {
        fixtureId: item.fixture_id,
        date: item.fixture_date,
        league: item.league_name,
        homeTeam: item.home_team_name,
        awayTeam: item.away_team_name,
      },

      analysis: {
        decision: item.decision,
        betStatus: item.bet_status,

        probabilities: {
          home: Number(item.home_probability),
          draw: Number(item.draw_probability),
          away: Number(item.away_probability),
        },

        confidence: Number(item.confidence),
        risk: item.risk,
        value: Number(item.value_percentage),
        explanation: item.explanation,
      },

      status: item.result_status,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get(
  "/internal/cron/analyze-daily",
  async (req, res) => {
    const secret = req.query.secret;

    if (
      !process.env.INTERNAL_CRON_SECRET ||
      secret !== process.env.INTERNAL_CRON_SECRET
    ) {
      return res.status(401).json({
        ok: false,
        error: "Accès refusé",
      });
    }

    try {
      const requestedDate =
        req.query.date ||
        new Date().toISOString().slice(0, 10);

      const dateFormat = /^\d{4}-\d{2}-\d{2}$/;

      if (!dateFormat.test(requestedDate)) {
        return res.status(400).json({
          ok: false,
          error:
            "La date doit être au format YYYY-MM-DD",
        });
      }

      const fixturesResponse =
        await callApiFootball("/fixtures", {
          date: requestedDate,
          timezone: "Europe/Paris",
        });

      const fixtures =
        fixturesResponse.data?.response || [];

      const limit = Math.min(
        20,
        Math.max(
          1,
          Number(req.query.limit) || 10
        )
      );
const priorityLeagueIds = [
  2,   // UEFA Champions League
  3,   // UEFA Europa League
  848, // UEFA Conference League
  39,  // Premier League
  140, // La Liga
  135, // Serie A
  78,  // Bundesliga
  61,  // Ligue 1
  94,  // Primeira Liga
  88,  // Eredivisie
  203, // Süper Lig
  253, // MLS
];
     function getFixturePriorityScore(fixture) {
  const leagueId = fixture.league?.id;
  const round = String(
    fixture.league?.round || ""
  ).toLowerCase();

  let score = 0;

  // Priorité par compétition
  const leaguePriority = {
    2: 100,   // Champions League
    3: 90,    // Europa League
    848: 80,  // Conference League
    39: 75,   // Premier League
    140: 75,  // La Liga
    135: 75,  // Serie A
    78: 75,   // Bundesliga
    61: 75,   // Ligue 1
    94: 65,   // Primeira Liga
    88: 65,   // Eredivisie
    203: 60,  // Süper Lig
    253: 55,  // MLS
  };

  score += leaguePriority[leagueId] || 0;

  // Bonus selon le tour
  if (round.includes("final")) {
    score += 30;
  } else if (round.includes("semi")) {
    score += 25;
  } else if (round.includes("quarter")) {
    score += 20;
  } else if (round.includes("play-off")) {
    score += 15;
  } else if (round.includes("qualifying")) {
    score += 10;
  }

  // Bonus si les équipes sont bien identifiées
  if (
    fixture.teams?.home?.id &&
    fixture.teams?.away?.id
  ) {
    score += 5;
  }

  // Bonus si le stade est connu
  if (fixture.fixture?.venue?.name) {
    score += 2;
  }

  // Bonus si l'heure du match est disponible
  if (fixture.fixture?.date) {
    score += 2;
  }

  return score;
}

const priorityFixtures = fixtures
  .filter((fixture) =>
    priorityLeagueIds.includes(
      fixture.league?.id
    )
  )
  .map((fixture) => ({
    fixture,
    priorityScore:
      getFixturePriorityScore(fixture),
  }))
  .sort(
    (a, b) =>
      b.priorityScore - a.priorityScore
  );

const selectedFixtures =
  priorityFixtures
    .slice(0, limit)
    .map((item) => item.fixture);

      const summary = {
        date: requestedDate,
        fixturesFound: fixtures.length,
        priorityFixturesFound: priorityFixtures.length,
selected: selectedFixtures.length,
        analyzed: 0,
        failed: 0,
        items: [],
      };

      const baseUrl =
        process.env.PUBLIC_API_URL ||
        `http://127.0.0.1:${PORT}`;

      for (const fixture of selectedFixtures) {
        const fixtureId =
          fixture.fixture?.id;

        if (!fixtureId) {
          continue;
        }

        try {
          const response = await axios.get(
            `${baseUrl}/internal/analyze/${fixtureId}`,
            {
              timeout: 120000,
            }
          );

          summary.analyzed += 1;

         

const priorityItem =
  priorityFixtures.find(
    (item) =>
      item.fixture.fixture?.id === fixtureId
  );

const analysis =
  response.data?.analysis || {};

const decision =
  analysis.footballBrainDecision || {};

const market =
  analysis.market || {};
const pickScore =
  analysis.footballBrainPickScore || {};

summary.items.push({
  fixtureId,

  homeTeam:
    fixture.teams?.home?.name,

  awayTeam:
    fixture.teams?.away?.name,

  league:
    fixture.league?.name,

  round:
    fixture.league?.round,

  kickoff:
    fixture.fixture?.date,

  priorityScore:
    priorityItem?.priorityScore || 0,

  hasOdds:
    market.homeAverageOdd !== null &&
    market.homeAverageOdd !== undefined,

  confidence:
    Number(decision.confidence || 0),

  value:
    decision.value === null ||
    decision.value === undefined
      ? -999
      : Number(decision.value),
footballBrainScore:
  Number(pickScore.score || 0),

footballBrainLevel:
  pickScore.level || null,
  decision:
    decision.decision || null,

  success: true,
});
        } catch (error) {
          summary.failed += 1;

          summary.items.push({
            fixtureId,
            homeTeam:
              fixture.teams?.home?.name,
            awayTeam:
              fixture.teams?.away?.name,
            success: false,
            error:
              error.response?.data ||
              error.message,
          });
        }
      }
summary.items.sort((a, b) => {
  if (b.priorityScore !== a.priorityScore) {
    return b.priorityScore - a.priorityScore;
  }

  if (b.hasOdds !== a.hasOdds) {
    return Number(b.hasOdds) - Number(a.hasOdds);
  }
if (
  b.footballBrainScore !==
  a.footballBrainScore
) {
  return (
    b.footballBrainScore -
    a.footballBrainScore
  );
}
  if (b.confidence !== a.confidence) {
    return b.confidence - a.confidence;
  }

  if (b.value !== a.value) {
    return b.value - a.value;
  }

  return new Date(a.kickoff) - new Date(b.kickoff);
});
      return res.json({
        ok: true,
        summary,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error:
          error.response?.data ||
          error.message,
      });
    }
  }
);
function computeFootballBrainPickScore({
  decision,
  market,
  footballBrain,
}) {
  const confidence =
    Number(decision?.confidence || 0);

  const value =
    Number(decision?.value || 0);

  const phaseOne =
    footballBrain?.context?.phaseOne || {};

  const phaseTwo =
    footballBrain?.context?.phaseTwo || {};

  // 30 points maximum pour la confiance
  const confidencePoints = Math.min(
    30,
    Math.max(0, confidence * 0.3)
  );

  // 25 points maximum pour la value
  let valuePoints = 0;

  if (value >= 15) {
    valuePoints = 25;
  } else if (value >= 10) {
    valuePoints = 20;
  } else if (value >= 5) {
    valuePoints = 15;
  } else if (value >= 3) {
    valuePoints = 8;
  }

  // 15 points si les cotes sont disponibles
  const hasOdds =
    Number.isFinite(
      Number(market?.homeAverageOdd)
    ) ||
    Number.isFinite(
      Number(market?.drawAverageOdd)
    ) ||
    Number.isFinite(
      Number(market?.awayAverageOdd)
    );

  const oddsPoints = hasOdds ? 15 : 0;

  // 10 points selon l’accord avec le marché
  const marketAgreement =
    phaseOne?.marketAgreement?.agrees;

  const marketAgreementPoints =
    marketAgreement === true ? 10 : 5;

  // 10 points pour la qualité des données
  let dataQualityPoints = 0;

  if (
    phaseTwo?.fatigue?.homeRestDays !== null &&
    phaseTwo?.fatigue?.awayRestDays !== null
  ) {
    dataQualityPoints += 4;
  }

  if (
    typeof phaseTwo?.injuries?.homeCount ===
      "number" &&
    typeof phaseTwo?.injuries?.awayCount ===
      "number"
  ) {
    dataQualityPoints += 3;
  }

  if (
    phaseTwo?.lineups?.homeConfirmed &&
    phaseTwo?.lineups?.awayConfirmed
  ) {
    dataQualityPoints += 3;
  }

  // 10 points liés au statut final
  let decisionPoints = 0;

  if (decision?.betStatus === "VALUE_BET") {
    decisionPoints = 10;
  } else if (
    decision?.betStatus === "À_SURVEILLER"
  ) {
    decisionPoints = 5;
  }
const monteCarlo =
  decision?.monteCarlo || {};

let monteCarloPoints = 0;

if (monteCarlo.available) {
  if (monteCarlo.agrees === true) {
    monteCarloPoints = 10;
  } else if (monteCarlo.agrees === false) {
    monteCarloPoints = -5;
  }

  if (
    Number(monteCarlo.probability) >= 70 &&
    monteCarlo.agrees === true
  ) {
    monteCarloPoints = 15;
  }
}
  const rawScore = Math.round(
  confidencePoints +
    valuePoints +
    oddsPoints +
    marketAgreementPoints +
    dataQualityPoints +
    decisionPoints +
    monteCarloPoints
);

const score = Math.max(
  0,
  Math.min(100, rawScore)
);

  let level = "PAS DE PARI";

  if (score >= 90) {
    level = "EXCELLENT";
  } else if (score >= 80) {
    level = "TRÈS FORT";
  } else if (score >= 70) {
    level = "INTÉRESSANT";
  } else if (score >= 60) {
    level = "À SURVEILLER";
  }

  // Sécurité : aucun pari recommandé sans cotes
  if (!hasOdds) {
    level = "DONNÉES INCOMPLÈTES";
  }

  // Sécurité : une value insuffisante reste un NO BET
  if (
    decision?.betStatus === "NO_BET"
  ) {
    level = "PAS DE PARI";
  }

  return {
    score,
    level,

    breakdown: {
      confidence:
        Number(confidencePoints.toFixed(1)),
      value: valuePoints,
      odds: oddsPoints,
      marketAgreement:
        marketAgreementPoints,
      dataQuality:
        dataQualityPoints,
      decision:
        decisionPoints,
    monteCarlo: monteCarloPoints,
},

    hasOdds,
  };
}
function computePoissonModel({
  homeRecentForm,
  awayRecentForm,
  homeTeamId,
  awayTeamId,
}) {
  function computeTeamAverages(matches, teamId) {
    if (!Array.isArray(matches) || matches.length === 0) {
      return {
        goalsForAverage: 1,
        goalsAgainstAverage: 1,
      };
    }

    let goalsForTotal = 0;
    let goalsAgainstTotal = 0;
    let validMatches = 0;

    for (const match of matches) {
      const isHome =
        match.teams?.home?.id === teamId;

      const goalsFor = isHome
        ? match.goals?.home
        : match.goals?.away;

      const goalsAgainst = isHome
        ? match.goals?.away
        : match.goals?.home;

      if (
        !Number.isFinite(goalsFor) ||
        !Number.isFinite(goalsAgainst)
      ) {
        continue;
      }

      goalsForTotal += goalsFor;
      goalsAgainstTotal += goalsAgainst;
      validMatches += 1;
    }

    if (validMatches === 0) {
      return {
        goalsForAverage: 1,
        goalsAgainstAverage: 1,
      };
    }

    return {
      goalsForAverage:
        goalsForTotal / validMatches,

      goalsAgainstAverage:
        goalsAgainstTotal / validMatches,
    };
  }

  const homeAverages =
    computeTeamAverages(
      homeRecentForm,
      homeTeamId
    );

  const awayAverages =
    computeTeamAverages(
      awayRecentForm,
      awayTeamId
    );

  const expectedHomeGoals = Number(
    (
      (
        homeAverages.goalsForAverage +
        awayAverages.goalsAgainstAverage
      ) / 2
    ).toFixed(2)
  );

  const expectedAwayGoals = Number(
    (
      (
        awayAverages.goalsForAverage +
        homeAverages.goalsAgainstAverage
      ) / 2
    ).toFixed(2)
  );

  return {
    expectedGoals: {
      home: Math.max(0.05, expectedHomeGoals),
      away: Math.max(0.05, expectedAwayGoals),
      total: Number(
        (
          expectedHomeGoals +
          expectedAwayGoals
        ).toFixed(2)
      ),
    },

    source: "recent-form-goals",
    quality:
      homeRecentForm.length >= 5 &&
      awayRecentForm.length >= 5
        ? "medium"
        : "low",
  };
}
app.get("/test-fixtures", async (req, res) => {
  try {
    const response = await callApiFootball(
      "/fixtures",
      {
        date: "2026-07-19",
        timezone: "Europe/Paris",
      }
    );

    const fixtures =
      response.data?.response || [];

    res.json({
      ok: true,
      count: fixtures.length,
      fixtures: fixtures.map((item) => ({
        fixtureId: item.fixture?.id,
        date: item.fixture?.date,
        home: item.teams?.home?.name,
        away: item.teams?.away?.name,
        status: item.fixture?.status?.short,
      })),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
  }
});
app.get(
  "/internal/prediction/:fixtureId",
  async (req, res) => {
    const result = await pool.query(
      `
      SELECT *
      FROM predictions
      WHERE fixture_id = $1
      `,
      [req.params.fixtureId]
    );

    return res.json({
      ok: true,
      prediction:
        result.rows[0] || null,
    });
  }
);
app.get("/internal/db-columns", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        column_name,
        data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'predictions'
      ORDER BY ordinal_position
    `);

    return res.json({
      ok: true,
      count: result.rows.length,
      columns: result.rows,
    });
  } catch (error) {
    console.error(
      "ERREUR DB COLUMNS :",
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Erreur inconnue",
      code:
        error.code || null,
    });
  }
});
app.get("/internal/db-migrate-xg", async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS official_xg_home NUMERIC(8,3);

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS official_xg_away NUMERIC(8,3);

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS xg_source TEXT;

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS xg_confidence_score NUMERIC(5,2);

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS xg_confidence_level TEXT;

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS form_weight NUMERIC(6,4);

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS market_weight NUMERIC(6,4);

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS monte_carlo_weight NUMERIC(6,4);

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS decision_trace JSONB;

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS model_inputs JSONB;
    `);

    return res.json({
      ok: true,
      message:
        "Migration xG/explicabilité appliquée",
    });
  } catch (error) {
    console.error(
      "ERREUR MIGRATION XG :",
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Erreur inconnue",
      code:
        error.code || null,
    });
  }
});

function buildStoredPredictionExplainability(
  prediction
) {
  const studioPrimaryMarket =
    prediction.studio_snapshot?.primaryMarket ||
    prediction.studio_snapshot?.bestDecision ||
    null;

  const studioMarketKey =
    prediction.studio_market_key ||
    studioPrimaryMarket?.key ||
    null;

  const studioMarketLabel =
    prediction.studio_market_label ||
    studioPrimaryMarket?.label ||
    null;

  const studioProbability =
    prediction.studio_probability ??
    studioPrimaryMarket?.probability ??
    studioPrimaryMarket?.fairOdds?.calibratedProbability ??
    null;

  const studioDecisionScore =
    prediction.studio_decision_score ??
    studioPrimaryMarket?.decision?.score ??
    studioPrimaryMarket?.score ??
    null;

  const studioDecisionType =
    prediction.studio_decision_type ||
    studioPrimaryMarket?.decision?.type ||
    null;

  if (
    studioMarketLabel &&
    studioProbability !== null
  ) {
    const monteCarloMarketKeys =
      new Set([
        "OVER25",
        "UNDER25",
        "BTTS",
      ]);

    return createMarketExplainability({
      marketKey: studioMarketKey,
      marketLabel: studioMarketLabel,
      probability: studioProbability,
      decisionScore: studioDecisionScore,
      decisionGrade:
        prediction.studio_decision_grade ||
        studioPrimaryMarket?.decision?.grade ||
        null,
      decisionType: studioDecisionType,
      confidence: prediction.confidence,
      risk: prediction.risk,
      fairOdd:
        studioPrimaryMarket?.fairOdds?.fairOdds ??
        studioPrimaryMarket?.rawFairOdds ??
        prediction.fair_odd,
      marketOdd:
        studioPrimaryMarket?.fairOdds?.bookmakerOdds ??
        studioPrimaryMarket?.bookmakerOdds ??
        prediction.market_odd,
      value:
        studioPrimaryMarket?.fairOdds?.valueEdge ??
        studioPrimaryMarket?.valueEdge ??
        prediction.value_percentage,
      monteCarloAvailable:
        monteCarloMarketKeys.has(
          String(studioMarketKey || "").toUpperCase()
        ) ||
        Boolean(
          prediction.monte_carlo_model?.simulations
        ),
    });
  }

  const probabilities = {
    home:
      Number(
        prediction.home_probability
      ) || 0,

    draw:
      Number(
        prediction.draw_probability
      ) || 0,

    away:
      Number(
        prediction.away_probability
      ) || 0,
  };

  const selectedOutcome =
    String(
      prediction.selected_outcome ||
      Object.entries(probabilities)
        .sort(
          (a, b) =>
            b[1] - a[1]
        )[0]?.[0] ||
      "home"
    ).toLowerCase();

  const selectedProbability =
    probabilities[selectedOutcome] || 0;

  const sortedProbabilities =
    Object.values(probabilities)
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => b - a);

  const probabilityGap =
    sortedProbabilities.length >= 2
      ? Number(
          (
            sortedProbabilities[0] -
            sortedProbabilities[1]
          ).toFixed(2)
        )
      : 0;

  const modelInputs =
    prediction.model_inputs || {};

  const monteCarloInputs =
    modelInputs.monteCarlo ||
    modelInputs.monte_carlo ||
    {};

  const monteCarloEntries =
    Object.entries({
      home:
        Number(
          monteCarloInputs.home
        ) || 0,

      draw:
        Number(
          monteCarloInputs.draw
        ) || 0,

      away:
        Number(
          monteCarloInputs.away
        ) || 0,
    }).sort(
      (a, b) =>
        b[1] - a[1]
    );

  const monteCarloFavorite =
    monteCarloEntries[0]?.[0] ||
    null;

  const monteCarloProbability =
    monteCarloEntries[0]?.[1] ||
    null;

  const hasMonteCarlo =
    monteCarloEntries.some(
      ([, value]) =>
        Number(value) > 0
    );

  return createDecisionExplainability({
    selectedOutcome,
    selectedProbability,
    probabilities,

    weights: {
      form:
        Number(
          prediction.form_weight
        ) || 0,

      market:
        Number(
          prediction.market_weight
        ) || 0,

      monteCarlo:
        Number(
          prediction.monte_carlo_weight
        ) || 0,
    },

    modelInputs,

    monteCarlo: {
      available:
        hasMonteCarlo,

      favorite:
        monteCarloFavorite,

      probability:
        monteCarloProbability,

      agrees:
        monteCarloFavorite ===
        selectedOutcome,
    },

    confidence:
      Number(
        prediction.confidence
      ) || 0,

    risk:
      prediction.risk,

    fairOdd:
      prediction.fair_odd !== null
        ? Number(
            prediction.fair_odd
          )
        : null,

    marketOdd:
      prediction.market_odd !== null
        ? Number(
            prediction.market_odd
          )
        : null,

    value:
      prediction.value_percentage !==
      null
        ? Number(
            prediction.value_percentage
          )
        : null,

    betStatus:
      prediction.bet_status,

    probabilityGap,
  });
}

app.get(
  "/public/ai-lab/:fixtureId",
  async (req, res) => {
    try {
      const fixtureId = Number(
        req.params.fixtureId
      );

      if (
        !Number.isInteger(fixtureId) ||
        fixtureId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "fixtureId invalide",
        });
      }

      const result = await pool.query(
        `
          SELECT
            fixture_id,
            fixture_date,
            league_id,
            league_name,

            home_team_id,
            home_team_name,
            away_team_id,
            away_team_name,

            decision,
            selected_outcome,
            bet_status,
            confidence,
            risk,

            home_probability,
            draw_probability,
            away_probability,

            fair_odd,
            market_odd,
            value_percentage,

            official_xg_home,
            official_xg_away,
            xg_source,

            xg_confidence_score,
            xg_confidence_level,

            form_weight,
            market_weight,
            monte_carlo_weight,

            decision_trace,
            model_inputs,
            monte_carlo_model,
            analysis_context,
            explanation,

            studio_market_key,
            studio_market_label,
            studio_probability,
            studio_decision_score,
            studio_decision_type,
            studio_decision_grade,
            studio_analysis_version,
            studio_snapshot,
            studio_saved_at,

            updated_at
          FROM predictions
          WHERE fixture_id = $1
          LIMIT 1
        `,
        [fixtureId]
      );

      const prediction =
        result.rows[0];

      if (!prediction) {
        return res.status(404).json({
          ok: false,
          error:
            "Analyse AI Lab introuvable",
        });
      }
if (
  isFriendlyLeagueName(
    prediction.league_name
  )
) {
  return res.status(404).json({
    ok: false,
    skipped: true,
    reason:
      "FRIENDLY_MATCH_EXCLUDED",
    error:
      "Cette analyse amicale est exclue de FootballBrain.",
  });
}
      return res.json({
        ok: true,

        fixtureId:
          prediction.fixture_id,

        match: {
          date:
            prediction.fixture_date,

          league: {
            id:
              prediction.league_id,
            name:
              prediction.league_name,
          },

          homeTeam: {
            id:
              prediction.home_team_id,
            name:
              prediction.home_team_name,
          },

          awayTeam: {
            id:
              prediction.away_team_id,
            name:
              prediction.away_team_name,
          },
        },

        prediction: {
          decision:
            prediction.decision,

          selectedOutcome:
            prediction.selected_outcome,

          betStatus:
            prediction.bet_status,

          confidence:
            Number(
              prediction.confidence
            ),

          risk:
            prediction.risk,

          probabilities: {
            home:
              Number(
                prediction.home_probability
              ),

            draw:
              Number(
                prediction.draw_probability
              ),

            away:
              Number(
                prediction.away_probability
              ),
          },

          fairOdd:
            prediction.fair_odd !== null
              ? Number(
                  prediction.fair_odd
                )
              : null,

          marketOdd:
            prediction.market_odd !== null
              ? Number(
                  prediction.market_odd
                )
              : null,

          value:
            prediction.value_percentage !==
            null
              ? Number(
                  prediction.value_percentage
                )
              : null,

          explanation:
            prediction.explanation,

          explainability:
            buildStoredPredictionExplainability(
              prediction
            ),
        },

        xg: {
          home:
            prediction.official_xg_home !==
            null
              ? Number(
                  prediction.official_xg_home
                )
              : null,

          away:
            prediction.official_xg_away !==
            null
              ? Number(
                  prediction.official_xg_away
                )
              : null,

          total:
            prediction.official_xg_home !==
              null &&
            prediction.official_xg_away !==
              null
              ? Number(
                  (
                    Number(
                      prediction
                        .official_xg_home
                    ) +
                    Number(
                      prediction
                        .official_xg_away
                    )
                  ).toFixed(3)
                )
              : null,

          source:
            prediction.xg_source,

          confidence: {
            score:
              prediction
                .xg_confidence_score !==
              null
                ? Number(
                    prediction
                      .xg_confidence_score
                  )
                : null,

            level:
              prediction
                .xg_confidence_level,
          },
        },

        weights: {
          form:
            prediction.form_weight !==
            null
              ? Number(
                  prediction.form_weight
                )
              : null,

          market:
            prediction.market_weight !==
            null
              ? Number(
                  prediction.market_weight
                )
              : null,

          monteCarlo:
            prediction
              .monte_carlo_weight !== null
              ? Number(
                  prediction
                    .monte_carlo_weight
                )
              : null,
        },

        modelInputs:
          prediction.model_inputs || {},
monteCarloModel:
  prediction.monte_carlo_model || null,
    context:
  prediction.analysis_context ||
  null,
    context:
  prediction.analysis_context ||
  {},
        decisionTrace:
          Array.isArray(
            prediction.decision_trace
          )
            ? prediction.decision_trace
            : [],

        updatedAt:
          prediction.updated_at,
      });
    } catch (error) {
      console.error(
        "ERREUR PUBLIC AI LAB :",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur inconnue",
      });
    }
  }
);
app.get(
  "/internal/db-migrate-montecarlo",
  async (req, res) => {
    try {
      await pool.query(`
        ALTER TABLE predictions
        ADD COLUMN IF NOT EXISTS
        monte_carlo_model JSONB;
      `);

      return res.json({
        ok: true,
        message:
          "Colonne monte_carlo_model créée",
      });
    } catch (error) {
      console.error(
        "ERREUR MIGRATION MONTE CARLO :",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur inconnue",
      });
    }
  }
);
app.get(
  "/public/daily-picks",
  async (req, res) => {
    try {
      const requestedDate =
        String(req.query.date || "").trim();

      const date =
        requestedDate || getParisDateString();

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Date invalide. Format attendu : YYYY-MM-DD",
        });
      }
const enabledLeagueIds =
  await getEnabledLeagueIds();

if (enabledLeagueIds.size === 0) {
  return res.json({
    ok: true,
    date,

    summary: {
      fixturesFromApi: 0,
      fixtures: 0,
      analyzed: 0,
      pending: 0,
      enabledLeagues: 0,
    },

    matches: [],

    warning:
      "Aucune compétition n'est activée dans le League Manager.",
  });
}
      const fixturesResponse =
  await callApiFootball(
    "/fixtures",
    {
      date,
      timezone: "Europe/Paris",
    }
  );

const rawFixtures =
  fixturesResponse.data?.response || [];

const fixtures = rawFixtures
  .filter((item) => {
    const fixtureId =
      Number(item?.fixture?.id);

    const homeName =
      item?.teams?.home?.name;

    const awayName =
      item?.teams?.away?.name;

   return (
  Number.isInteger(fixtureId) &&
  fixtureId > 0 &&
  Boolean(homeName) &&
  Boolean(awayName) &&
  isLeagueEnabled(
    item,
    enabledLeagueIds
  ) &&
  !isExcludedFixture(item)
);
  })
  .sort((a, b) =>
    String(
      a?.fixture?.date || ""
    ).localeCompare(
      String(
        b?.fixture?.date || ""
      )
    )
  );
       
      const fixtureIds = fixtures.map(
        (item) =>
          Number(item.fixture.id)
      );

      let predictionRows = [];

      if (fixtureIds.length > 0) {
        const predictionsResult =
          await pool.query(
            `
              SELECT
                fixture_id,
                decision,
                selected_outcome,
                bet_status,
                confidence,
                risk,
                home_probability,
                draw_probability,
                away_probability,
                fair_odd,
                market_odd,
                value_percentage,
                explanation,
                official_xg_home,
                official_xg_away,
                xg_source,
                xg_confidence_score,
                xg_confidence_level,
                form_weight,
                market_weight,
                monte_carlo_weight,
                decision_trace,
                model_inputs,
                monte_carlo_model,
                updated_at
              FROM predictions
              WHERE fixture_id =
                ANY($1::bigint[])
            `,
            [fixtureIds]
          );

        predictionRows =
          predictionsResult.rows;
      }

      const predictionsByFixture =
        new Map(
          predictionRows.map(
            (prediction) => [
              Number(
                prediction.fixture_id
              ),
              prediction,
            ]
          )
        );

      const matches = fixtures.map(
        (item) => {
          const fixtureId =
            Number(item.fixture.id);

          const prediction =
            predictionsByFixture.get(
              fixtureId
            );

          return {
            fixtureId,
            fixture_id: fixtureId,

            date:
              item.fixture?.date || null,

            timestamp:
              item.fixture?.timestamp ||
              null,

            status: {
              long:
                item.fixture?.status
                  ?.long || null,
              short:
                item.fixture?.status
                  ?.short || null,
              elapsed:
                item.fixture?.status
                  ?.elapsed ?? null,
            },

            league: {
              id:
                item.league?.id || null,
              name:
                item.league?.name || null,
              country:
                item.league?.country ||
                null,
              logo:
                item.league?.logo || null,
              season:
                item.league?.season ||
                null,
              round:
                item.league?.round ||
                null,
            },

            homeTeam: {
              id:
                item.teams?.home?.id ||
                null,
              name:
                item.teams?.home?.name ||
                "Domicile",
              logo:
                item.teams?.home?.logo ||
                null,
            },

            awayTeam: {
              id:
                item.teams?.away?.id ||
                null,
              name:
                item.teams?.away?.name ||
                "Extérieur",
              logo:
                item.teams?.away?.logo ||
                null,
            },

            goals: {
              home:
                item.goals?.home ?? null,
              away:
                item.goals?.away ?? null,
            },

            analysisAvailable:
              Boolean(prediction),

            prediction: prediction
              ? {
                  decision:
                    prediction.decision,

                  selectedOutcome:
                    prediction.selected_outcome,

                  betStatus:
                    prediction.bet_status,

                  confidence:
                    Number(
                      prediction.confidence
                    ),

                  risk:
                    prediction.risk,

                  probabilities: {
                    home: Number(
                      prediction.home_probability
                    ),
                    draw: Number(
                      prediction.draw_probability
                    ),
                    away: Number(
                      prediction.away_probability
                    ),
                  },

                  fairOdd:
                    prediction.fair_odd ==
                    null
                      ? null
                      : Number(
                          prediction.fair_odd
                        ),

                  marketOdd:
                    prediction.market_odd ==
                    null
                      ? null
                      : Number(
                          prediction.market_odd
                        ),

                  value:
                    prediction.value_percentage ==
                    null
                      ? null
                      : Number(
                          prediction.value_percentage
                        ),

                  explanation:
                    prediction.explanation,
                }
              : null,

            xg: prediction
              ? {
                  home:
                    prediction.official_xg_home ==
                    null
                      ? null
                      : Number(
                          prediction.official_xg_home
                        ),

                  away:
                    prediction.official_xg_away ==
                    null
                      ? null
                      : Number(
                          prediction.official_xg_away
                        ),

                  source:
                    prediction.xg_source,

                  confidence: {
                    score:
                      prediction.xg_confidence_score ==
                      null
                        ? null
                        : Number(
                            prediction.xg_confidence_score
                          ),

                    level:
                      prediction.xg_confidence_level,
                  },
                }
              : null,

            weights: prediction
              ? {
                  form:
                    prediction.form_weight ==
                    null
                      ? null
                      : Number(
                          prediction.form_weight
                        ),

                  market:
                    prediction.market_weight ==
                    null
                      ? null
                      : Number(
                          prediction.market_weight
                        ),

                  monteCarlo:
                    prediction.monte_carlo_weight ==
                    null
                      ? null
                      : Number(
                          prediction.monte_carlo_weight
                        ),
                }
              : null,

            monteCarloModel:
              prediction?.monte_carlo_model ||
              null,

            decisionTrace:
              Array.isArray(
                prediction?.decision_trace
              )
                ? prediction.decision_trace
                : [],

            updatedAt:
              prediction?.updated_at ||
              null,
          };
        }
      );

      const analyzedMatches =
        matches.filter(
          (match) =>
            match.analysisAvailable
        );

      return res.json({
        ok: true,
        date,

        summary: {
  fixturesFromApi:
    rawFixtures.length,

  fixtures:
    matches.length,

  analyzed:
    analyzedMatches.length,

  pending:
    matches.length -
    analyzedMatches.length,

  enabledLeagues:
    enabledLeagueIds.size,

  excludedByLeagueManager:
    Math.max(
      0,
      rawFixtures.length -
        matches.length
    ),
},

        matches,
      });
    } catch (error) {
      console.error(
        "ERREUR /public/daily-picks :",
        error
      );

            return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur inconnue",
      });
     }
  }
);
                      function getParisDateString() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function hasCompleteMonteCarlo(model) {
  return Boolean(
    model &&
      Number(model.simulations) > 0 &&
      Array.isArray(model.topScores) &&
      model.topScores.length > 0 &&
      Number.isFinite(Number(model.btts)) &&
      Number.isFinite(Number(model.over25))
  );
}

app.get(
  "/internal/rebuild-daily-analysis",
  async (req, res) => {
    try {
      const requestedDate = String(
        req.query.date || ""
      ).trim();

      const date =
        requestedDate ||
        getParisDateString();

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Date invalide. Format attendu : YYYY-MM-DD",
        });
      }

      const requestedLimit = Number(
        req.query.limit
      );

      /*
       * Lots courts : une analyse complète déclenche plusieurs appels
       * API-Football. On limite volontairement chaque passage afin
       * d'éviter les requêtes HTTP internes trop longues et les 429.
       */
      const limit = Math.min(
        20,
        Math.max(
          1,
          Number.isInteger(requestedLimit)
            ? requestedLimit
            : 8
        )
      );

      const force =
        String(req.query.force || "") ===
        "1";

      const enabledLeagueIds =
        await getEnabledLeagueIds();

      if (enabledLeagueIds.size === 0) {
        return res.json({
          ok: true,
          date,
          force,
          summary: {
            fixturesFromApi: 0,
            fixturesFound: 0,
            alreadyComplete: 0,
            rebuilt: 0,
            failed: 0,
            remaining: 0,
            enabledLeagues: 0,
          },
          alreadyComplete: [],
          results: [],
          warning:
            "Aucune compétition n'est activée dans le League Manager.",
        });
      }

      /*
       * 1. Récupérer les fixtures du jour
       */
      const fixturesResponse =
        await callApiFootball(
          "/fixtures",
          {
            date,
            timezone: "Europe/Paris",
          }
        );

      const rawFixtures =
        fixturesResponse.data?.response ||
        [];

      const excludedStatuses = [
        "FT",
        "AET",
        "PEN",
        "CANC",
        "PST",
        "ABD",
        "AWD",
        "WO",
      ];

      const fixtures = rawFixtures
  .filter((item) => {
    const fixtureId = Number(
      item?.fixture?.id
    );

    const status = String(
      item?.fixture?.status?.short ||
        ""
    ).toUpperCase();

    return (
  Number.isInteger(fixtureId) &&
  fixtureId > 0 &&
  item?.teams?.home?.name &&
  item?.teams?.away?.name &&
  isLeagueEnabled(
    item,
    enabledLeagueIds
  ) &&
  !excludedStatuses.includes(
    status
  ) &&
  !isExcludedFixture(item)
);
  });
        

      if (fixtures.length === 0) {
        return res.json({
          ok: true,
          date,
          summary: {
            fixturesFromApi:
              rawFixtures.length,
            fixturesFound: 0,
            alreadyComplete: 0,
            rebuilt: 0,
            failed: 0,
            remaining: 0,
            enabledLeagues:
              enabledLeagueIds.size,
          },
          results: [],
        });
      }

      const fixtureIds = fixtures.map(
        (item) =>
          Number(item.fixture.id)
      );

      /*
       * 2. Lire les analyses existantes
       */
      const existingResult =
        await pool.query(
          `
            SELECT
              fixture_id,
              monte_carlo_model
            FROM predictions
            WHERE fixture_id =
              ANY($1::bigint[])
          `,
          [fixtureIds]
        );

      const existingByFixture =
        new Map(
          existingResult.rows.map(
            (row) => [
              Number(row.fixture_id),
              row.monte_carlo_model,
            ]
          )
        );

      const alreadyComplete = [];
      const fixturesToRebuild = [];

      for (const fixture of fixtures) {
        const fixtureId = Number(
          fixture.fixture.id
        );

        const storedMonteCarlo =
          existingByFixture.get(
            fixtureId
          );

        if (
          !force &&
          hasCompleteMonteCarlo(
            storedMonteCarlo
          )
        ) {
          alreadyComplete.push({
            fixtureId,
            homeTeam:
              fixture.teams.home.name,
            awayTeam:
              fixture.teams.away.name,
          });
        } else {
          fixturesToRebuild.push(
            fixture
          );
        }
      }
const selectedFixturesToRebuild =
  fixturesToRebuild.slice(0, limit);
      /*
       * 3. Relancer l’analyse complète
       */
      const baseUrl =
        `${req.protocol}://${req.get(
          "host"
        )}`;

      const results = [];

      for (
  const fixture of
    selectedFixturesToRebuild
) {
        const fixtureId = Number(
          fixture.fixture.id
        );

        const homeTeam =
          fixture.teams.home.name;

        const awayTeam =
          fixture.teams.away.name;

        try {
          const analysisUrl =
  `${baseUrl}/internal/analyze/${fixtureId}` +
  `${force ? "?refresh=1" : ""}`;

// Petite respiration entre deux analyses ; la file API centrale
// impose déjà son propre intervalle entre chaque requête externe.
await wait(500);

const response = await fetch(
  analysisUrl,
  {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  }
);
          const data =
            await response.json();

          if (
            !response.ok ||
            !data?.ok
          ) {
            throw new Error(
              data?.message ||
                data?.error ||
                "Analyse impossible"
            );
          }

          const monteCarloModel =
            data?.analysis
              ?.monteCarloModel ||
            null;

          const complete =
            hasCompleteMonteCarlo(
              monteCarloModel
            );

          if (!complete) {
            throw new Error(
              "L’analyse a réussi, mais le Monte Carlo complet est absent."
            );
          }

          results.push({
            fixtureId,
            homeTeam,
            awayTeam,
            ok: true,
            simulations:
              monteCarloModel
                .simulations,
            btts:
              monteCarloModel.btts,
            over25:
              monteCarloModel.over25,
            topScores:
              monteCarloModel.topScores,
          });
        } catch (error) {
          results.push({
            fixtureId,
            homeTeam,
            awayTeam,
            ok: false,
            error:
              error.message ||
              "Erreur inconnue",
          });
        }
      }

      const rebuilt =
        results.filter(
          (item) => item.ok
        );

      const failed =
        results.filter(
          (item) => !item.ok
        );

      return res.json({
        ok: true,
        date,
        force,

        summary: {
          fixturesFromApi:
            rawFixtures.length,
          fixturesFound:
            fixtures.length,
          alreadyComplete:
            alreadyComplete.length,
          selectedForBatch:
            selectedFixturesToRebuild.length,
          rebuilt:
            rebuilt.length,
          failed:
            failed.length,
          remaining:
            Math.max(
              0,
              fixturesToRebuild.length -
                rebuilt.length
            ),
          enabledLeagues:
            enabledLeagueIds.size,
        },

        alreadyComplete,
        results,
      });
    } catch (error) {
      console.error(
        "ERREUR REBUILD DAILY ANALYSIS :",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur inconnue",
      });
    }
  }
);
let dailyAnalysisJobRunning = false;

async function runAutomaticDailyAnalysis({
  date = getParisDateString(),
} = {}) {
  if (dailyAnalysisJobRunning) {
    console.log(
      "ANALYSE QUOTIDIENNE : tâche déjà en cours"
    );

    return {
      ok: true,
      skipped: true,
      reason: "ALREADY_RUNNING",
    };
  }

  dailyAnalysisJobRunning = true;

  try {
    const url =
      `http://127.0.0.1:${PORT}` +
      `/internal/rebuild-daily-analysis` +
      `?date=${encodeURIComponent(date)}` +
      `&limit=8`;

    console.log(
      `ANALYSE QUOTIDIENNE : démarrage ${date}`
    );

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    const data = await response.json();

    if (!response.ok || !data?.ok) {
      throw new Error(
        data?.error ||
          "Échec de l’analyse automatique"
      );
    }

    console.log(
      "ANALYSE QUOTIDIENNE : terminée",
      data.summary
    );

    return data;
  } catch (error) {
    console.error(
      "ERREUR ANALYSE QUOTIDIENNE :",
      error.message
    );

    throw error;
  } finally {
    dailyAnalysisJobRunning = false;
  }
}
app.get(
  "/internal/daily-analysis-status",
  async (req, res) => {
    try {
      const requestedDate = String(
        req.query.date || ""
      ).trim();

      const date =
        requestedDate ||
        getParisDateString();

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({
          ok: false,
          error:
            "Date invalide. Format attendu : YYYY-MM-DD",
        });
      }

      const result = await pool.query(
        `
          SELECT
            fixture_id,
            home_team_name,
            away_team_name,

            official_xg_home,
            official_xg_away,

            monte_carlo_model,
            decision_trace,
            model_inputs,
            updated_at

          FROM predictions

          WHERE
            fixture_date >=
              $1::date

            AND fixture_date <
              $1::date +
              INTERVAL '1 day'

          ORDER BY fixture_date ASC
        `,
        [date]
      );

      const matches = result.rows.map(
        (row) => {
          const monteCarlo =
            row.monte_carlo_model;

          const hasXg =
            row.official_xg_home !== null &&
            row.official_xg_away !== null;

          const hasMonteCarlo =
            hasCompleteMonteCarlo(
              monteCarlo
            );

          const hasDecisionTrace =
            Array.isArray(
              row.decision_trace
            ) &&
            row.decision_trace.length > 0;

          const hasModelInputs =
            row.model_inputs &&
            typeof row.model_inputs ===
              "object" &&
            Object.keys(row.model_inputs)
              .length > 0;

          const complete =
            hasXg &&
            hasMonteCarlo &&
            hasDecisionTrace &&
            hasModelInputs;

          return {
            fixtureId:
              Number(row.fixture_id),

            homeTeam:
              row.home_team_name,

            awayTeam:
              row.away_team_name,

            complete,
            hasXg,
            hasMonteCarlo,
            hasDecisionTrace,
            hasModelInputs,

            simulations:
              Number(
                monteCarlo?.simulations
              ) || 0,

            updatedAt:
              row.updated_at,
          };
        }
      );

      const complete =
        matches.filter(
          (match) => match.complete
        );

      const incomplete =
        matches.filter(
          (match) => !match.complete
        );

      return res.json({
        ok: true,
        date,

        summary: {
          stored:
            matches.length,

          complete:
            complete.length,

          incomplete:
            incomplete.length,

          withXg:
            matches.filter(
              (match) => match.hasXg
            ).length,

          withMonteCarlo:
            matches.filter(
              (match) =>
                match.hasMonteCarlo
            ).length,

          with10000Simulations:
            matches.filter(
              (match) =>
                match.simulations ===
                10000
            ).length,
        },

        incomplete,
      });
    } catch (error) {
      console.error(
        "ERREUR DAILY ANALYSIS STATUS :",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur inconnue",
      });
    }
  }
);
app.get(
  "/internal/migrate-analysis-context",
  async (req, res) => {
    try {
      await pool.query(`
        ALTER TABLE predictions
        ADD COLUMN IF NOT EXISTS
          analysis_context JSONB;
      `);

      return res.json({
        ok: true,
        message:
          "Colonne analysis_context créée",
      });
    } catch (error) {
      console.error(
        "ERREUR MIGRATION CONTEXT :",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur inconnue",
      });
    }
  }
);
app.get(
  "/internal/rebuild-daily-analyses",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        getParisDateString();

      const limit =
        Math.max(
          1,
          Math.min(
            300,
            Number(req.query.limit) ||
              200
          )
        );

      const fixturesResponse =
        await callApiFootball(
          "/fixtures",
          {
            date,
            timezone:
              "Europe/Paris",
          }
        );

      const fixtures =
        Array.isArray(
          fixturesResponse
            .data?.response
        )
          ? fixturesResponse
              .data.response
          : [];

      const selectedFixtures =
        fixtures.slice(0, limit);

      const results = [];

      for (
        const fixture
        of selectedFixtures
      ) {
        const fixtureId =
          Number(
            fixture?.fixture?.id
          );

        if (
          !Number.isInteger(
            fixtureId
          )
        ) {
          continue;
        }

        try {
          analysisCache.delete(
            fixtureId
          );

          const baseUrl =
  process.env.PUBLIC_API_URL ||
  `http://127.0.0.1:${PORT}`;

const response = await axios.get(
  `${baseUrl}/internal/analyze/${fixtureId}?refresh=1`,
  {
    timeout: 120000,
  }
);

const analysis =
  response.data?.analysis ||
  response.data;

          results.push({
            fixtureId,
            ok: true,
            hasContext:
              Boolean(
                analysis?.context
              ),
            hasMonteCarlo:
              Number(
                analysis
                  ?.monteCarloModel
                  ?.simulations
              ) === 10000,
          });
        } catch (error) {
          results.push({
            fixtureId,
            ok: false,
            error:
              error.message ||
              "Erreur inconnue",
          });
        }
      }

      return res.json({
        ok: true,
        date,
        summary: {
          fixtures:
            selectedFixtures
              .length,

          rebuilt:
            results.filter(
              (item) =>
                item.ok
            ).length,

          failed:
            results.filter(
              (item) =>
                !item.ok
            ).length,
        },
        results,
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            "Erreur inconnue",
        });
    }
  }
);
let lineupWatcherRunning = false;

const lineupRebuiltFixtures =
  new Set();

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function runLineupWatcher() {
  if (lineupWatcherRunning) {
    console.log(
      "LINEUP WATCHER : contrôle déjà en cours"
    );

    return;
  }

  lineupWatcherRunning = true;

  try {
    const date =
      getParisDateString();

    console.log(
      `LINEUP WATCHER : contrôle du ${date}`
    );

    /*
     * On récupère les matchs du jour.
     */
    const fixturesResponse =
      await callApiFootball(
        "/fixtures",
        {
          date,
          timezone:
            "Europe/Paris",
        }
      );

    const fixtures =
      Array.isArray(
        fixturesResponse
          .data?.response
      )
        ? fixturesResponse
            .data.response
        : [];

    const now =
      Date.now();

    /*
     * On surveille uniquement les matchs :
     * - commençant dans moins de 2 heures ;
     * - ou commencés/terminés depuis moins de 3 heures.
     */
    const fixturesToCheck =
  fixtures.filter((item) => {
    if (
      isExcludedFixture(item)
    ) {
      return false;
    }

    const fixtureId =
      Number(
        item?.fixture?.id
      );

    const kickoff =
      new Date(
        item?.fixture?.date
      ).getTime();

        if (
          !Number.isInteger(
            fixtureId
          ) ||
          fixtureId <= 0 ||
          !Number.isFinite(kickoff)
        ) {
          return false;
        }

        const minutesUntilKickoff =
          (kickoff - now) /
          60000;

        return (
          minutesUntilKickoff <=
            120 &&
          minutesUntilKickoff >=
            -180
        );
      });

    const baseUrl =
      `http://127.0.0.1:${PORT}`;

    const results = [];

    for (
      const fixture
      of fixturesToCheck
    ) {
      const fixtureId =
        Number(
          fixture.fixture.id
        );

      const homeTeam =
        fixture.teams?.home
          ?.name ||
        "Domicile";

      const awayTeam =
        fixture.teams?.away
          ?.name ||
        "Extérieur";

      /*
       * Ce match a déjà été recalculé après
       * réception de ses compositions.
       */
      if (
        lineupRebuiltFixtures.has(
          fixtureId
        )
      ) {
        continue;
      }

      try {
        /*
         * Petit délai pour éviter les erreurs 429.
         */
        await wait(1200);

        const lineupResponse =
          await callApiFootball(
            "/fixtures/lineups",
            {
              fixture:
                fixtureId,
            }
          );

        const lineups =
          Array.isArray(
            lineupResponse
              .data?.response
          )
            ? lineupResponse
                .data.response
            : [];

        const homeFormation =
          lineups?.[0]
            ?.formation ||
          null;

        const awayFormation =
          lineups?.[1]
            ?.formation ||
          null;

        const lineupsAvailable =
          lineups.length >= 2 &&
          Boolean(
            homeFormation &&
            awayFormation
          );

        if (!lineupsAvailable) {
          results.push({
            fixtureId,
            homeTeam,
            awayTeam,
            status:
              "WAITING_LINEUPS",
          });

          continue;
        }

        console.log(
          "LINEUP WATCHER : compositions détectées",
          {
            fixtureId,
            homeTeam,
            awayTeam,
            homeFormation,
            awayFormation,
          }
        );

        /*
         * Recalcul complet sans utiliser le cache.
         */
        const analysisResponse =
          await fetch(
            `${baseUrl}/internal/analyze/${fixtureId}?refresh=1`,
            {
              method: "GET",
              headers: {
                Accept:
                  "application/json",
              },
            }
          );

        const analysisData =
          await analysisResponse
            .json();

        if (
          !analysisResponse.ok ||
          !analysisData?.ok
        ) {
          throw new Error(
            analysisData?.message ||
            analysisData?.error ||
            "Recalcul impossible"
          );
        }

        lineupRebuiltFixtures.add(
          fixtureId
        );

        results.push({
          fixtureId,
          homeTeam,
          awayTeam,
          status:
            "REBUILT_WITH_LINEUPS",
          homeFormation,
          awayFormation,
        });
      } catch (error) {
        const status =
          error.response?.status;

        results.push({
          fixtureId,
          homeTeam,
          awayTeam,
          status: "FAILED",
          error:
            error.message ||
            "Erreur inconnue",
        });

        /*
         * Si l’API ralentit les requêtes,
         * on attend avant le match suivant.
         */
        if (status === 429) {
          console.warn(
            "LINEUP WATCHER : limite API, pause de 60 secondes"
          );

          await wait(60000);
        }
      }
    }

    console.log(
      "LINEUP WATCHER : terminé",
      {
        checked:
          fixturesToCheck.length,

        rebuilt:
          results.filter(
            (item) =>
              item.status ===
              "REBUILT_WITH_LINEUPS"
          ).length,

        waiting:
          results.filter(
            (item) =>
              item.status ===
              "WAITING_LINEUPS"
          ).length,

        failed:
          results.filter(
            (item) =>
              item.status ===
              "FAILED"
          ).length,
      }
    );
  } catch (error) {
    console.error(
      "ERREUR LINEUP WATCHER :",
      error.message
    );
  } finally {
    lineupWatcherRunning =
      false;
  }
}
let lineupWatcherSchedulerStarted = false;

function startLineupWatcherScheduler() {
  if (lineupWatcherSchedulerStarted) {
    console.log(
      "⏭️ Lineup Watcher Scheduler déjà démarré."
    );
    return;
  }

  lineupWatcherSchedulerStarted = true;

  /*
   * Premier contrôle 45 secondes
   * après le démarrage du serveur.
   */
  setTimeout(() => {
    runLineupWatcher().catch((error) => {
      console.error(
        "ERREUR PREMIER LINEUP WATCHER :",
        error
      );
    });
  }, 45_000);

  /*
   * Nouveau contrôle toutes les 10 minutes.
   */
  setInterval(() => {
    runLineupWatcher().catch((error) => {
      console.error(
        "ERREUR INTERVAL LINEUP WATCHER :",
        error
      );
    });
  }, 10 * 60 * 1000);

  console.log(
    "✅ Lineup Watcher Scheduler : toutes les 10 minutes"
  );
}
let hourlyOddsWatcherRunning = false;

function normalizeSelectedOutcome(
  selectedOutcome = ""
) {
  const value = String(
    selectedOutcome
  )
    .trim()
    .toUpperCase();

  if (
    value === "HOME" ||
    value === "1" ||
    value === "DOMICILE"
  ) {
    return "HOME";
  }

  if (
    value === "DRAW" ||
    value === "X" ||
    value === "N" ||
    value === "NUL"
  ) {
    return "DRAW";
  }

  if (
    value === "AWAY" ||
    value === "2" ||
    value === "EXTÉRIEUR" ||
    value === "EXTERIEUR"
  ) {
    return "AWAY";
  }

  return null;
}

function getSelectedMarketOdd(
  market = {},
  selectedOutcome = ""
) {
  const normalized =
    normalizeSelectedOutcome(
      selectedOutcome
    );

  if (normalized === "HOME") {
    return Number(
      market.homeAverageOdd
    );
  }

  if (normalized === "DRAW") {
    return Number(
      market.drawAverageOdd
    );
  }

  if (normalized === "AWAY") {
    return Number(
      market.awayAverageOdd
    );
  }

  return null;
}

function getSelectedProbability(
  prediction = {}
) {
  const normalized =
    normalizeSelectedOutcome(
      prediction.selected_outcome
    );

  if (normalized === "HOME") {
    return Number(
      prediction.home_probability
    );
  }

  if (normalized === "DRAW") {
    return Number(
      prediction.draw_probability
    );
  }

  if (normalized === "AWAY") {
    return Number(
      prediction.away_probability
    );
  }

  return null;
}

async function runHourlyOddsWatcher() {
  if (hourlyOddsWatcherRunning) {
    console.log(
      "ODDS WATCHER : contrôle déjà en cours"
    );
    return;
  }

  hourlyOddsWatcherRunning = true;

  const summary = {
    checked: 0,
    updated: 0,
    rebuilt: 0,
    unavailable: 0,
    failed: 0,
  };

  try {
    const date =
      getParisDateString();

    console.log(
      `ODDS WATCHER : contrôle du ${date}`
    );

    /*
     * On sélectionne seulement les 20
     * prochains matchs déjà analysés.
     */
    const predictionsResult =
      await pool.query(
        `
          SELECT
            fixture_id,
            fixture_date,
            selected_outcome,
            home_probability,
            draw_probability,
            away_probability,
            market_odd
          FROM predictions
          WHERE
            fixture_date >= NOW()
            AND fixture_date <
              NOW() + INTERVAL '24 hours'
            AND result_status = 'PENDING'
          ORDER BY fixture_date ASC
          LIMIT 20
        `
      );

    const predictions =
      predictionsResult.rows;

    for (
      const prediction
      of predictions
    ) {
      const fixtureId =
        Number(
          prediction.fixture_id
        );

      try {
        summary.checked += 1;

        const oddsResponse =
          await callApiFootball(
            "/odds",
            {
              fixture: fixtureId,
            }
          );

        const rawOdds =
          oddsResponse.data?.response ||
          [];

        const market =
          summarizeMatchWinnerOdds(
            rawOdds
          );

        const newMarketOdd =
          getSelectedMarketOdd(
            market,
            prediction.selected_outcome
          );

        if (
          !Number.isFinite(
            newMarketOdd
          ) ||
          newMarketOdd <= 1
        ) {
          summary.unavailable += 1;
          continue;
        }

        const oldMarketOdd =
          Number(
            prediction.market_odd
          );

        const probability =
          getSelectedProbability(
            prediction
          );

        const valuePercentage =
          Number.isFinite(
            probability
          )
            ? Number(
                (
                  (
                    newMarketOdd *
                    (probability / 100)
                  ) -
                  1
                ).toFixed(4)
              ) * 100
            : null;

        /*
         * Variation relative entre
         * l’ancienne et la nouvelle cote.
         */
        const movementPercent =
          Number.isFinite(
            oldMarketOdd
          ) &&
          oldMarketOdd > 1
            ? Math.abs(
                (
                  (
                    newMarketOdd -
                    oldMarketOdd
                  ) /
                  oldMarketOdd
                ) *
                  100
              )
            : 0;

        /*
         * Mouvement d’au moins 10 % :
         * réanalyse complète du match.
         */
        if (
          movementPercent >= 10
        ) {
          console.log(
            "ODDS WATCHER : mouvement important",
            {
              fixtureId,
              oldMarketOdd,
              newMarketOdd,
              movementPercent:
                Number(
                  movementPercent.toFixed(
                    2
                  )
                ),
            }
          );

          analysisCache.delete(
            fixtureId
          );

          await processFixtureAnalysis(
            fixtureId,
            {
              forceRefresh: true,
            }
          );

          summary.rebuilt += 1;
        } else {
          /*
           * Petit mouvement :
           * simple actualisation SQL,
           * sans reconstruire les moteurs.
           */
          await pool.query(
            `
              UPDATE predictions
              SET
                market_odd = $1,
                value_percentage = $2,
                updated_at = NOW()
              WHERE fixture_id = $3
            `,
            [
              newMarketOdd,
              valuePercentage,
              fixtureId,
            ]
          );

          summary.updated += 1;
        }

        /*
         * Petite pause pour éviter
         * d’envoyer 20 appels simultanés.
         */
        await wait(750);
      } catch (error) {
        summary.failed += 1;

        console.error(
          "ODDS WATCHER : erreur",
          {
            fixtureId,
            error:
              error.message ||
              "Erreur inconnue",
          }
        );

        await wait(1500);
      }
    }

    console.log(
      "ODDS WATCHER : terminé",
      summary
    );
  } catch (error) {
    console.error(
      "ODDS WATCHER : erreur générale",
      error.message
    );
  } finally {
    hourlyOddsWatcherRunning =
      false;
  }
}
/*
 * PLANIFICATEUR DE L’ANALYSE COMPLÈTE
 *
 * Après 03h00 (heure de Paris), le backend vérifie que les analyses
 * du jour ont bien été générées. Un redémarrage après 03h00 déclenche
 * donc un rattrapage au lieu d’attendre le lendemain.
 */
let lastDailyFullAnalysisDate = null;
let lastDailyFullAnalysisAttemptAt = 0;

const DAILY_ANALYSIS_RETRY_INTERVAL_MS =
  3 * 60 * 1000;

function getParisTimeParts() {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Europe/Paris",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }
    ).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] =
        part.value;
    }
  }

  return {
    date:
      `${values.year}-` +
      `${values.month}-` +
      `${values.day}`,

    hour:
      Number(values.hour),

    minute:
      Number(values.minute),
  };
}

async function checkDailyFullAnalysisSchedule() {
  const paris =
    getParisTimeParts();

  /*
   * Avant 03h00, on ne lance rien. Après 03h00, un démarrage tardif
   * ou un déploiement Railway peut encore rattraper les analyses.
   */
  if (paris.hour < 3) {
    return;
  }

  if (
    lastDailyFullAnalysisDate ===
    paris.date
  ) {
    return;
  }

  if (dailyAnalysisJobRunning) {
    return;
  }

  const now = Date.now();

  if (
    now - lastDailyFullAnalysisAttemptAt <
    DAILY_ANALYSIS_RETRY_INTERVAL_MS
  ) {
    return;
  }

  lastDailyFullAnalysisAttemptAt = now;

  console.log(
    `ANALYSE COMPLÈTE : contrôle/rattrapage ${paris.date}`
  );

  try {
    const result =
      await runAutomaticDailyAnalysis({
        date: paris.date,
      });

    const summary =
      result?.summary || {};

    const failed =
      Number(summary.failed || 0);

    const fixturesFound =
      Number(summary.fixturesFound || 0);

    const alreadyComplete =
      Number(summary.alreadyComplete || 0);

    const rebuilt =
      Number(summary.rebuilt || 0);

    const remaining =
      Number(summary.remaining || 0);

    const covered =
      alreadyComplete + rebuilt;

    /*
     * On marque la journée comme terminée uniquement lorsque le cycle
     * n’a produit aucun échec et que tous les matchs éligibles sont
     * couverts. Sinon, une nouvelle tentative aura lieu 30 min après.
     */
    if (
      failed === 0 &&
      remaining === 0 &&
      covered >= fixturesFound
    ) {
      lastDailyFullAnalysisDate =
        paris.date;

      console.log(
        `ANALYSE COMPLÈTE : journée ${paris.date} couverte (${covered}/${fixturesFound})`
      );
    } else {
      console.warn(
        `ANALYSE COMPLÈTE : journée incomplète (${covered}/${fixturesFound}, ${failed} échec(s)). Nouveau lot dans environ 3 minutes.`
      );
    }
  } catch (error) {
    console.error(
      "ANALYSE COMPLÈTE : erreur",
      error.message
    );
  }
}
/**
 * BILAN PUBLIC — RAPPORTS TERMINÉS PAGINÉS
 *
 * Cette route ne renvoie pas les énormes snapshots complets.
 * Elle retourne uniquement les informations nécessaires
 * pour afficher les cartes du Bilan.
 */
app.get(
  "/public/bilan/reports",
  async (req, res) => {
    try {
      await ensureBilanV3Columns();
      await refreshManualOddsProfits();

      const requestedLimit = Number(
        req.query.limit
      );

      const requestedOffset = Number(
        req.query.offset
      );

      const limit =
        Number.isInteger(requestedLimit) &&
        requestedLimit > 0
          ? Math.min(requestedLimit, 100)
          : 20;

      const offset =
        Number.isInteger(requestedOffset) &&
        requestedOffset >= 0
          ? requestedOffset
          : 0;

      /*
       * On demande une ligne supplémentaire afin de savoir
       * s'il reste une page, sans lancer un COUNT(*) séparé.
       */
      const queryLimit = limit + 1;

      const result = await pool.query(
        `
          SELECT
            id,
            fixture_id,
            fixture_date,

            league_id,
            league_name,

            home_team_id,
            home_team_name,
            away_team_id,
            away_team_name,

            home_goals,
            away_goals,

            decision,
            selected_outcome,
            bet_status,
            confidence,
            risk,

            home_probability,
            draw_probability,
            away_probability,

            fair_odd,
            market_odd,
            value_percentage,

            result_status,
            won,
            profit,

            studio_market_key,
            studio_market_label,
            studio_probability,
            studio_decision_score,
            studio_decision_type,
            studio_decision_grade,
            studio_analysis_version,

            manual_market_odd,
            manual_stake_units,
            manual_profit_units,
            manual_roi_percent,

            official_tracked_market_key,
            official_tracked_market_label,
            official_tracked_probability,
            official_tracked_decision_score,
            official_tracked_at,
            official_market_won,

            prematch_final_market_key,
            prematch_final_market_label,
            prematch_final_probability,
            prematch_final_decision_score,
            prematch_final_captured_at,
            prematch_final_market_won,

            market_changed,
            market_change_outcome,

            updated_at
          FROM predictions
          WHERE result_status = 'COMPLETED'
          ORDER BY
            fixture_date DESC NULLS LAST,
            updated_at DESC NULLS LAST,
            id DESC
          LIMIT $1
          OFFSET $2
        `,
        [queryLimit, offset]
      );

      const hasMore =
        result.rows.length > limit;

      const reports = hasMore
        ? result.rows.slice(0, limit)
        : result.rows;

      return res.json({
        ok: true,

        count: reports.length,
        limit,
        offset,

        hasMore,

        nextOffset: hasMore
          ? offset + reports.length
          : null,

        reports,
      });
    } catch (error) {
      console.error(
        "ERREUR /public/bilan/reports :",
        error
      );

      return res.status(500).json({
        ok: false,
        reports: [],
        count: 0,
        hasMore: false,
        nextOffset: null,
        error:
          error.message ||
          "Impossible de charger les rapports du Bilan.",
      });
    }
  }
);
/*
 * DÉMARRAGE DU SERVEUR
 */
/*
 * LEARNING — MATCHS TERMINÉS
 *
 * Retourne les prédictions terminées
 * enregistrées dans PostgreSQL.
 */
app.get(
  "/public/learning/finished",
  async (req, res) => {
    try {
      const requestedLimit =
  Number(req.query.limit);

const requestedOffset =
  Number(req.query.offset);

const limit =
  Number.isInteger(requestedLimit) &&
  requestedLimit > 0
    ? Math.min(requestedLimit, 300)
    : 300;

const offset =
  Number.isInteger(requestedOffset) &&
  requestedOffset >= 0
    ? requestedOffset
    : 0;

      const result =
        await pool.query(
          `
            SELECT
              id,
              fixture_id,
              fixture_date,

              league_id,
              league_name,

              home_team_id,
              home_team_name,
              away_team_id,
              away_team_name,

              decision,
              selected_outcome,
              bet_status,

              confidence,
              risk,
studio_market_key,
studio_market_label,
studio_probability,
studio_decision_score,
studio_decision_type,
studio_decision_grade,
studio_analysis_version,
studio_snapshot,
studio_saved_at,
              home_probability,
              draw_probability,
              away_probability,

              fair_odd,
              market_odd,
              value_percentage,

              explanation,

              result_status,
              home_goals,
              away_goals,
              won,
              profit,

              official_xg_home,
              official_xg_away,
              xg_source,
              xg_confidence_score,
              xg_confidence_level,

              form_weight,
              market_weight,
              monte_carlo_weight,

              decision_trace,
              model_inputs,
              monte_carlo_model,
              analysis_context,

              created_at,
              updated_at
            FROM predictions
            WHERE
              result_status IS NOT NULL
              AND LOWER(result_status)
                IN (
                  'win',
                  'loss',
                  'won',
                  'lost',
                  'completed',
                  'finished'
                )
              AND home_goals IS NOT NULL
              AND away_goals IS NOT NULL
            ORDER BY
  fixture_date DESC,
  fixture_id DESC
LIMIT $1
OFFSET $2
          `,
          [
  limit,
  offset
]
        );

      return res.json({
  ok: true,

  count: result.rows.length,

  limit,
  offset,

  hasMore:
    result.rows.length === limit,

  nextOffset:
    offset + result.rows.length,

  predictions:
    result.rows,
});
    } catch (error) {
      console.error(
        "ERREUR /public/learning/finished :",
        error
      );

      return res.status(500).json({
        ok: false,
        predictions: [],
        count: 0,
        error:
          error.message ||
          "Impossible de charger les prédictions terminées.",
      });
    }
  }
);
let automaticResultSyncRunning =
  false;

async function runAutomaticResultSync() {
  if (automaticResultSyncRunning) {
    console.log(
      "RESULT SYNC : cycle déjà actif"
    );

    return {
      skipped: true,
      reason: "ALREADY_RUNNING",
    };
  }

  automaticResultSyncRunning = true;

  try {
    const summary =
      await synchronizeFinishedPredictionsByDate();

    const manualOddsRefresh =
      await refreshManualOddsProfits();

    summary.manualOddsRefresh =
      manualOddsRefresh;

    console.log(
      "RESULT SYNC TERMINÉ :",
      {
        apiCalls:
          summary.apiCalls,

        fixturesReceived:
          summary.fixturesReceived,

        pendingPredictions:
          summary.pendingPredictions,

        completed:
          summary.completed,

        stillPending:
          summary.stillPending,

        errors:
          summary.errors,
      }
    );

    return summary;
  } catch (error) {
    console.error(
      "RESULT SYNC ERREUR :",
      error
    );

    return {
      apiCalls: 0,
      completed: 0,
      errors: 1,
      error:
        error?.message ||
        "Erreur inconnue",
    };
  } finally {
    automaticResultSyncRunning =
      false;
  }
}
          async function ensureStudioPredictionColumns() {
  await pool.query(`
    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_market_key TEXT;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_market_label TEXT;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_probability NUMERIC(6,2);

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_decision_score NUMERIC(6,2);

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_decision_type TEXT;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_decision_grade TEXT;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_analysis_version TEXT;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_snapshot JSONB;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_saved_at TIMESTAMPTZ;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      analysis_status TEXT;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      analysis_error TEXT;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      analysis_status_updated_at TIMESTAMPTZ;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_rebuild_attempts INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_last_rebuild_at TIMESTAMPTZ;

    UPDATE predictions
    SET
      analysis_status = CASE
        WHEN studio_snapshot IS NOT NULL
         AND jsonb_typeof(studio_snapshot) = 'object'
         AND NULLIF(BTRIM(studio_market_key), '') IS NOT NULL
         AND NULLIF(BTRIM(studio_market_label), '') IS NOT NULL
         AND studio_probability IS NOT NULL
         AND studio_decision_score IS NOT NULL
          THEN 'READY'
        WHEN result_status = 'COMPLETED'
          THEN 'REBUILD_REQUIRED'
        ELSE 'PENDING_API'
      END,
      analysis_status_updated_at = COALESCE(analysis_status_updated_at, NOW())
    WHERE analysis_status IS NULL;
  `);

  console.log(
    "✅ Colonnes Brain Studio vérifiées"
  );
}
          function clampStudioNumber(
  value,
  min = 0,
  max = 100
) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.max(
    min,
    Math.min(max, number)
  );
}

function normalizeStudioMarketKey(
  value
) {
  const normalized = String(
    value || ""
  )
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/\./g, "");

  const aliases = {
    HOME: "HOME",
    HOME_WIN: "HOME",
    "1": "HOME",

    DRAW: "DRAW",
    X: "DRAW",

    AWAY: "AWAY",
    AWAY_WIN: "AWAY",
    "2": "AWAY",

    OVER25: "OVER25",
    OVER_25: "OVER25",
    OVER_2_5: "OVER25",

    UNDER25: "UNDER25",
    UNDER_25: "UNDER25",
    UNDER_2_5: "UNDER25",

    BTTS: "BTTS",
    BTTS_YES: "BTTS",

    NO_BTTS: "NO_BTTS",
    BTTS_NO: "NO_BTTS",
  };

  return aliases[normalized] ||
    normalized ||
    null;
}

function normalizeStudioDecisionType(
  value
) {
  const normalized = String(
    value || "NO_BET"
  ).toUpperCase();

  if (
    normalized === "BET" ||
    normalized === "VALUE_BET"
  ) {
    return normalized;
  }

  return "NO_BET";
}

/*
 * SNAPSHOTS BRAIN STUDIO COMPACTS
 *
 * PostgreSQL ne conserve désormais que les informations nécessaires
 * au Bilan, à l'historique et à la reconstruction du marché principal.
 * Les objets lourds (engines, weights, modelInputs, decisionTrace,
 * Monte Carlo complet, contextes détaillés, etc.) ne sont pas stockés
 * dans studio_snapshot.
 */
function finiteStudioNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number
    : null;
}

function compactStudioMarket(
  market = {}
) {
  if (
    !market ||
    typeof market !== "object"
  ) {
    return null;
  }

  const probability =
    finiteStudioNumberOrNull(
      market?.fairOdds
        ?.calibratedProbability ??
      market?.calibratedProbability ??
      market?.probability
    );

  const decisionScore =
    finiteStudioNumberOrNull(
      market?.decision?.score ??
      market?.decisionScore ??
      market?.score
    );

  const marketOdd =
    finiteStudioNumberOrNull(
      market?.fairOdds?.marketOdd ??
      market?.marketOdd ??
      market?.odd
    );

  const fairOdd =
    finiteStudioNumberOrNull(
      market?.fairOdds?.fairOdd ??
      market?.fairOdd
    );

  const value =
    finiteStudioNumberOrNull(
      market?.fairOdds?.value ??
      market?.value
    );

  const compact = {
    key:
      market.key ||
      market.marketKey ||
      null,

    label:
      market.label ||
      market.marketLabel ||
      market.key ||
      null,

    probability,

    calibratedProbability:
      probability,

    score:
      decisionScore,

    decisionScore,

    decision: {
      score:
        decisionScore,

      type:
        normalizeStudioDecisionType(
          market?.decision?.type ||
          market?.decisionType
        ),

      grade:
        market?.decision?.grade ||
        market?.decisionGrade ||
        null,
    },

    fairOdds: {
      calibratedProbability:
        probability,

      fairOdd,
      marketOdd,
      value,
    },
  };

  /*
   * Supprime uniquement les valeurs nulles sans modifier
   * la structure attendue par le frontend.
   */
  if (
    compact.fairOdds.fairOdd == null
  ) {
    delete compact.fairOdds.fairOdd;
  }

  if (
    compact.fairOdds.marketOdd == null
  ) {
    delete compact.fairOdds.marketOdd;
  }

  if (
    compact.fairOdds.value == null
  ) {
    delete compact.fairOdds.value;
  }

  return compact;
}

function compactStudioSnapshot(
  snapshot = {}
) {
  const rawMarkets =
    Array.isArray(snapshot?.markets)
      ? snapshot.markets
      : [];

  const compactMarkets =
    rawMarkets
      .map(compactStudioMarket)
      .filter(
        (market) =>
          market &&
          market.key
      )
      .sort((a, b) => {
        const scoreDifference =
          Number(
            b.decisionScore || 0
          ) -
          Number(
            a.decisionScore || 0
          );

        if (
          scoreDifference !== 0
        ) {
          return scoreDifference;
        }

        return (
          Number(
            b.probability || 0
          ) -
          Number(
            a.probability || 0
          )
        );
      });

  const rawPrimary =
    snapshot?.primaryMarket ||
    snapshot?.bestDecision ||
    compactMarkets[0] ||
    null;

  const compactPrimary =
    compactStudioMarket(
      rawPrimary
    ) ||
    compactMarkets[0] ||
    null;

  const marketsByKey =
    new Map();

  for (
    const market of [
      compactPrimary,
      ...compactMarkets,
    ]
  ) {
    if (
      !market ||
      !market.key ||
      marketsByKey.has(
        market.key
      )
    ) {
      continue;
    }

    marketsByKey.set(
      market.key,
      market
    );
  }

  const markets =
    [...marketsByKey.values()]
      .sort((a, b) => {
        const scoreDifference =
          Number(
            b.decisionScore || 0
          ) -
          Number(
            a.decisionScore || 0
          );

        if (
          scoreDifference !== 0
        ) {
          return scoreDifference;
        }

        return (
          Number(
            b.probability || 0
          ) -
          Number(
            a.probability || 0
          )
        );
      });

  const primaryMarket =
    markets[0] ||
    compactPrimary ||
    null;

  return {
    primaryMarket,

    bestDecision:
      primaryMarket,

    markets,

    generatedAt:
      snapshot?.generatedAt ||
      new Date().toISOString(),

    fixtureDate:
      snapshot?.fixtureDate ||
      null,

    locked:
      Boolean(
        snapshot?.locked
      ),

    rebuilt:
      Boolean(
        snapshot?.rebuilt
      ),

    rebuiltAt:
      snapshot?.rebuiltAt ||
      null,

    rebuildSource:
      snapshot?.rebuildSource ||
      null,

    administrativeOverride:
      Boolean(
        snapshot
          ?.administrativeOverride
      ),

    compact: true,

    snapshotVersion:
      "compact-v1",
  };
}

async function queryWithRetry(
  queryText,
  values = [],
  {
    attempts = 3,
    delayMs = 750,
  } = {}
) {
  let lastError;

  for (
    let attempt = 1;
    attempt <= attempts;
    attempt += 1
  ) {
    try {
      return await pool.query(
        queryText,
        values
      );
    } catch (error) {
      lastError = error;

      const retryableCodes =
        new Set([
          "40001",
          "40P01",
          "53300",
          "57P03",
          "08000",
          "08003",
          "08006",
          "08001",
          "08004",
        ]);

      const retryable =
        retryableCodes.has(
          String(
            error?.code || ""
          )
        ) ||
        /connection|terminating|not yet accepting|timeout/i.test(
          String(
            error?.message || ""
          )
        );

      if (
        !retryable ||
        attempt >= attempts
      ) {
        throw error;
      }

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            delayMs * attempt
          )
      );
    }
  }

  throw lastError;
}

async function saveStudioSnapshot({
  fixtureId,
  marketKey,
  marketLabel,
  probability,
  decisionScore,
  decisionType,
  decisionGrade,
  analysisVersion,
  snapshot,
}) {
  const normalizedFixtureId =
    Number(fixtureId);

  if (
    !Number.isInteger(
      normalizedFixtureId
    ) ||
    normalizedFixtureId <= 0
  ) {
    throw new Error(
      "fixtureId invalide"
    );
  }

  const normalizedMarketKey =
    normalizeStudioMarketKey(
      marketKey
    );

  if (!normalizedMarketKey) {
    throw new Error(
      "Marché Brain Studio invalide"
    );
  }

  const normalizedProbability =
    clampStudioNumber(
      probability
    );

  const normalizedDecisionScore =
    clampStudioNumber(
      decisionScore
    );

  const normalizedDecisionType =
    normalizeStudioDecisionType(
      decisionType
    );

  const normalizedDecisionGrade =
    decisionGrade
      ? String(decisionGrade).toUpperCase()
      : "UNRATED";

  const adaptiveLearning =
    await getAdaptiveLearningAdjustment({
      marketKey: normalizedMarketKey,
      decisionGrade: normalizedDecisionGrade,
      decisionType: normalizedDecisionType,
      baseProbability: normalizedProbability,
    });

  const finalStudioProbability =
    adaptiveLearning.adjustedProbability;

  const compactSnapshot =
    compactStudioSnapshot({
      ...(snapshot || {}),
      adaptiveLearning,
    });

  const result = await queryWithRetry(
    `
      UPDATE predictions
      SET
        studio_market_key = $1,
        studio_market_label = $2,
        studio_base_probability = $3,
        studio_probability = $4,
        studio_decision_score = $5,
        studio_decision_type = $6,
        studio_decision_grade = $7,
        studio_analysis_version = $8,
        studio_snapshot = $9::jsonb,
        learning_probability_adjustment = $10,
        learning_applied_weight = $11,
        learning_engine_version = $12,
        learning_applied_at = NOW(),
        studio_saved_at = NOW(),
        analysis_status = 'READY',
        analysis_error = NULL,
        analysis_status_updated_at = NOW(),
        updated_at = NOW()
      WHERE fixture_id = $13
      RETURNING
        fixture_id,
        studio_market_key,
        studio_market_label,
        studio_base_probability,
        studio_probability,
        learning_probability_adjustment,
        learning_applied_weight,
        learning_engine_version,
        studio_decision_score,
        studio_decision_type,
        studio_decision_grade,
        studio_analysis_version,
        studio_saved_at
    `,
    [
      normalizedMarketKey,

      String(
        marketLabel ||
          normalizedMarketKey
      ),

      normalizedProbability,

      finalStudioProbability,

      normalizedDecisionScore,

      normalizedDecisionType,

      normalizedDecisionGrade,

      String(
        analysisVersion ||
          "brain-studio-v1"
      ),

      JSON.stringify(
        compactSnapshot
      ),

      adaptiveLearning.adjustment,

      adaptiveLearning.appliedWeight,

      LEARNING_ENGINE_VERSION,

      normalizedFixtureId,
    ]
  );

  if (
    result.rows.length === 0
  ) {
    throw new Error(
      "Prédiction Railway introuvable"
    );
  }

  return result.rows[0];
}
app.post(
  "/public/studio-snapshot/:fixtureId",
  async (req, res) => {
    try {
      await ensureBilanV3Columns();

      const fixtureId = Number(
        req.params.fixtureId
      );

      if (
        !Number.isInteger(fixtureId) ||
        fixtureId <= 0
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "fixtureId invalide",
          });
      }

      const body =
        req.body || {};

      const primaryMarket =
        body.primaryMarket ||
        body.bestDecision ||
        null;

      if (!primaryMarket) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "primaryMarket manquant",
          });
      }

      /*
       * Vérifier la date du match avant
       * d'autoriser la modification du snapshot.
       */
      const predictionResult =
        await pool.query(
          `
            SELECT
              fixture_id,
              fixture_date,
              result_status,
              studio_market_key,
              studio_market_label,
              studio_saved_at
            FROM predictions
            WHERE fixture_id = $1
            LIMIT 1
          `,
          [fixtureId]
        );

      const prediction =
        predictionResult.rows[0];

      if (!prediction) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Prédiction Railway introuvable",
          });
      }

      const fixtureDate =
        prediction.fixture_date
          ? new Date(
              prediction.fixture_date
            )
          : null;

      if (
        fixtureDate &&
        Number.isNaN(
          fixtureDate.getTime()
        )
      ) {
        return res
          .status(500)
          .json({
            ok: false,
            error:
              "Date du match invalide dans la base de données",
          });
      }

      /*
       * Dès que le coup d'envoi est atteint,
       * le dernier snapshot Brain Studio
       * enregistré est définitivement verrouillé.
       */
      if (
        fixtureDate &&
        fixtureDate.getTime() <=
          Date.now()
      ) {
        return res
          .status(409)
          .json({
            ok: false,
            locked: true,
            fixtureId,
            kickoff:
              fixtureDate.toISOString(),
            studioMarketKey:
              prediction
                .studio_market_key ||
              null,
            studioMarketLabel:
              prediction
                .studio_market_label ||
              null,
            studioSavedAt:
              prediction
                .studio_saved_at ||
              null,
            error:
              "Le pronostic Brain Studio est verrouillé depuis le coup d’envoi.",
          });
      }

      /*
       * Avant le coup d'envoi, le nouveau
       * marché Brain Studio remplace l'ancien.
       */
      const saved =
        await saveStudioSnapshot({
          fixtureId,

          marketKey:
            primaryMarket.key,

          marketLabel:
            primaryMarket.label,

          probability:
            primaryMarket
              ?.fairOdds
              ?.calibratedProbability ??
            primaryMarket
              ?.probability,

          decisionScore:
            primaryMarket
              ?.decision
              ?.score ??
            primaryMarket
              ?.score,

          decisionType:
            primaryMarket
              ?.decision
              ?.type,

          decisionGrade:
            primaryMarket
              ?.decision
              ?.grade,

          analysisVersion:
            body.analysisVersion ||
            body.version ||
            "brain-studio-v1",

          snapshot: {
            primaryMarket,

            bestDecision:
              body.bestDecision ||
              primaryMarket,

            markets:
              Array.isArray(
                body.markets
              )
                ? body.markets
                : [],

            generatedAt:
              body.generatedAt ||
              new Date()
                .toISOString(),

            fixtureDate:
              fixtureDate
                ? fixtureDate
                    .toISOString()
                : null,

            locked:
              false,
          },
        });

      /*
       * Le dernier marché principal avant le coup d'envoi reste dynamique.
       * Chaque snapshot accepté remplace le précédent. Dès le coup d'envoi,
       * la route est verrouillée et ces valeurs deviennent définitives.
       */
      await pool.query(
        `
          UPDATE predictions
          SET
            prematch_final_market_key = $2,
            prematch_final_market_label = $3,
            prematch_final_probability = $4,
            prematch_final_decision_score = $5,
            prematch_final_captured_at = NOW(),
            updated_at = NOW()
          WHERE fixture_id = $1
        `,
        [
          fixtureId,
          primaryMarket.key || null,
          primaryMarket.label || null,
          primaryMarket?.fairOdds?.calibratedProbability ??
            primaryMarket?.probability ??
            null,
          primaryMarket?.decision?.score ??
            primaryMarket?.score ??
            null,
        ]
      );

      return res.json({
        ok: true,
        locked: false,
        replaced:
          Boolean(
            prediction
              .studio_market_key
          ),
        previousSnapshot: {
          marketKey:
            prediction
              .studio_market_key ||
            null,

          marketLabel:
            prediction
              .studio_market_label ||
            null,

          savedAt:
            prediction
              .studio_saved_at ||
            null,
        },
        prediction:
          saved,
      });
    } catch (error) {
      console.error(
        "ERREUR STUDIO SNAPSHOT :",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ||
            "Erreur inconnue",
        });
    }
  }
);

/*
 * ============================================================
 * TICKET DU JOUR — MATCHS ET SNAPSHOTS BRAIN STUDIO DEPUIS RAILWAY
 * ============================================================
 *
 * Cette route remplace la dépendance à WorldCupMatch/Base44.
 * Elle fournit au Ticket du jour la même source que Brain Studio :
 * la table predictions et ses snapshots enregistrés dans Railway.
 */
app.get(
  "/public/studio/upcoming",
  async (req, res) => {
    try {
      await ensureBilanV3Columns();

      const requestedDate = String(
        req.query.date || ""
      ).trim();

      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        return res.status(400).json({
          ok: false,
          error:
            "Le paramètre date est obligatoire au format YYYY-MM-DD.",
        });
      }

      const requestedLimit = Number(req.query.limit);
      const limit = Math.max(
        1,
        Math.min(
          1000,
          Number.isFinite(requestedLimit)
            ? Math.trunc(requestedLimit)
            : 500
        )
      );

      const result = await pool.query(
        `
          SELECT DISTINCT ON (fixture_id)
            fixture_id,
            fixture_date,
            league_id,
            league_name,
            home_team_name,
            away_team_name,
            result_status,

            studio_market_key,
            studio_market_label,
            studio_probability,
            studio_decision_score,
            studio_decision_type,
            studio_decision_grade,
            studio_analysis_version,
            studio_snapshot,
            studio_saved_at,

            manual_market_odd,
            manual_market_key,
            manual_odd_source,
            manual_odd_updated_at,

            updated_at
          FROM predictions
          WHERE fixture_date IS NOT NULL
            AND (fixture_date AT TIME ZONE 'Europe/Paris')::date = $1::date
          ORDER BY
            fixture_id,
            updated_at DESC NULLS LAST,
            id DESC
          LIMIT $2
        `,
        [requestedDate, limit]
      );

      const matches = result.rows.map((prediction) => {
        const snapshot =
          prediction.studio_snapshot &&
          typeof prediction.studio_snapshot === "object"
            ? JSON.parse(
                JSON.stringify(prediction.studio_snapshot)
              )
            : {};

        const manualOdd = Number(
          prediction.manual_market_odd
        );

        const manualMarketKey =
          normalizeManualOddsMarketKey(
            prediction.manual_market_key || ""
          );

        if (
          Array.isArray(snapshot.markets) &&
          Number.isFinite(manualOdd) &&
          manualOdd > 1 &&
          manualMarketKey
        ) {
          snapshot.markets = snapshot.markets.map(
            (market) => {
              const marketKey =
                normalizeManualOddsMarketKey(
                  market?.key ||
                    market?.marketKey ||
                    ""
                );

              if (marketKey !== manualMarketKey) {
                return market;
              }

              return {
                ...market,
                bookmakerOdds: manualOdd,
                manualMarketOdd: manualOdd,
                manual_market_odd: manualOdd,
                bookmaker:
                  prediction.manual_odd_source ||
                  "Admin Football AI Pro",
                bookmakerSource: "MANUAL_ADMIN",
                manualMarketKey,
                manualOddMatchesMarket: true,
                bookmakerOddUpdatedAt:
                  prediction.manual_odd_updated_at ||
                  null,
                fairOdds: {
                  ...(market?.fairOdds || {}),
                  bookmakerOdds: manualOdd,
                  manualMarketOdd: manualOdd,
                  bookmaker:
                    prediction.manual_odd_source ||
                    "Admin Football AI Pro",
                  bookmakerSource: "MANUAL_ADMIN",
                  manualMarketKey,
                  manualOddMatchesMarket: true,
                  bookmakerOddUpdatedAt:
                    prediction.manual_odd_updated_at ||
                    null,
                },
              };
            }
          );
        }

        const fixtureDate = prediction.fixture_date
          ? new Date(prediction.fixture_date)
          : null;

        const fixtureDateIsValid =
          fixtureDate &&
          !Number.isNaN(fixtureDate.getTime());

        return {
          fixture_id: Number(prediction.fixture_id),
          fixtureId: Number(prediction.fixture_id),
          id: Number(prediction.fixture_id),

          fixture_date: fixtureDateIsValid
            ? fixtureDate.toISOString()
            : null,
          date: fixtureDateIsValid
            ? fixtureDate.toISOString().slice(0, 10)
            : requestedDate,
          kickoff: fixtureDateIsValid
            ? fixtureDate.toISOString()
            : null,

          league_id:
            prediction.league_id == null
              ? null
              : Number(prediction.league_id),
          league_name: prediction.league_name || null,
          league: prediction.league_name || null,

          home_team_name:
            prediction.home_team_name || null,
          away_team_name:
            prediction.away_team_name || null,
          team_home:
            prediction.home_team_name || null,
          team_away:
            prediction.away_team_name || null,

          status: prediction.result_status || "PENDING",
          fixture_status:
            prediction.result_status || "PENDING",
          result_status:
            prediction.result_status || "PENDING",

          studioMarketKey:
            prediction.studio_market_key || null,
          studioMarketLabel:
            prediction.studio_market_label || null,
          studioProbability:
            prediction.studio_probability == null
              ? null
              : Number(prediction.studio_probability),
          studioDecisionScore:
            prediction.studio_decision_score == null
              ? null
              : Number(prediction.studio_decision_score),
          studioDecisionType:
            prediction.studio_decision_type || null,
          studioDecisionGrade:
            prediction.studio_decision_grade || null,
          studioAnalysisVersion:
            prediction.studio_analysis_version || null,
          studioSavedAt:
            prediction.studio_saved_at || null,
          studioSnapshot: snapshot,

          manualMarketOdd:
            Number.isFinite(manualOdd) && manualOdd > 1
              ? manualOdd
              : null,
          manualMarketKey:
            manualMarketKey || null,
          manualOddSource:
            prediction.manual_odd_source || null,
          manualOddUpdatedAt:
            prediction.manual_odd_updated_at || null,

          updatedAt: prediction.updated_at || null,
        };
      });

      return res.json({
        ok: true,
        date: requestedDate,
        count: matches.length,
        source: "RAILWAY_BRAIN_STUDIO",
        matches,
      });
    } catch (error) {
      console.error(
        "ERREUR /public/studio/upcoming :",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Impossible de charger les matchs Brain Studio.",
      });
    }
  }
);

app.get(
  "/public/studio-snapshot/:fixtureId",
  async (req, res) => {
    try {
      /*
       * Garantit que les colonnes des cotes manuelles
       * existent avant la requête SQL.
       */
      await ensureBilanV3Columns();

      const fixtureId = Number(
        req.params.fixtureId
      );

      if (
        !Number.isInteger(fixtureId) ||
        fixtureId <= 0
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "fixtureId invalide",
          });
      }

      const result =
        await pool.query(
          `
            SELECT
              fixture_id,
              fixture_date,
              home_team_name,
              away_team_name,
              result_status,

              studio_market_key,
              studio_market_label,
              studio_probability,
              studio_decision_score,
              studio_decision_type,
              studio_decision_grade,
              studio_analysis_version,
              studio_snapshot,
              studio_saved_at,

              manual_market_odd,
              manual_market_key,
              manual_odd_source,
              manual_odd_updated_at,

              updated_at

            FROM predictions

            WHERE fixture_id = $1

            LIMIT 1
          `,
          [fixtureId]
        );

      const prediction =
        result.rows[0];

      if (!prediction) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Prédiction Railway introuvable",
          });
      }

      const fixtureDate =
        prediction.fixture_date
          ? new Date(
              prediction.fixture_date
            )
          : null;

      const fixtureDateIsValid =
        fixtureDate &&
        !Number.isNaN(
          fixtureDate.getTime()
        );

      const locked =
        fixtureDateIsValid
          ? fixtureDate.getTime() <=
            Date.now()
          : false;

      /*
       * Copie du snapshot afin de ne pas modifier
       * directement l’objet PostgreSQL.
       */
      const snapshot =
        prediction.studio_snapshot &&
        typeof prediction.studio_snapshot ===
          "object"
          ? JSON.parse(
              JSON.stringify(
                prediction.studio_snapshot
              )
            )
          : null;

      const currentMarketKey =
        normalizeManualOddsMarketKey(
          prediction.studio_market_key ||
            snapshot?.primaryMarket?.key ||
            snapshot?.bestDecision?.key ||
            ""
        );

      const manualMarketKey =
        normalizeManualOddsMarketKey(
          prediction.manual_market_key ||
            ""
        );

      const manualOdd =
        Number(
          prediction.manual_market_odd
        );

      const normalizedCurrentMarketKey =
  normalizeManualOddsMarketKey(
    currentMarketKey
  );

const normalizedManualMarketKey =
  normalizeManualOddsMarketKey(
    manualMarketKey
  );

const manualOddIsValid =
  Number.isFinite(manualOdd) &&
  manualOdd > 1;

const manualOddMatchesMarket =
  Boolean(
    normalizedCurrentMarketKey
  ) &&
  Boolean(
    normalizedManualMarketKey
  ) &&
  normalizedCurrentMarketKey ===
    normalizedManualMarketKey;

const manualOddAvailable =
  manualOddIsValid &&
  manualOddMatchesMarket;

      /*
       * Le snapshot peut utiliser primaryMarket
       * ou bestDecision selon sa version.
       */
      const primaryMarket =
        snapshot?.primaryMarket ||
        snapshot?.bestDecision ||
        null;

      if (
        primaryMarket &&
        manualOddAvailable
      ) {
        primaryMarket.fairOdds = {
          ...(primaryMarket.fairOdds ||
            {}),

          bookmakerOdds:
            manualOdd,

          bookmaker:
            prediction.manual_odd_source ||
            "Saisie administrateur",

          bookmakerSource:
            "MANUAL_ADMIN",

          manualOddMatchesMarket:
            true,

          bookmakerOddUpdatedAt:
            prediction.manual_odd_updated_at ||
            null,
        };

        primaryMarket.bookmakerOdds =
          manualOdd;

        primaryMarket.manualMarketOdd =
          manualOdd;

        primaryMarket.manual_market_odd =
          manualOdd;
      }

      /*
       * Sécurité supplémentaire :
       * si primaryMarket et bestDecision sont
       * deux objets différents, on enrichit les deux.
       */
      if (
        snapshot?.bestDecision &&
        snapshot.bestDecision !==
          primaryMarket &&
        manualOddAvailable
      ) {
        snapshot.bestDecision.fairOdds = {
          ...(snapshot.bestDecision
            .fairOdds || {}),

          bookmakerOdds:
            manualOdd,

          bookmaker:
            prediction.manual_odd_source ||
            "Saisie administrateur",

          bookmakerSource:
            "MANUAL_ADMIN",

          manualOddMatchesMarket:
            true,

          bookmakerOddUpdatedAt:
            prediction.manual_odd_updated_at ||
            null,
        };

        snapshot.bestDecision
          .bookmakerOdds =
          manualOdd;
      }
if (
  Array.isArray(snapshot?.markets) &&
  manualOddIsValid &&
  normalizedManualMarketKey
) {
  snapshot.markets =
    snapshot.markets.map(
      (market) => {
        const normalizedSnapshotMarketKey =
          normalizeManualOddsMarketKey(
            market?.key ||
            market?.marketKey ||
            ""
          );

        const matchesManualMarket =
          Boolean(
            normalizedSnapshotMarketKey
          ) &&
          normalizedSnapshotMarketKey ===
            normalizedManualMarketKey;

        if (!matchesManualMarket) {
          return market;
        }

        return {
          ...market,

          bookmakerOdds:
            manualOdd,

          manualMarketOdd:
            manualOdd,

          manual_market_odd:
            manualOdd,

          bookmaker:
            prediction
              .manual_odd_source ||
            "Saisie administrateur",

          bookmakerSource:
            "MANUAL_ADMIN",

          manualMarketKey:
            normalizedManualMarketKey,

          manual_market_key:
            normalizedManualMarketKey,

          manualOddMatchesMarket:
            true,

          bookmakerOddUpdatedAt:
            prediction
              .manual_odd_updated_at ||
            null,

          fairOdds: {
            ...(market?.fairOdds ||
              {}),

            bookmakerOdds:
              manualOdd,

            manualMarketOdd:
              manualOdd,

            bookmaker:
              prediction
                .manual_odd_source ||
              "Saisie administrateur",

            bookmakerSource:
              "MANUAL_ADMIN",

            manualMarketKey:
              normalizedManualMarketKey,

            manualOddMatchesMarket:
              true,

            bookmakerOddUpdatedAt:
              prediction
                .manual_odd_updated_at ||
              null,
          },
        };
      }
    );
}

      const hasStudioSnapshot =
        Boolean(
          prediction
            .studio_market_key ||
          prediction
            .studio_market_label ||
          snapshot
        );

      return res.json({
        ok: true,

        fixtureId:
          prediction.fixture_id,

        match: {
          homeTeam:
            prediction
              .home_team_name ||
            null,

          awayTeam:
            prediction
              .away_team_name ||
            null,

          kickoff:
            fixtureDateIsValid
              ? fixtureDate
                  .toISOString()
              : null,

          resultStatus:
            prediction
              .result_status ||
            null,
        },

        studio: {
          available:
            hasStudioSnapshot,

          locked,

          marketKey:
            prediction
              .studio_market_key ||
            null,

          marketLabel:
            prediction
              .studio_market_label ||
            null,

          probability:
            prediction
              .studio_probability !=
            null
              ? Number(
                  prediction
                    .studio_probability
                )
              : null,

          decisionScore:
            prediction
              .studio_decision_score !=
            null
              ? Number(
                  prediction
                    .studio_decision_score
                )
              : null,

          decisionType:
            prediction
              .studio_decision_type ||
            null,

          decisionGrade:
            prediction
              .studio_decision_grade ||
            null,

          analysisVersion:
            prediction
              .studio_analysis_version ||
            null,

          savedAt:
            prediction
              .studio_saved_at ||
            null,

          snapshot,

          /*
           * Valeurs directes de secours pour le frontend.
           */
          bookmakerOdd:
            manualOddAvailable
              ? manualOdd
              : null,

          bookmakerOddSource:
            manualOddAvailable
              ? "MANUAL_ADMIN"
              : null,

          bookmaker:
            manualOddAvailable
              ? prediction
                  .manual_odd_source ||
                "Saisie administrateur"
              : null,

          bookmakerOddUpdatedAt:
            manualOddAvailable
              ? prediction
                  .manual_odd_updated_at ||
                null
              : null,

          manualOddMatchesMarket,

          bookmakerOddMismatch:
            Number.isFinite(
              manualOdd
            ) &&
            manualOdd > 1 &&
            !manualOddMatchesMarket,
        },

        updatedAt:
          prediction.updated_at ||
          null,
      });
    } catch (error) {
      console.error(
        "ERREUR LECTURE STUDIO SNAPSHOT :",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ||
            "Erreur inconnue",
        });
    }
  }
);
/*
 * ============================================================
 * BRAIN STUDIO — GÉNÉRATION AUTOMATIQUE CÔTÉ RAILWAY
 * ============================================================
 */

/*
 * Verrous Brain Studio séparés.
 *
 * - manualSnapshotRebuildRunning :
 *   protège uniquement la route manuelle de test d'un match.
 *
 * - adminStudioRebuildRunning :
 *   protège uniquement la reconstruction groupée depuis Admin.
 *
 * Le scheduler possède déjà son propre verrou :
 * studioSchedulerRunning.
 */
let manualSnapshotRebuildRunning = false;
let adminStudioRebuildRunning = false;

function studioNumber(
  value,
  fallback = 0
) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function studioClamp(
  value,
  minimum = 0,
  maximum = 100
) {
  return Math.max(
    minimum,
    Math.min(
      maximum,
      studioNumber(value)
    )
  );
}

function studioProbabilityToOdd(
  probability
) {
  const normalizedProbability =
    studioNumber(probability);

  if (normalizedProbability <= 0) {
    return null;
  }

  return Number(
    (
      100 /
      normalizedProbability
    ).toFixed(2)
  );
}

function studioRiskToScore(risk) {
  const normalizedRisk =
    String(risk || "")
      .trim()
      .toLowerCase();

  if (
    normalizedRisk.includes("faible")
  ) {
    return 30;
  }

  if (
    normalizedRisk.includes("mod")
  ) {
    return 50;
  }

  if (
    normalizedRisk.includes("élev") ||
    normalizedRisk.includes("elev")
  ) {
    return 75;
  }

  return 60;
}

function getStudioDecisionGrade(
  score
) {
  const normalizedScore =
    studioNumber(score);

  if (normalizedScore >= 75) {
    return "A";
  }

  if (normalizedScore >= 60) {
    return "B";
  }

  if (normalizedScore >= 45) {
    return "C";
  }

  return "D";
}

function getStudioDecisionStars(
  score
) {
  const normalizedScore =
    studioNumber(score);

  if (normalizedScore >= 75) {
    return 4;
  }

  if (normalizedScore >= 60) {
    return 3;
  }

  if (normalizedScore >= 45) {
    return 2;
  }

  return 1;
}

function normalizeAutomaticStudioOutcome(
  prediction = {}
) {
  const explicitOutcome =
    prediction.selected_outcome ||
    prediction.selectedOutcome ||
    null;

  if (explicitOutcome) {
    return String(explicitOutcome)
      .trim()
      .toLowerCase();
  }

  const probabilities = {
    home:
      studioNumber(
        prediction.home_probability
      ),

    draw:
      studioNumber(
        prediction.draw_probability
      ),

    away:
      studioNumber(
        prediction.away_probability
      ),
  };

  return (
    Object.entries(probabilities)
      .sort(
        (a, b) =>
          b[1] - a[1]
      )[0]?.[0] ||
    null
  );
}

function buildAutomaticStudioMarket({
  key,
  label,
  family,
  probability,
  selectedOutcome,
  prediction,
  monteCarloModel,
}) {
  const normalizedProbability =
    studioClamp(probability);

  const confidence =
    studioClamp(
      prediction.confidence
    );

  const riskScore =
    studioRiskToScore(
      prediction.risk
    );

  const normalizedBetStatus =
    String(
      prediction.bet_status ||
      prediction.betStatus ||
      "NO_BET"
    )
      .trim()
      .toUpperCase();

  const normalizedKey =
    String(key || "")
      .trim()
      .toLowerCase();

  const isSelectedOutcome =
    normalizedKey ===
    String(
      selectedOutcome || ""
    )
      .trim()
      .toLowerCase();

  const isRecommended =
    isSelectedOutcome &&
    (
      normalizedBetStatus ===
        "BET" ||
      normalizedBetStatus ===
        "VALUE_BET"
    );

  const decisionScore =
    Math.round(
      studioClamp(
        normalizedProbability * 0.55 +
        confidence * 0.35 +
        (100 - riskScore) * 0.1
      )
    );

  const fairOdd =
    studioProbabilityToOdd(
      normalizedProbability
    );

const currentMarketKey =
  normalizeManualOddsMarketKey(
    key || ""
  );

const manualMarketKey =
  normalizeManualOddsMarketKey(
    prediction.manual_market_key || ""
  );

const manualOddMatchesMarket =
  Boolean(currentMarketKey) &&
  currentMarketKey === manualMarketKey;

const manualMarketOdd =
  Number(
    prediction.manual_market_odd
  );

const manualOddAvailable =
  manualOddMatchesMarket &&
  Number.isFinite(manualMarketOdd) &&
  manualMarketOdd > 1;

const marketOdd =
  isSelectedOutcome
    ? manualOddAvailable
      ? manualMarketOdd
      : prediction.market_odd ??
        prediction.marketOdd ??
        null
    : null;

const bookmakerSource =
  manualOddAvailable
    ? prediction.manual_odd_source ||
      "Saisie administrateur"
    : marketOdd != null
      ? "API bookmaker"
      : null;

  const value =
    isSelectedOutcome
      ? prediction.value_percentage ??
        prediction.value ??
        null
      : null;

  const decisionType =
    isRecommended
      ? normalizedBetStatus
      : "NO_BET";

  const decisionGrade =
    getStudioDecisionGrade(
      decisionScore
    );

  return {
    key,
    label,
    family,

    probability:
      normalizedProbability,

    score:
      decisionScore,

    rawProbability:
      normalizedProbability,

    calibratedProbability:
      normalizedProbability,

    rawFairOdds:
      fairOdd,

    bookmakerOdds:
      marketOdd,
    bookmaker:
  bookmakerSource,

bookmakerSource:
  manualOddAvailable
    ? "MANUAL_ADMIN"
    : marketOdd != null
      ? "API_BOOKMAKER"
      : null,

manualOddMatchesMarket,

bookmakerOddUpdatedAt:
  manualOddAvailable
    ? prediction.manual_odd_updated_at ||
      null
    : null,

    valueEdge:
      value,

    expectedValue:
      value,

    expectedValuePercent:
      value,

    isValueBet:
      decisionType ===
      "VALUE_BET",

    oddsAvailable:
      marketOdd != null,

    fairOdds: {
      rawProbability:
        normalizedProbability,

      calibratedProbability:
        normalizedProbability,

      rawFairOdds:
        fairOdd,

      fairOdds:
        fairOdd,

      bookmakerOdds:
        marketOdd,

      valueEdge:
        value,

      expectedValue:
        value,

      expectedValuePercent:
        value,

      isValueBet:
        decisionType ===
        "VALUE_BET",

      oddsAvailable:
        marketOdd != null,

      quality: {
        label:
          normalizedProbability > 0
            ? "Calcul Railway"
            : "Indisponible",

        grade:
          normalizedProbability >= 60
            ? "A"
            : normalizedProbability >= 45
            ? "B"
            : normalizedProbability >= 30
            ? "C"
            : "D",

        stars:
          normalizedProbability >= 60
            ? 4
            : normalizedProbability >= 45
            ? 3
            : normalizedProbability >= 30
            ? 2
            : 1,
      },
    },

    decision: {
      score:
        decisionScore,

      grade:
        decisionGrade,

      stars:
        getStudioDecisionStars(
          decisionScore
        ),

      type:
        decisionType,

      label:
        isRecommended
          ? prediction.decision ||
            label
          : "Aucun pari recommandé",

      shortLabel:
        isRecommended
          ? "Recommandé"
          : "À éviter",

      recommendationStrength:
        isRecommended
          ? "strong"
          : "none",

      eligibleForPrudentTicket:
        isRecommended &&
        confidence >= 70 &&
        riskScore <= 50,

      eligibleForFunTicket:
        isRecommended,

      reasons:
        Array.isArray(
          prediction.decision_trace
        )
          ? prediction.decision_trace
          : [],

      warnings:
        decisionType === "NO_BET"
          ? [
              "Décision finale : NO_BET",
            ]
          : [],

      marketConsensus: {
        score:
          confidence,

        alignedVotes:
          isRecommended ? 3 : 1,

        totalVotes: 4,

        votes: [
          {
            engine:
              "Railway Probability",

            aligned:
              isSelectedOutcome,

            strength:
              normalizedProbability,

            reason:
              `Probabilité estimée : ${normalizedProbability}%`,
          },

          {
            engine:
              "Monte Carlo",

            aligned:
              Boolean(
                monteCarloModel
                  ?.simulations
              ),

            strength:
              monteCarloModel
                ?.simulations
                ? 100
                : 0,

            reason:
              monteCarloModel
                ?.simulations
                ? `${monteCarloModel.simulations} simulations`
                : "Monte Carlo indisponible",
          },

          {
            engine:
              "Risk Engine",

            aligned:
              riskScore <= 50,

            strength:
              100 - riskScore,

            reason:
              `Risque : ${
                prediction.risk ||
                "inconnu"
              }`,
          },
        ],
      },
    },

    evaluation: {
      evaluated: false,
      result: "pending",
      won: null,
    },
  };
}



/*
 * Reconstruction historique exacte depuis Brain Studio (frontend).
 *
 * Le backend fournit les fixtureId à traiter puis accepte, via une
 * route interne dédiée, le snapshot complet calculé par
 * getFootballBrainStudioAnalysis(). Cette route administrative peut
 * remplacer un snapshot après le coup d'envoi ; la route publique
 * /public/studio-snapshot/:fixtureId reste verrouillée.
 */
app.get(
  "/internal/studio-history-candidates",
  async (req, res) => {
    try {
      const requestedLimit = Number(req.query?.limit);
      const requestedOffset = Number(req.query?.offset);

      const limit = Math.max(
        1,
        Math.min(
          500,
          Number.isFinite(requestedLimit)
            ? Math.trunc(requestedLimit)
            : 100
        )
      );

      const offset = Math.max(
        0,
        Number.isFinite(requestedOffset)
          ? Math.trunc(requestedOffset)
          : 0
      );

      const pendingOnly =
        String(req.query?.pendingOnly ?? "false").toLowerCase() ===
        "true";

      const result = await pool.query(
        `
          SELECT
            fixture_id,
            fixture_date,
            home_team_name,
            away_team_name,
            result_status,
            studio_market_key,
            studio_market_label,
            studio_decision_score,
            studio_analysis_version,
            studio_saved_at
          FROM predictions
          WHERE
            fixture_date IS NOT NULL
            AND fixture_date <= NOW()
            AND (
              result_status IS NULL
              OR UPPER(result_status) IN (
                'FT',
                'AET',
                'PEN',
                'FINISHED',
                'COMPLETED'
              )
            )
            AND (
              $3::boolean = false
              OR COALESCE(studio_analysis_version, '') <>
                'brain-studio-history-v3'
            )
          ORDER BY fixture_date ASC, fixture_id ASC
          LIMIT $1
          OFFSET $2
        `,
        [limit, offset, pendingOnly]
      );

      return res.json({
        ok: true,
        limit,
        offset,
        pendingOnly,
        count: result.rows.length,
        hasMore: result.rows.length === limit,
        items: result.rows.map((row) => ({
          fixtureId: Number(row.fixture_id),
          fixtureDate: row.fixture_date || null,
          homeTeam: row.home_team_name || null,
          awayTeam: row.away_team_name || null,
          resultStatus: row.result_status || null,
          currentSnapshot: {
            marketKey: row.studio_market_key || null,
            marketLabel: row.studio_market_label || null,
            decisionScore:
              row.studio_decision_score != null
                ? Number(row.studio_decision_score)
                : null,
            analysisVersion: row.studio_analysis_version || null,
            savedAt: row.studio_saved_at || null,
          },
        })),
      });
    } catch (error) {
      console.error(
        "ERREUR LISTE RECONSTRUCTION STUDIO :",
        error
      );

      return res.status(500).json({
        ok: false,
        error: error?.message || "Erreur inconnue",
      });
    }
  }
);

app.post(
  "/internal/force-studio-snapshot/:fixtureId",
  async (req, res) => {
    try {
      const fixtureId = Number(req.params.fixtureId);

      if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "fixtureId invalide",
        });
      }

      const body = req.body || {};
      const markets = Array.isArray(body.markets)
        ? body.markets.filter(Boolean)
        : [];

      const marketScore = (market) => {
        const value = Number(
          market?.decision?.score ?? market?.score ?? 0
        );
        return Number.isFinite(value) ? value : 0;
      };

      const marketProbability = (market) => {
        const value = Number(
          market?.fairOdds?.calibratedProbability ??
            market?.calibratedProbability ??
            market?.probability ??
            0
        );
        return Number.isFinite(value) ? value : 0;
      };

      const sortedMarkets = [...markets].sort((a, b) => {
        const scoreDifference = marketScore(b) - marketScore(a);
        if (scoreDifference !== 0) return scoreDifference;
        return marketProbability(b) - marketProbability(a);
      });

      const primaryMarket =
        sortedMarkets[0] ||
        body.primaryMarket ||
        body.bestDecision ||
        null;

      if (!primaryMarket) {
        return res.status(400).json({
          ok: false,
          error: "Aucun marché Brain Studio fourni",
        });
      }

      const predictionResult = await pool.query(
        `
          SELECT
            fixture_id,
            fixture_date,
            studio_market_key,
            studio_market_label,
            studio_decision_score,
            studio_saved_at
          FROM predictions
          WHERE fixture_id = $1
          LIMIT 1
        `,
        [fixtureId]
      );

      const prediction = predictionResult.rows[0];

      if (!prediction) {
        return res.status(404).json({
          ok: false,
          error: "Prédiction Railway introuvable",
        });
      }

      const fixtureDate = prediction.fixture_date
        ? new Date(prediction.fixture_date)
        : null;

      const snapshot = {
        primaryMarket,
        bestDecision: primaryMarket,
        markets: sortedMarkets.length
          ? sortedMarkets
          : [primaryMarket],
        generatedAt:
          body.generatedAt || new Date().toISOString(),
        fixtureDate:
          fixtureDate && !Number.isNaN(fixtureDate.getTime())
            ? fixtureDate.toISOString()
            : null,
        locked: true,
        rebuilt: true,
        rebuiltAt: new Date().toISOString(),
        rebuildSource: "FOOTBALL_BRAIN_STUDIO_SERVICE",
        historicalSafeMode: false,
        administrativeOverride: true,
      };

      const saved = await saveStudioSnapshot({
        fixtureId,
        marketKey: primaryMarket.key,
        marketLabel: primaryMarket.label,
        probability: marketProbability(primaryMarket),
        decisionScore: marketScore(primaryMarket),
        decisionType: primaryMarket?.decision?.type,
        decisionGrade: primaryMarket?.decision?.grade,
        analysisVersion:
          body.analysisVersion ||
          body.version ||
          "brain-studio-history-v3",
        snapshot,
      });

      return res.json({
        ok: true,
        forced: true,
        fixtureId,
        previousSnapshot: {
          marketKey: prediction.studio_market_key || null,
          marketLabel: prediction.studio_market_label || null,
          decisionScore:
            prediction.studio_decision_score != null
              ? Number(prediction.studio_decision_score)
              : null,
          savedAt: prediction.studio_saved_at || null,
        },
        primaryMarket,
        marketsCount: snapshot.markets.length,
        prediction: saved,
      });
    } catch (error) {
      console.error(
        "ERREUR FORCE STUDIO SNAPSHOT :",
        error
      );

      return res.status(500).json({
        ok: false,
        error: error?.message || "Erreur inconnue",
      });
    }
  }
);

function buildAutomaticStudioSnapshot(
  prediction
) {
  const monteCarloModel =
    prediction.monte_carlo_model &&
    typeof prediction
      .monte_carlo_model ===
      "object"
      ? prediction
          .monte_carlo_model
      : {};

  const selectedOutcome =
    normalizeAutomaticStudioOutcome(
      prediction
    );

  const homeName =
    prediction.home_team_name ||
    "Domicile";

  const awayName =
    prediction.away_team_name ||
    "Extérieur";

  const markets = [
    buildAutomaticStudioMarket({
      key: "HOME",

      label:
        `Victoire ${homeName}`,

      family: "1x2",

      probability:
        prediction.home_probability,

      selectedOutcome,
      prediction,
      monteCarloModel,
    }),

    buildAutomaticStudioMarket({
      key: "DRAW",
      label: "Match nul",
      family: "1x2",

      probability:
        prediction.draw_probability,

      selectedOutcome,
      prediction,
      monteCarloModel,
    }),

    buildAutomaticStudioMarket({
      key: "AWAY",

      label:
        `Victoire ${awayName}`,

      family: "1x2",

      probability:
        prediction.away_probability,

      selectedOutcome,
      prediction,
      monteCarloModel,
    }),
  ];

  const bttsProbability =
    Number(
      monteCarloModel.btts
    );

  if (
    Number.isFinite(
      bttsProbability
    )
  ) {
    markets.push(
      buildAutomaticStudioMarket({
        key: "BTTS",

        label:
          "Les deux équipes marquent",

        family: "goals",

        probability:
          bttsProbability,

        selectedOutcome,
        prediction,
        monteCarloModel,
      })
    );
  }

  const over25Probability =
    Number(
      monteCarloModel.over25
    );

  if (
    Number.isFinite(
      over25Probability
    )
  ) {
    markets.push(
      buildAutomaticStudioMarket({
        key: "OVER25",

        label:
          "Plus de 2.5 buts",

        family: "goals",

        probability:
          over25Probability,

        selectedOutcome,
        prediction,
        monteCarloModel,
      }),

      buildAutomaticStudioMarket({
        key: "UNDER25",

        label:
          "Moins de 2.5 buts",

        family: "goals",

        probability:
          Math.max(
            0,
            100 -
              over25Probability
          ),

        selectedOutcome,
        prediction,
        monteCarloModel,
      })
    );
  }

  const sortedMarkets =
    [...markets].sort(
      (a, b) => {
        const scoreDifference =
          studioNumber(
            b?.decision?.score
          ) -
          studioNumber(
            a?.decision?.score
          );

        if (
          scoreDifference !== 0
        ) {
          return scoreDifference;
        }

        return (
          studioNumber(
            b?.fairOdds
              ?.calibratedProbability
          ) -
          studioNumber(
            a?.fairOdds
              ?.calibratedProbability
          )
        );
      }
    );

  const primaryMarket =
    sortedMarkets[0] ||
    null;

  return {
    version:
      "brain-studio-railway-v1",

    generatedAt:
      new Date().toISOString(),

    fixtureId:
      prediction.fixture_id,

    match: {
      fixtureId:
        prediction.fixture_id,

      date:
        prediction.fixture_date,

      league:
        prediction.league_name,

      homeTeam:
        homeName,

      awayTeam:
        awayName,
    },

    selectedOutcome,

    primaryMarket,

    bestDecision:
      primaryMarket,

    markets:
      sortedMarkets,

    context:
      prediction.analysis_context ||
      null,

    modelInputs:
      prediction.model_inputs ||
      null,

    monteCarloModel,

    decisionTrace:
      Array.isArray(
        prediction.decision_trace
      )
        ? prediction.decision_trace
        : [],
  };
}

async function rebuildAutomaticStudioSnapshot(
  fixtureId,
  { allowHistorical = false } = {}
) {
  const normalizedFixtureId =
    Number(fixtureId);

  if (
    !Number.isInteger(
      normalizedFixtureId
    ) ||
    normalizedFixtureId <= 0
  ) {
    throw new Error(
      "fixtureId invalide"
    );
  }

  /*
   * Recharge l’analyse générale avant
   * de fabriquer Brain Studio.
   */
  const baseUrl =
    `http://127.0.0.1:${PORT}`;

  const analysisResponse =
    await fetch(
      `${baseUrl}/internal/analyze/${normalizedFixtureId}?refresh=1`,
      {
        method: "GET",

        headers: {
          Accept:
            "application/json",
        },
      }
    );

  const analysisData =
    await analysisResponse.json();

  if (
    !analysisResponse.ok ||
    !analysisData?.ok
  ) {
    throw new Error(
      analysisData?.error ||
      "Impossible de rafraîchir l’analyse Railway"
    );
  }

  const predictionResult =
    await pool.query(
      `
        SELECT
          fixture_id,
          fixture_date,

          league_id,
          league_name,

          home_team_id,
          home_team_name,
          away_team_id,
          away_team_name,

          decision,
          selected_outcome,
          bet_status,

          confidence,
          risk,

          home_probability,
          draw_probability,
          away_probability,

          fair_odd,
          market_odd,
          value_percentage,

          decision_trace,
          model_inputs,
          monte_carlo_model,
          analysis_context,

          result_status,

          studio_saved_at,
          created_at,
          updated_at
        FROM predictions
        WHERE fixture_id = $1
        LIMIT 1
      `,
      [
        normalizedFixtureId,
      ]
    );

  const prediction =
    predictionResult.rows[0];

  if (!prediction) {
    throw new Error(
      "Prédiction Railway introuvable"
    );
  }

  const kickoff =
    prediction.fixture_date
      ? new Date(
          prediction.fixture_date
        )
      : null;

  if (
    kickoff &&
    !Number.isNaN(
      kickoff.getTime()
    ) &&
    kickoff.getTime() <=
      Date.now() &&
    !allowHistorical
  ) {
    return {
      fixtureId:
        normalizedFixtureId,

      locked: true,
      saved: false,

      reason:
        "MATCH_STARTED",
    };
  }

  const studioSnapshot =
    buildAutomaticStudioSnapshot(
      prediction
    );

  const primaryMarket =
    studioSnapshot.primaryMarket;

  if (!primaryMarket) {
    throw new Error(
      "Aucun marché Brain Studio disponible"
    );
  }

  const saved =
    await saveStudioSnapshot({
      fixtureId:
        normalizedFixtureId,

      marketKey:
        primaryMarket.key,

      marketLabel:
        primaryMarket.label,

      probability:
        primaryMarket
          ?.fairOdds
          ?.calibratedProbability ??
        primaryMarket.probability,

      decisionScore:
        primaryMarket
          ?.decision
          ?.score ??
        primaryMarket.score,

      decisionType:
        primaryMarket
          ?.decision
          ?.type,

      decisionGrade:
        primaryMarket
          ?.decision
          ?.grade,

      analysisVersion:
        studioSnapshot.version,

      snapshot:
        studioSnapshot,
    });

  return {
    fixtureId:
      normalizedFixtureId,

    locked: false,
    saved: true,

    primaryMarket,

    prediction:
      saved,
  };
}

/*
 * Route manuelle de test.
 *
 * Exemple :
 * /internal/rebuild-studio-snapshot/123456
 */
app.get(
  "/internal/rebuild-studio-snapshot/:fixtureId",
  async (req, res) => {
    if (
  manualSnapshotRebuildRunning
) {
      return res
        .status(409)
        .json({
          ok: false,
          error:
            "Une reconstruction Brain Studio est déjà en cours",
        });
    }

manualSnapshotRebuildRunning =
  true;
    try {
      const result =
        await rebuildAutomaticStudioSnapshot(
          req.params.fixtureId
        );

      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      console.error(
        "ERREUR REBUILD BRAIN STUDIO :",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ||
            "Erreur inconnue",
        });
    } finally {
      manualSnapshotRebuildRunning =
  false;
    }
  }
);
/*
 * ============================================================
 * BRAIN STUDIO — SCHEDULER INTELLIGENT
 * ============================================================
 *
 * Fonctionnement :
 *
 * - vérification toutes les 15 minutes ;
 * - sélection des matchs qui débutent dans moins de 3 heures ;
 * - exclusion des matchs déjà commencés ou terminés ;
 * - exclusion des snapshots actualisés trop récemment ;
 * - recalcul un match après l’autre ;
 * - pause entre les matchs pour protéger API-Football ;
 * - verrouillage naturel au coup d’envoi.
 */

const STUDIO_SCHEDULER_INTERVAL_MS =
  15 * 60 * 1000;

const STUDIO_SCHEDULER_FIRST_RUN_DELAY_MS =
  3 * 60 * 1000;

const STUDIO_SCHEDULER_LOOKAHEAD_HOURS =
  24;

const STUDIO_SCHEDULER_REFRESH_MINUTES =
  12;

const STUDIO_SCHEDULER_MAX_MATCHES =
  100;

const STUDIO_SCHEDULER_DELAY_BETWEEN_MATCHES_MS =
  8000;

let studioSchedulerRunning =
  false;

let studioSchedulerLastStartedAt =
  null;

let studioSchedulerLastFinishedAt =
  null;

let studioSchedulerLastSummary =
  null;

function waitStudioScheduler(
  milliseconds
) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        milliseconds
      )
  );
}

function normalizeSchedulerStatus(
  value
) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function isFinishedSchedulerStatus(
  status
) {
  const normalized =
    normalizeSchedulerStatus(
      status
    );

  return new Set([
    "FT",
    "AET",
    "PEN",
    "FINISHED",
    "COMPLETED",
    "CANCELLED",
    "CANCELED",
    "PST",
    "POSTPONED",
    "ABD",
    "ABANDONED",
    "AWD",
    "WO",
  ]).has(normalized);
}

async function getUpcomingStudioFixtures({
  lookaheadHours =
    STUDIO_SCHEDULER_LOOKAHEAD_HOURS,

  refreshMinutes =
    STUDIO_SCHEDULER_REFRESH_MINUTES,

  limit =
    STUDIO_SCHEDULER_MAX_MATCHES,
} = {}) {
  const normalizedLookahead =
    Math.max(
      1,
      Math.min(
        24,
        Number(lookaheadHours) ||
          STUDIO_SCHEDULER_LOOKAHEAD_HOURS
      )
    );

  const normalizedRefreshMinutes =
    Math.max(
      5,
      Math.min(
        180,
        Number(refreshMinutes) ||
          STUDIO_SCHEDULER_REFRESH_MINUTES
      )
    );

  const normalizedLimit =
    Math.max(
      1,
      Math.min(
        100,
        Number(limit) ||
          STUDIO_SCHEDULER_MAX_MATCHES
      )
    );

  const result =
    await pool.query(
      `
        SELECT
          fixture_id,
          fixture_date,

          league_id,
          league_name,

          home_team_name,
          away_team_name,

          result_status,

          studio_market_key,
          studio_market_label,
          studio_probability,
          studio_decision_score,
          studio_decision_type,
          studio_decision_grade,
          studio_analysis_version,
          studio_saved_at,

          created_at,
          updated_at

        FROM predictions

        WHERE
          fixture_date IS NOT NULL

          /*
           * Match pas encore commencé.
           */
          AND fixture_date > NOW()

          /*
           * Match dans les prochaines heures.
           */
          AND fixture_date <=
            NOW() +
            ($1 * INTERVAL '1 hour')

          /*
           * Ne pas recalculer les matchs
           * explicitement terminés ou annulés.
           */
          AND (
            result_status IS NULL
            OR UPPER(
              result_status
            ) NOT IN (
              'FT',
              'AET',
              'PEN',
              'FINISHED',
              'COMPLETED',
              'CANCELLED',
              'CANCELED',
              'PST',
              'POSTPONED',
              'ABD',
              'ABANDONED',
              'AWD',
              'WO'
            )
          )

          /*
           * Premier snapshot ou snapshot
           * suffisamment ancien.
           */
          AND (
            studio_saved_at IS NULL
            OR studio_saved_at <=
              NOW() -
              ($2 * INTERVAL '1 minute')
          )

        ORDER BY
          fixture_date ASC

        LIMIT $3
      `,
      [
        normalizedLookahead,
        normalizedRefreshMinutes,
        normalizedLimit,
      ]
    );

  return result.rows;
}

async function runAutomaticStudioScheduler({
  source = "scheduler",

  force = false,

  lookaheadHours =
    STUDIO_SCHEDULER_LOOKAHEAD_HOURS,

  refreshMinutes =
    STUDIO_SCHEDULER_REFRESH_MINUTES,

  limit =
    STUDIO_SCHEDULER_MAX_MATCHES,
} = {}) {
  if (studioSchedulerRunning) {
    console.log(
      "BRAIN STUDIO SCHEDULER : cycle déjà actif"
    );

    return {
      ok: true,
      skipped: true,
      reason:
        "ALREADY_RUNNING",
      source,
    };
  }

  studioSchedulerRunning =
    true;

  studioSchedulerLastStartedAt =
    new Date().toISOString();

  const summary = {
    ok: true,
    source,

    startedAt:
      studioSchedulerLastStartedAt,

    finishedAt: null,

    lookaheadHours:
      Number(lookaheadHours),

    refreshMinutes:
      Number(refreshMinutes),

    force:
      Boolean(force),

    fixturesFound: 0,
    attempted: 0,
    saved: 0,
    locked: 0,
    skipped: 0,
    failed: 0,

    results: [],
  };

  try {
    let fixtures = [];

    if (force) {
      /*
       * En mode force, on ignore la date
       * du dernier snapshot, mais jamais
       * le coup d’envoi.
       */
      const forcedResult =
        await pool.query(
          `
            SELECT
              fixture_id,
              fixture_date,

              league_id,
              league_name,

              home_team_name,
              away_team_name,

              result_status,

              studio_saved_at,

              created_at,
              updated_at

            FROM predictions

            WHERE
              fixture_date IS NOT NULL

              AND fixture_date > NOW()

              AND fixture_date <=
                NOW() +
                ($1 * INTERVAL '1 hour')

              AND (
                result_status IS NULL
                OR UPPER(
                  result_status
                ) NOT IN (
                  'FT',
                  'AET',
                  'PEN',
                  'FINISHED',
                  'COMPLETED',
                  'CANCELLED',
                  'CANCELED',
                  'PST',
                  'POSTPONED',
                  'ABD',
                  'ABANDONED',
                  'AWD',
                  'WO'
                )
              )

            ORDER BY
              fixture_date ASC

            LIMIT $2
          `,
          [
            Math.max(
              1,
              Math.min(
                24,
                Number(
                  lookaheadHours
                ) ||
                  STUDIO_SCHEDULER_LOOKAHEAD_HOURS
              )
            ),

            Math.max(
              1,
              Math.min(
                100,
                Number(limit) ||
                  STUDIO_SCHEDULER_MAX_MATCHES
              )
            ),
          ]
        );

      fixtures =
        forcedResult.rows;
    } else {
      fixtures =
        await getUpcomingStudioFixtures({
          lookaheadHours,
          refreshMinutes,
          limit,
        });
    }

    summary.fixturesFound =
      fixtures.length;

    console.log(
      "BRAIN STUDIO SCHEDULER : démarrage",
      {
        source,
        fixturesFound:
          fixtures.length,
        lookaheadHours,
        refreshMinutes,
        force,
      }
    );

    for (
      let index = 0;
      index < fixtures.length;
      index += 1
    ) {
      const fixture =
        fixtures[index];

      const fixtureId =
        Number(
          fixture.fixture_id
        );

      const matchLabel =
        `${fixture.home_team_name || "Domicile"}` +
        " vs " +
        `${fixture.away_team_name || "Extérieur"}`;

      const kickoff =
        fixture.fixture_date
          ? new Date(
              fixture.fixture_date
            )
          : null;

      /*
       * Deuxième sécurité :
       * le match a pu commencer pendant
       * l’exécution du scheduler.
       */
      if (
        kickoff &&
        !Number.isNaN(
          kickoff.getTime()
        ) &&
        kickoff.getTime() <=
          Date.now()
      ) {
        summary.locked += 1;

        summary.results.push({
          fixtureId,
          match:
            matchLabel,
          ok: true,
          saved: false,
          locked: true,
          reason:
            "MATCH_STARTED",
        });

        continue;
      }

      if (
        isFinishedSchedulerStatus(
          fixture.result_status
        )
      ) {
        summary.skipped += 1;

        summary.results.push({
          fixtureId,
          match:
            matchLabel,
          ok: true,
          saved: false,
          skipped: true,
          reason:
            "FINISHED_STATUS",
        });

        continue;
      }

      summary.attempted += 1;

      try {
        console.log(
          `BRAIN STUDIO SCHEDULER : analyse ${index + 1}/${fixtures.length}`,
          {
            fixtureId,
            match:
              matchLabel,
            kickoff:
              fixture.fixture_date,
          }
        );

        const result =
          await rebuildAutomaticStudioSnapshot(
            fixtureId
          );

        if (result?.locked) {
          summary.locked += 1;
        } else if (result?.saved) {
          summary.saved += 1;
        } else {
          summary.skipped += 1;
        }

        summary.results.push({
          fixtureId,
          match:
            matchLabel,
          ok: true,

          saved:
            result?.saved ===
            true,

          locked:
            result?.locked ===
            true,

          reason:
            result?.reason ||
            null,

          primaryMarket:
            result?.primaryMarket
              ? {
                  key:
                    result
                      .primaryMarket
                      .key,

                  label:
                    result
                      .primaryMarket
                      .label,

                  probability:
                    result
                      .primaryMarket
                      ?.fairOdds
                      ?.calibratedProbability ??
                    result
                      .primaryMarket
                      ?.probability ??
                    null,

                  decisionScore:
                    result
                      .primaryMarket
                      ?.decision
                      ?.score ??
                    result
                      .primaryMarket
                      ?.score ??
                    null,

                  decisionType:
                    result
                      .primaryMarket
                      ?.decision
                      ?.type ??
                    null,
                }
              : null,
        });
      } catch (error) {
        summary.failed += 1;

        summary.results.push({
          fixtureId,
          match:
            matchLabel,
          ok: false,

          error:
            error?.message ||
            "Erreur inconnue",
        });

        console.error(
          `BRAIN STUDIO SCHEDULER : erreur fixture ${fixtureId}`,
          error
        );
      }

      /*
       * Protection contre les appels trop
       * rapprochés à API-Football.
       */
      if (
        index <
        fixtures.length - 1
      ) {
        await waitStudioScheduler(
          STUDIO_SCHEDULER_DELAY_BETWEEN_MATCHES_MS
        );
      }
    }

    summary.finishedAt =
      new Date().toISOString();

    studioSchedulerLastFinishedAt =
      summary.finishedAt;

    studioSchedulerLastSummary =
      summary;

    console.log(
      "BRAIN STUDIO SCHEDULER : terminé",
      {
        fixturesFound:
          summary.fixturesFound,
        attempted:
          summary.attempted,
        saved:
          summary.saved,
        locked:
          summary.locked,
        skipped:
          summary.skipped,
        failed:
          summary.failed,
      }
    );

    return summary;
  } catch (error) {
    summary.ok = false;
    summary.failed += 1;

    summary.error =
      error?.message ||
      "Erreur inconnue";

    summary.finishedAt =
      new Date().toISOString();

    studioSchedulerLastFinishedAt =
      summary.finishedAt;

    studioSchedulerLastSummary =
      summary;

    console.error(
      "BRAIN STUDIO SCHEDULER : erreur générale",
      error
    );

    return summary;
  } finally {
    studioSchedulerRunning =
      false;
  }
}

/*
 * Route permettant de lancer manuellement
 * un cycle complet du scheduler.
 *
 * Exemples :
 *
 * /internal/run-studio-scheduler
 *
 * /internal/run-studio-scheduler?force=1
 *
 * /internal/run-studio-scheduler?hours=6&limit=10
 */
app.get(
  "/internal/run-studio-scheduler",
  async (req, res) => {
    const force =
      req.query.force === "1" ||
      req.query.force === "true";

    const lookaheadHours =
      Number(
        req.query.hours
      ) ||
      STUDIO_SCHEDULER_LOOKAHEAD_HOURS;

    const refreshMinutes =
      Number(
        req.query.refreshMinutes
      ) ||
      STUDIO_SCHEDULER_REFRESH_MINUTES;

    const limit =
      Number(
        req.query.limit
      ) ||
      STUDIO_SCHEDULER_MAX_MATCHES;

    const summary =
      await runAutomaticStudioScheduler({
        source:
          "manual-route",

        force,
        lookaheadHours,
        refreshMinutes,
        limit,
      });

    return res
      .status(
        summary.ok
          ? 200
          : 500
      )
      .json(summary);
  }
);

/*
 * Route de surveillance du scheduler.
 */
app.get(
  "/internal/studio-scheduler-status",
  async (req, res) => {
    try {
      const upcomingFixtures =
        await getUpcomingStudioFixtures({
          limit: 10,
        });

      return res.json({
        ok: true,

        running:
          studioSchedulerRunning,

        configuration: {
          intervalMinutes:
            STUDIO_SCHEDULER_INTERVAL_MS /
            60000,

          firstRunDelayMinutes:
            STUDIO_SCHEDULER_FIRST_RUN_DELAY_MS /
            60000,

          lookaheadHours:
            STUDIO_SCHEDULER_LOOKAHEAD_HOURS,

          refreshMinutes:
            STUDIO_SCHEDULER_REFRESH_MINUTES,

          maxMatches:
            STUDIO_SCHEDULER_MAX_MATCHES,

          delayBetweenMatchesMs:
            STUDIO_SCHEDULER_DELAY_BETWEEN_MATCHES_MS,
        },

        lastStartedAt:
          studioSchedulerLastStartedAt,

        lastFinishedAt:
          studioSchedulerLastFinishedAt,

        lastSummary:
          studioSchedulerLastSummary,

        upcomingCount:
          upcomingFixtures.length,

        upcomingFixtures:
          upcomingFixtures.map(
            (fixture) => ({
              fixtureId:
                fixture.fixture_id,

              kickoff:
                fixture.fixture_date,

              league:
                fixture.league_name,

              homeTeam:
                fixture.home_team_name,

              awayTeam:
                fixture.away_team_name,

              studioSavedAt:
                fixture.studio_saved_at,
            })
          ),
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ||
            "Impossible de lire le statut du scheduler",
        });
    }
  }
);
    /*
 * ============================================================
 * FOOTBALLBRAIN — CALIBRATION ENGINE V1
 * ============================================================
 *
 * Le moteur apprend uniquement à partir de :
 * - la probabilité annoncée ;
 * - le résultat réel ;
 * - le marché ;
 * - la tranche de probabilité.
 *
 * Le ROI, les cotes, les grades et le type de décision ne participent
 * jamais au calcul de calibration. Ils restent disponibles ailleurs
 * pour l'affichage et pour le futur Value Engine.
 */

let learningEngineRunning = false;

const LEARNING_ENGINE_VERSION =
  "calibration-engine-v1.0";

const LEARNING_MODEL_VERSION =
  process.env.LEARNING_MODEL_VERSION ||
  "footballbrain-calibration-v1-buckets-5";

const CALIBRATION_BUCKET_SIZE = 5;
const CALIBRATION_MIN_PROBABILITY = 50;
const CALIBRATION_MAX_PROBABILITY = 100;
const CALIBRATION_MIN_SAMPLE_SIZE = 20;
const CALIBRATION_MAX_ADJUSTMENT = 3;

/*
 * Par sécurité, la V1 observe et calcule par défaut sans modifier les
 * probabilités de production. Pour l'activer plus tard sur Railway :
 * CALIBRATION_APPLY_ENABLED=true
 */
const CALIBRATION_APPLY_ENABLED = [
  "1",
  "true",
  "yes",
  "oui",
  "on",
].includes(
  String(process.env.CALIBRATION_APPLY_ENABLED || "false")
    .trim()
    .toLowerCase()
);

function clampLearningNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function parseLearningBoolean(value) {
  return ["1", "true", "yes", "oui", "on"].includes(
    String(value ?? "").trim().toLowerCase()
  );
}

function normalizeAdaptiveLearningKey(value) {
  return String(value || "").trim().toUpperCase();
}

function getCalibrationBucket(probability) {
  const normalized = clampLearningNumber(
    probability,
    CALIBRATION_MIN_PROBABILITY,
    CALIBRATION_MAX_PROBABILITY
  );

  const lower = Math.min(
    95,
    Math.floor(normalized / CALIBRATION_BUCKET_SIZE) *
      CALIBRATION_BUCKET_SIZE
  );
  const upper = Math.min(100, lower + CALIBRATION_BUCKET_SIZE);

  return {
    key: `${lower}-${upper}`,
    lower,
    upper,
  };
}

function getLearningReliabilityLevel(sampleSize) {
  const count = Number(sampleSize) || 0;
  if (count >= 1000) return "VERY_HIGH";
  if (count >= 300) return "HIGH";
  if (count >= 100) return "MEDIUM";
  if (count >= 30) return "LOW";
  return "VERY_LOW";
}

function getCalibrationConfidenceFactor(sampleSize) {
  const count = Number(sampleSize) || 0;
  if (count < CALIBRATION_MIN_SAMPLE_SIZE) return 0;
  if (count < 30) return 0.1;
  if (count < 100) return 0.25;
  if (count < 300) return 0.5;
  if (count < 1000) return 0.75;
  return 1;
}

function calculateCalibrationAdjustment(stat = {}) {
  const sampleSize = Number(stat.sample_size ?? stat.sampleSize) || 0;
  const predictedMean =
    Number(stat.predicted_mean ?? stat.predictedMean) || 0;
  const actualMean = Number(stat.actual_mean ?? stat.actualMean) || 0;
  const calibrationGap = Number(
    stat.calibration_gap ??
      stat.calibrationGap ??
      actualMean - predictedMean
  );

  const confidenceFactor = getCalibrationConfidenceFactor(sampleSize);

  if (confidenceFactor <= 0) {
    return {
      adjustment: 0,
      proposedAdjustment: 0,
      appliedWeight: 1,
      reason: "INSUFFICIENT_SAMPLE",
    };
  }

  /*
   * Le gap donne la direction de la correction. Brier et Log Loss sont
   * des mesures de qualité : ils sont enregistrés et surveillés, mais ne
   * doivent pas inventer une direction artificielle à la correction.
   */
  const proposedAdjustment = clampLearningNumber(
    calibrationGap * confidenceFactor,
    -CALIBRATION_MAX_ADJUSTMENT,
    CALIBRATION_MAX_ADJUSTMENT
  );

  const adjustment = CALIBRATION_APPLY_ENABLED
    ? proposedAdjustment
    : 0;

  return {
    adjustment: Number(adjustment.toFixed(3)),
    proposedAdjustment: Number(proposedAdjustment.toFixed(3)),
    appliedWeight: Number(
      clampLearningNumber(1 + adjustment / 100, 0.97, 1.03).toFixed(5)
    ),
    reason: CALIBRATION_APPLY_ENABLED
      ? "CALIBRATION_APPLIED"
      : "CALIBRATION_OBSERVATION_ONLY",
  };
}

async function ensureLearningEngineTables() {
  await pool.query(`
    ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS studio_base_probability NUMERIC(7,3),
      ADD COLUMN IF NOT EXISTS learning_probability_adjustment NUMERIC(7,3),
      ADD COLUMN IF NOT EXISTS learning_applied_weight NUMERIC(8,5),
      ADD COLUMN IF NOT EXISTS learning_engine_version TEXT,
      ADD COLUMN IF NOT EXISTS learning_applied_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS calibration_bucket TEXT,
      ADD COLUMN IF NOT EXISTS calibration_confidence TEXT;

    CREATE TABLE IF NOT EXISTS learning_calibration (
      id BIGSERIAL PRIMARY KEY,
      market_key TEXT NOT NULL,
      probability_bucket TEXT NOT NULL,
      bucket_lower NUMERIC(7,3) NOT NULL,
      bucket_upper NUMERIC(7,3) NOT NULL,
      sample_size INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      predicted_mean NUMERIC(9,5) NOT NULL DEFAULT 0,
      actual_mean NUMERIC(9,5) NOT NULL DEFAULT 0,
      calibration_gap NUMERIC(9,5) NOT NULL DEFAULT 0,
      brier_score NUMERIC(12,8) NOT NULL DEFAULT 0,
      log_loss NUMERIC(12,8) NOT NULL DEFAULT 0,
      accuracy NUMERIC(9,5) NOT NULL DEFAULT 0,
      proposed_adjustment NUMERIC(9,5) NOT NULL DEFAULT 0,
      applied_adjustment NUMERIC(9,5) NOT NULL DEFAULT 0,
      confidence TEXT NOT NULL DEFAULT 'VERY_LOW',
      engine_version TEXT NOT NULL,
      model_version TEXT NOT NULL,
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (market_key, probability_bucket)
    );

    CREATE TABLE IF NOT EXISTS learning_history (
      id BIGSERIAL PRIMARY KEY,
      market_key TEXT NOT NULL,
      probability_bucket TEXT NOT NULL,
      previous_adjustment NUMERIC(9,5),
      new_adjustment NUMERIC(9,5) NOT NULL,
      previous_sample_size INTEGER,
      sample_size INTEGER NOT NULL DEFAULT 0,
      predicted_mean NUMERIC(9,5),
      actual_mean NUMERIC(9,5),
      calibration_gap NUMERIC(9,5),
      brier_score NUMERIC(12,8),
      log_loss NUMERIC(12,8),
      confidence TEXT,
      engine_version TEXT NOT NULL,
      model_version TEXT NOT NULL,
      run_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS calibration_runs (
      id BIGSERIAL PRIMARY KEY,
      engine_version TEXT NOT NULL,
      predictions_found INTEGER NOT NULL DEFAULT 0,
      groups_calculated INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'RUNNING',
      error_message TEXT,
      summary JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE calibration_runs
      ADD COLUMN IF NOT EXISTS run_mode TEXT,
      ADD COLUMN IF NOT EXISTS new_predictions INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS changed_predictions INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS data_watermark TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS skipped_reason TEXT;

    CREATE TABLE IF NOT EXISTS calibration_state (
      state_key TEXT PRIMARY KEY,
      engine_version TEXT NOT NULL,
      model_version TEXT NOT NULL,
      last_watermark TIMESTAMPTZ,
      last_prediction_count INTEGER NOT NULL DEFAULT 0,
      last_max_prediction_id BIGINT NOT NULL DEFAULT 0,
      last_fixture_date TIMESTAMPTZ,
      last_run_id BIGINT,
      last_run_started_at TIMESTAMPTZ,
      last_run_finished_at TIMESTAMPTZ,
      full_rebuild_required BOOLEAN NOT NULL DEFAULT FALSE,
      last_summary JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS learning_calibration_market_bucket_idx
      ON learning_calibration (market_key, bucket_lower, bucket_upper);

    CREATE INDEX IF NOT EXISTS learning_calibration_confidence_idx
      ON learning_calibration (confidence, sample_size DESC);

    CREATE INDEX IF NOT EXISTS learning_history_group_idx
      ON learning_history (market_key, probability_bucket, created_at DESC);

    CREATE INDEX IF NOT EXISTS calibration_runs_started_idx
      ON calibration_runs (started_at DESC);

    CREATE INDEX IF NOT EXISTS predictions_calibration_eligible_idx
      ON predictions (updated_at DESC, id DESC)
      WHERE result_status = 'COMPLETED' AND won IS NOT NULL;
  `);

  console.log("✅ Tables Calibration Engine V1 vérifiées");
}

function learningProbabilitySql() {
  return `
    COALESCE(
      studio_base_probability,
      studio_probability,
      CASE
        WHEN LOWER(COALESCE(selected_outcome, '')) = 'home'
          THEN home_probability
        WHEN LOWER(COALESCE(selected_outcome, '')) = 'draw'
          THEN draw_probability
        WHEN LOWER(COALESCE(selected_outcome, '')) = 'away'
          THEN away_probability
        ELSE NULL
      END
    )
  `;
}

function learningMarketSql() {
  return `
    UPPER(
      BTRIM(
        COALESCE(
          NULLIF(studio_market_key, ''),
          NULLIF(selected_outcome, '')
        )
      )
    )
  `;
}

function learningEligibleWhereSql() {
  const probabilitySql = learningProbabilitySql();
  const marketSql = learningMarketSql();

  return `
    result_status = 'COMPLETED'
    AND won IS NOT NULL
    AND ${marketSql} IS NOT NULL
    AND ${probabilitySql} IS NOT NULL
    AND ${probabilitySql} >= ${CALIBRATION_MIN_PROBABILITY}
    AND ${probabilitySql} <= ${CALIBRATION_MAX_PROBABILITY}
  `;
}

async function readLearningDataSignature() {
  const result = await pool.query(`
    SELECT
      COUNT(*)::INTEGER AS prediction_count,
      COALESCE(MAX(id), 0)::BIGINT AS max_prediction_id,
      MAX(updated_at) AS watermark,
      MAX(fixture_date) AS last_fixture_date
    FROM predictions
    WHERE ${learningEligibleWhereSql()}
  `);

  const row = result.rows[0] || {};
  return {
    predictionCount: Number(row.prediction_count) || 0,
    maxPredictionId: Number(row.max_prediction_id) || 0,
    watermark: row.watermark || null,
    lastFixtureDate: row.last_fixture_date || null,
  };
}

async function readLearningState() {
  const result = await pool.query(`
    SELECT * FROM calibration_state
    WHERE state_key = 'calibration-engine'
    LIMIT 1
  `);
  return result.rows[0] || null;
}

function learningSignaturesMatch(state, signature) {
  if (!state) return false;
  return (
    Number(state.last_prediction_count) === signature.predictionCount &&
    Number(state.last_max_prediction_id) === signature.maxPredictionId &&
    String(state.last_watermark || "") === String(signature.watermark || "") &&
    String(state.last_fixture_date || "") === String(signature.lastFixtureDate || "")
  );
}

async function getAdaptiveLearningAdjustment({
  marketKey,
  baseProbability,
} = {}) {
  const normalizedMarketKey = normalizeAdaptiveLearningKey(marketKey);
  const normalizedBaseProbability = clampLearningNumber(
    baseProbability,
    0,
    100
  );

  const noAdjustment = (reason) => ({
    baseProbability: Number(normalizedBaseProbability.toFixed(3)),
    adjustedProbability: Number(normalizedBaseProbability.toFixed(3)),
    adjustment: 0,
    proposedAdjustment: 0,
    appliedWeight: 1,
    applied: false,
    applyEnabled: CALIBRATION_APPLY_ENABLED,
    reason,
    engineVersion: LEARNING_ENGINE_VERSION,
    modelVersion: LEARNING_MODEL_VERSION,
    bucket: null,
    stat: null,
  });

  if (!normalizedMarketKey) return noAdjustment("MISSING_MARKET_KEY");
  if (normalizedBaseProbability < CALIBRATION_MIN_PROBABILITY) {
    return noAdjustment("PROBABILITY_BELOW_CALIBRATION_RANGE");
  }

  const bucket = getCalibrationBucket(normalizedBaseProbability);

  try {
    const result = await pool.query(
      `
        SELECT *
        FROM learning_calibration
        WHERE market_key = $1
          AND probability_bucket = $2
        LIMIT 1
      `,
      [normalizedMarketKey, bucket.key]
    );

    const stat = result.rows[0];
    if (!stat) {
      return {
        ...noAdjustment("NO_MATCHING_CALIBRATION_BUCKET"),
        bucket,
      };
    }

    const calibration = calculateCalibrationAdjustment(stat);
    const adjustedProbability = clampLearningNumber(
      normalizedBaseProbability + calibration.adjustment,
      1,
      99
    );

    return {
      baseProbability: Number(normalizedBaseProbability.toFixed(3)),
      adjustedProbability: Number(adjustedProbability.toFixed(3)),
      adjustment: calibration.adjustment,
      proposedAdjustment: calibration.proposedAdjustment,
      appliedWeight: calibration.appliedWeight,
      applied: calibration.adjustment !== 0,
      applyEnabled: CALIBRATION_APPLY_ENABLED,
      reason: calibration.reason,
      engineVersion: LEARNING_ENGINE_VERSION,
      modelVersion: LEARNING_MODEL_VERSION,
      bucket,
      stat: {
        marketKey: stat.market_key,
        probabilityBucket: stat.probability_bucket,
        sampleSize: Number(stat.sample_size) || 0,
        predictedMean: Number(stat.predicted_mean) || 0,
        actualMean: Number(stat.actual_mean) || 0,
        calibrationGap: Number(stat.calibration_gap) || 0,
        brierScore: Number(stat.brier_score) || 0,
        logLoss: Number(stat.log_loss) || 0,
        accuracy: Number(stat.accuracy) || 0,
        confidence: stat.confidence,
      },
    };
  } catch (error) {
    console.warn(
      "CALIBRATION ENGINE V1 : ajustement ignoré",
      error?.message || error
    );
    return { ...noAdjustment("CALIBRATION_LOOKUP_FAILED"), bucket };
  }
}

async function rebuildLearningEngine({
  source = "manual",
  force = false,
} = {}) {
  if (learningEngineRunning) {
    return {
      ok: false,
      skipped: true,
      reason: "CALIBRATION_ENGINE_ALREADY_RUNNING",
    };
  }

  learningEngineRunning = true;
  const startedAt = new Date();
  let runId = null;

  try {
    await ensureLearningEngineTables();

    const [state, signature] = await Promise.all([
      readLearningState(),
      readLearningDataSignature(),
    ]);

    const versionChanged =
      !state ||
      state.engine_version !== LEARNING_ENGINE_VERSION ||
      state.model_version !== LEARNING_MODEL_VERSION;

    const needsRebuild =
      force ||
      versionChanged ||
      Boolean(state?.full_rebuild_required) ||
      !learningSignaturesMatch(state, signature);

    const runResult = await pool.query(
      `
        INSERT INTO calibration_runs (
          engine_version, run_mode, predictions_found,
          started_at, status, data_watermark
        )
        VALUES ($1, $2, $3, $4, 'RUNNING', $5)
        RETURNING id
      `,
      [
        LEARNING_ENGINE_VERSION,
        force ? "FORCED" : "AUTO",
        signature.predictionCount,
        startedAt,
        signature.watermark,
      ]
    );
    runId = runResult.rows[0]?.id || null;

    if (!needsRebuild) {
      const finishedAt = new Date();
      const summary = {
        ok: true,
        skipped: true,
        source,
        reason: "NO_CALIBRATION_DATA_CHANGE",
        engineVersion: LEARNING_ENGINE_VERSION,
        modelVersion: LEARNING_MODEL_VERSION,
        applyEnabled: CALIBRATION_APPLY_ENABLED,
        signature,
        startedAt,
        finishedAt,
      };

      await pool.query(
        `
          UPDATE calibration_runs
          SET finished_at = $1, status = 'SKIPPED',
              skipped_reason = $2, summary = $3::jsonb
          WHERE id = $4
        `,
        [finishedAt, summary.reason, JSON.stringify(summary), runId]
      );
      return summary;
    }

    const probabilitySql = learningProbabilitySql();
    const marketSql = learningMarketSql();

    const result = await pool.query(`
      WITH eligible AS (
        SELECT
          ${marketSql} AS market_key,
          ${probabilitySql}::NUMERIC AS probability_pct,
          CASE WHEN won = TRUE THEN 1.0 ELSE 0.0 END AS actual,
          LEAST(
            95,
            FLOOR(${probabilitySql}::NUMERIC / ${CALIBRATION_BUCKET_SIZE}) *
              ${CALIBRATION_BUCKET_SIZE}
          )::INTEGER AS bucket_lower
        FROM predictions
        WHERE ${learningEligibleWhereSql()}
      )
      SELECT
        market_key,
        CONCAT(bucket_lower, '-', LEAST(100, bucket_lower + ${CALIBRATION_BUCKET_SIZE}))
          AS probability_bucket,
        bucket_lower,
        LEAST(100, bucket_lower + ${CALIBRATION_BUCKET_SIZE}) AS bucket_upper,
        COUNT(*)::INTEGER AS sample_size,
        COUNT(*) FILTER (WHERE actual = 1)::INTEGER AS wins,
        COUNT(*) FILTER (WHERE actual = 0)::INTEGER AS losses,
        AVG(probability_pct) AS predicted_mean,
        AVG(actual) * 100 AS actual_mean,
        (AVG(actual) * 100) - AVG(probability_pct) AS calibration_gap,
        AVG(POWER((probability_pct / 100.0) - actual, 2)) AS brier_score,
        AVG(
          -(
            actual * LN(GREATEST(0.000001, LEAST(0.999999, probability_pct / 100.0))) +
            (1 - actual) * LN(GREATEST(0.000001, LEAST(0.999999, 1 - probability_pct / 100.0)))
          )
        ) AS log_loss,
        AVG(actual) * 100 AS accuracy
      FROM eligible
      GROUP BY market_key, bucket_lower
      ORDER BY sample_size DESC, market_key, bucket_lower
    `);

    const groups = result.rows.map((row) => {
      const sampleSize = Number(row.sample_size) || 0;
      const predictedMean = Number(row.predicted_mean) || 0;
      const actualMean = Number(row.actual_mean) || 0;
      const calibrationGap = Number(row.calibration_gap) || 0;
      const confidence = getLearningReliabilityLevel(sampleSize);
      const adjustment = calculateCalibrationAdjustment({
        sampleSize,
        predictedMean,
        actualMean,
        calibrationGap,
      });

      return {
        marketKey: row.market_key,
        probabilityBucket: row.probability_bucket,
        bucketLower: Number(row.bucket_lower),
        bucketUpper: Number(row.bucket_upper),
        sampleSize,
        wins: Number(row.wins) || 0,
        losses: Number(row.losses) || 0,
        predictedMean,
        actualMean,
        calibrationGap,
        brierScore: Number(row.brier_score) || 0,
        logLoss: Number(row.log_loss) || 0,
        accuracy: Number(row.accuracy) || 0,
        proposedAdjustment: adjustment.proposedAdjustment,
        appliedAdjustment: adjustment.adjustment,
        confidence,
      };
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const previousResult = await client.query(`
        SELECT market_key, probability_bucket, sample_size,
               proposed_adjustment, applied_adjustment
        FROM learning_calibration
      `);
      const previousMap = new Map(
        previousResult.rows.map((row) => [
          `${row.market_key}::${row.probability_bucket}`,
          row,
        ])
      );

      await client.query(`DELETE FROM learning_calibration`);

      for (const group of groups) {
        await client.query(
          `
            INSERT INTO learning_calibration (
              market_key, probability_bucket, bucket_lower, bucket_upper,
              sample_size, wins, losses, predicted_mean, actual_mean,
              calibration_gap, brier_score, log_loss, accuracy,
              proposed_adjustment, applied_adjustment, confidence,
              engine_version, model_version, calculated_at, updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW()
            )
          `,
          [
            group.marketKey,
            group.probabilityBucket,
            group.bucketLower,
            group.bucketUpper,
            group.sampleSize,
            group.wins,
            group.losses,
            group.predictedMean,
            group.actualMean,
            group.calibrationGap,
            group.brierScore,
            group.logLoss,
            group.accuracy,
            group.proposedAdjustment,
            group.appliedAdjustment,
            group.confidence,
            LEARNING_ENGINE_VERSION,
            LEARNING_MODEL_VERSION,
          ]
        );

        const previous = previousMap.get(
          `${group.marketKey}::${group.probabilityBucket}`
        );

        const changed =
          !previous ||
          Number(previous.proposed_adjustment) !== group.proposedAdjustment ||
          Number(previous.sample_size) !== group.sampleSize;

        if (changed) {
          await client.query(
            `
              INSERT INTO learning_history (
                market_key, probability_bucket, previous_adjustment,
                new_adjustment, previous_sample_size, sample_size,
                predicted_mean, actual_mean, calibration_gap,
                brier_score, log_loss, confidence,
                engine_version, model_version, run_id
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            `,
            [
              group.marketKey,
              group.probabilityBucket,
              previous ? Number(previous.proposed_adjustment) : null,
              group.proposedAdjustment,
              previous ? Number(previous.sample_size) : null,
              group.sampleSize,
              group.predictedMean,
              group.actualMean,
              group.calibrationGap,
              group.brierScore,
              group.logLoss,
              group.confidence,
              LEARNING_ENGINE_VERSION,
              LEARNING_MODEL_VERSION,
              runId,
            ]
          );
        }
      }

      const finishedAt = new Date();
      const summary = {
        ok: true,
        skipped: false,
        source,
        forced: force,
        engineVersion: LEARNING_ENGINE_VERSION,
        modelVersion: LEARNING_MODEL_VERSION,
        applyEnabled: CALIBRATION_APPLY_ENABLED,
        predictionsFound: signature.predictionCount,
        groupsCalculated: groups.length,
        signature,
        startedAt,
        finishedAt,
      };

      await client.query(
        `
          INSERT INTO calibration_state (
            state_key, engine_version, model_version,
            last_watermark, last_prediction_count, last_max_prediction_id,
            last_fixture_date, last_run_id, last_run_started_at,
            last_run_finished_at, full_rebuild_required, last_summary,
            updated_at
          ) VALUES (
            'calibration-engine',$1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,$10::jsonb,NOW()
          )
          ON CONFLICT (state_key) DO UPDATE SET
            engine_version = EXCLUDED.engine_version,
            model_version = EXCLUDED.model_version,
            last_watermark = EXCLUDED.last_watermark,
            last_prediction_count = EXCLUDED.last_prediction_count,
            last_max_prediction_id = EXCLUDED.last_max_prediction_id,
            last_fixture_date = EXCLUDED.last_fixture_date,
            last_run_id = EXCLUDED.last_run_id,
            last_run_started_at = EXCLUDED.last_run_started_at,
            last_run_finished_at = EXCLUDED.last_run_finished_at,
            full_rebuild_required = FALSE,
            last_summary = EXCLUDED.last_summary,
            updated_at = NOW()
        `,
        [
          LEARNING_ENGINE_VERSION,
          LEARNING_MODEL_VERSION,
          signature.watermark,
          signature.predictionCount,
          signature.maxPredictionId,
          signature.lastFixtureDate,
          runId,
          startedAt,
          finishedAt,
          JSON.stringify(summary),
        ]
      );

      await client.query(
        `
          UPDATE calibration_runs
          SET finished_at = $1, status = 'COMPLETED',
              groups_calculated = $2, summary = $3::jsonb
          WHERE id = $4
        `,
        [finishedAt, groups.length, JSON.stringify(summary), runId]
      );

      await client.query("COMMIT");
      return summary;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const finishedAt = new Date();
    if (runId) {
      await pool.query(
        `
          UPDATE calibration_runs
          SET finished_at = $1, status = 'FAILED', error_message = $2
          WHERE id = $3
        `,
        [finishedAt, error?.message || "Erreur inconnue", runId]
      ).catch(() => null);
    }

    console.error("ERREUR CALIBRATION ENGINE V1 :", error);
    return {
      ok: false,
      source,
      startedAt,
      finishedAt,
      error: error?.message || "Erreur inconnue",
    };
  } finally {
    learningEngineRunning = false;
  }
}

app.get(
  "/internal/rebuild-learning-engine",
  async (req, res) => {
    const force = parseLearningBoolean(req.query.force);
    const summary = await rebuildLearningEngine({
      source: "manual-route",
      force,
    });
    return res.status(summary.ok ? 200 : 500).json(summary);
  }
);

/* Alias explicite pour la nouvelle architecture. */
app.get(
  "/internal/rebuild-calibration-engine",
  async (req, res) => {
    const force = parseLearningBoolean(req.query.force);
    const summary = await rebuildLearningEngine({
      source: "manual-calibration-route",
      force,
    });
    return res.status(summary.ok ? 200 : 500).json(summary);
  }
);

async function calibrationStatusHandler(req, res) {
    try {
      await ensureLearningEngineTables();
      const [state, signature, latestRunResult, groupCountResult] =
        await Promise.all([
          readLearningState(),
          readLearningDataSignature(),
          pool.query(
            `
              SELECT * FROM calibration_runs
              WHERE engine_version = $1
              ORDER BY started_at DESC, id DESC LIMIT 1
            `,
            [LEARNING_ENGINE_VERSION]
          ),
          pool.query(`SELECT COUNT(*)::INTEGER AS count FROM learning_calibration`),
        ]);

      const versionChanged =
        !state ||
        state.engine_version !== LEARNING_ENGINE_VERSION ||
        state.model_version !== LEARNING_MODEL_VERSION;

      return res.json({
        ok: true,
        engine: "CALIBRATION_ENGINE",
        running: learningEngineRunning,
        engineVersion: LEARNING_ENGINE_VERSION,
        modelVersion: LEARNING_MODEL_VERSION,
        applyEnabled: CALIBRATION_APPLY_ENABLED,
        observationOnly: !CALIBRATION_APPLY_ENABLED,
        bucketSize: CALIBRATION_BUCKET_SIZE,
        minimumProbability: CALIBRATION_MIN_PROBABILITY,
        maximumAdjustment: CALIBRATION_MAX_ADJUSTMENT,
        groupsCalculated: Number(groupCountResult.rows[0]?.count) || 0,
        needsRebuild:
          versionChanged ||
          Boolean(state?.full_rebuild_required) ||
          !learningSignaturesMatch(state, signature),
        versionChanged,
        signature,
        state,
        latestRun: latestRunResult.rows[0] || null,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Impossible de lire le statut du Calibration Engine",
      });
    }
}

app.get("/internal/calibration/status", calibrationStatusHandler);

/* Compatibilité avec l'ancienne URL utilisée par le frontend. */
app.get("/internal/learning/status", calibrationStatusHandler);


app.get(
  "/public/learning/adaptive-adjustment",
  async (req, res) => {
    try {
      await ensureLearningEngineTables();
      const result = await getAdaptiveLearningAdjustment({
        marketKey: req.query.marketKey,
        baseProbability: req.query.probability,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Impossible de calculer la calibration",
      });
    }
  }
);

app.get(
  "/public/calibration/preview",
  async (req, res) => {
    try {
      await ensureLearningEngineTables();
      const result = await getAdaptiveLearningAdjustment({
        marketKey: req.query.marketKey,
        baseProbability: req.query.probability,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "Impossible de prévisualiser la calibration",
      });
    }
  }
);

app.get(
  "/public/learning/market-stats",
  async (req, res) => {
    try {
      await ensureLearningEngineTables();
      const result = await pool.query(`
        SELECT
          market_key, probability_bucket, bucket_lower, bucket_upper,
          sample_size, wins, losses, predicted_mean, actual_mean,
          calibration_gap, brier_score, log_loss, accuracy,
          proposed_adjustment, applied_adjustment, confidence,
          engine_version, model_version, calculated_at
        FROM learning_calibration
        ORDER BY sample_size DESC, market_key ASC, bucket_lower ASC
      `);

      return res.json({
        ok: true,
        count: result.rows.length,
        engineVersion: LEARNING_ENGINE_VERSION,
        modelVersion: LEARNING_MODEL_VERSION,
        applyEnabled: CALIBRATION_APPLY_ENABLED,
        stats: result.rows,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        stats: [],
        error:
          error?.message ||
          "Impossible de charger les statistiques de calibration",
      });
    }
  }
);
/*
 * ==========================================================================
 * CALIBRATION CENTER — MOTEUR DÉCISIONNEL AUTONOME V2
 * ==========================================================================
 *
 * Learning conserve la mémoire statistique.
 * Calibration Center lit cette mémoire, génère des calibrations,
 * les active avec garde-fous, puis mesure automatiquement leur efficacité.
 *
 * Aucun bouton d'approbation n'est nécessaire.
 */

const CALIBRATION_RECOMMENDATION_STATUSES = new Set([
  "OBSERVING",
  "ACTIVE",
  "COOLDOWN",
  "REVERTED",
  "EXPIRED",
]);

const CALIBRATION_RECOMMENDATION_SEVERITIES = new Set([
  "INFO",
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

const CALIBRATION_EVALUATION_MIN_NEW_SAMPLES = 50;
const CALIBRATION_MIN_GAP_IMPROVEMENT = 1;
const CALIBRATION_MAX_BRIER_DEGRADATION = 0.02;
const CALIBRATION_MAX_GAP_DEGRADATION = 2;
const CALIBRATION_MAX_ADJUSTMENT_STEP = 1;

let calibrationAutoEvaluationRunning = false;
let automaticCalibrationCycleRunning = false;

function normalizeCalibrationRecommendationStatus(
  value,
  fallback = "OBSERVING"
) {
  const normalized = String(value || fallback)
    .trim()
    .toUpperCase();

  return CALIBRATION_RECOMMENDATION_STATUSES.has(normalized)
    ? normalized
    : fallback;
}

function calibrationDecisionNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampCalibrationDecision(value, minimum, maximum) {
  return Math.min(
    maximum,
    Math.max(minimum, calibrationDecisionNumber(value))
  );
}

function roundCalibrationDecision(value, decimals = 2) {
  const factor = 10 ** decimals;

  return (
    Math.round(
      (calibrationDecisionNumber(value) + Number.EPSILON) * factor
    ) / factor
  );
}

async function ensureCalibrationDecisionTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calibration_recommendations (
      id BIGSERIAL PRIMARY KEY,

      recommendation_key TEXT NOT NULL UNIQUE,

      type TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'MARKET',
      market_key TEXT,
      league_id BIGINT,
      confidence_band TEXT,
      probability_bucket TEXT,
      period_key TEXT NOT NULL DEFAULT 'ALL_TIME',

      severity TEXT NOT NULL DEFAULT 'INFO',
      priority_score NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OBSERVING',

      title TEXT NOT NULL,
      explanation TEXT NOT NULL,
      recommendation_text TEXT NOT NULL,

      action TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'NONE',

      raw_adjustment NUMERIC NOT NULL DEFAULT 0,
      proposed_adjustment NUMERIC NOT NULL DEFAULT 0,
      coefficient NUMERIC NOT NULL DEFAULT 1,

      sample_size INTEGER NOT NULL DEFAULT 0,
      predicted_average NUMERIC,
      actual_rate NUMERIC,
      calibration_gap NUMERIC,
      absolute_gap NUMERIC,

      brier_score NUMERIC,
      log_loss NUMERIC,
      accuracy NUMERIC,
      roi NUMERIC,

      evidence_level TEXT,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      recommendation JSONB NOT NULL DEFAULT '{}'::jsonb,

      source_engine_version TEXT,
      source_model_version TEXT,
      source_calculated_at TIMESTAMPTZ,

      activated_sample_size INTEGER,
      last_evaluated_sample_size INTEGER,
      baseline_gap NUMERIC,
      baseline_brier_score NUMERIC,
      effectiveness_score NUMERIC,

      previous_status TEXT,
      evaluation_count INTEGER NOT NULL DEFAULT 0,
      last_evaluated_at TIMESTAMPTZ,
      last_evaluation_reason TEXT,
      gap_improvement NUMERIC,
      brier_improvement NUMERIC,

      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  /*
   * Migration progressive pour les bases où la table existait déjà.
   */
  await pool.query(`
    ALTER TABLE calibration_recommendations
      ADD COLUMN IF NOT EXISTS activated_sample_size INTEGER,
      ADD COLUMN IF NOT EXISTS last_evaluated_sample_size INTEGER,
      ADD COLUMN IF NOT EXISTS baseline_gap NUMERIC,
      ADD COLUMN IF NOT EXISTS baseline_brier_score NUMERIC,
      ADD COLUMN IF NOT EXISTS effectiveness_score NUMERIC,
      ADD COLUMN IF NOT EXISTS previous_status TEXT,
      ADD COLUMN IF NOT EXISTS evaluation_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_evaluated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_evaluation_reason TEXT,
      ADD COLUMN IF NOT EXISTS gap_improvement NUMERIC,
      ADD COLUMN IF NOT EXISTS brier_improvement NUMERIC,
      ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
  `);

  await pool.query(`
    ALTER TABLE calibration_recommendations
    ALTER COLUMN status SET DEFAULT 'OBSERVING';
  `);

  /*
   * Convertit les anciens statuts manuels vers le nouveau cycle autonome.
   */
  await pool.query(`
    UPDATE calibration_recommendations
    SET
      status = CASE
        WHEN status IN ('PROPOSED', 'APPROVED', 'PAUSED') THEN 'OBSERVING'
        WHEN status = 'REJECTED' THEN 'REVERTED'
        ELSE status
      END,
      updated_at = NOW()
    WHERE status IN ('PROPOSED', 'APPROVED', 'PAUSED', 'REJECTED');
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS calibration_recommendation_events (
      id BIGSERIAL PRIMARY KEY,

      recommendation_id BIGINT NOT NULL
        REFERENCES calibration_recommendations(id)
        ON DELETE CASCADE,

      recommendation_key TEXT NOT NULL,
      event_type TEXT NOT NULL,

      previous_status TEXT,
      new_status TEXT,

      previous_adjustment NUMERIC,
      new_adjustment NUMERIC,

      sample_size INTEGER,
      new_samples INTEGER,

      baseline_gap NUMERIC,
      current_gap NUMERIC,
      gap_improvement NUMERIC,

      baseline_brier_score NUMERIC,
      current_brier_score NUMERIC,
      brier_improvement NUMERIC,

      effectiveness_score NUMERIC,

      reason TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_calibration_recommendations_status
    ON calibration_recommendations(status);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_calibration_recommendations_market
    ON calibration_recommendations(market_key, probability_bucket);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_calibration_recommendations_severity
    ON calibration_recommendations(severity);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_calibration_recommendations_generated
    ON calibration_recommendations(generated_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_calibration_events_recommendation
    ON calibration_recommendation_events(
      recommendation_id,
      created_at DESC
    );
  `);
}

function getCalibrationEvidenceLevel(sampleSize) {
  const sample = calibrationDecisionNumber(sampleSize);

  if (sample < 30) {
    return {
      key: "INSUFFICIENT",
      label: "Données insuffisantes",
      score: 0,
    };
  }

  if (sample < 100) {
    return {
      key: "LOW",
      label: "Signal faible",
      score: 1,
    };
  }

  if (sample < 300) {
    return {
      key: "MEDIUM",
      label: "Signal moyen",
      score: 2,
    };
  }

  return {
    key: "HIGH",
    label: "Signal fort",
    score: 3,
  };
}

function getCalibrationDecisionSeverity({
  sampleSize,
  absoluteGap,
}) {
  const evidence = getCalibrationEvidenceLevel(sampleSize);
  const gap = Math.abs(calibrationDecisionNumber(absoluteGap));

  if (evidence.key === "INSUFFICIENT") {
    return {
      severity: "INFO",
      priority: 0,
      diagnostic: "INSUFFICIENT",
      evidence,
    };
  }

  if (gap >= 10) {
    return {
      severity: evidence.score >= 2 ? "CRITICAL" : "HIGH",
      priority: 4 + evidence.score,
      diagnostic: "CRITICAL_BIAS",
      evidence,
    };
  }

  if (gap >= 5) {
    return {
      severity: evidence.score >= 2 ? "HIGH" : "MEDIUM",
      priority: 3 + evidence.score,
      diagnostic: "IMPORTANT_BIAS",
      evidence,
    };
  }

  if (gap >= 3) {
    return {
      severity: "MEDIUM",
      priority: 2 + evidence.score,
      diagnostic: "WATCH",
      evidence,
    };
  }

  return {
    severity: "LOW",
    priority: 1 + evidence.score,
    diagnostic: "HEALTHY",
    evidence,
  };
}

function getAutomaticCalibrationStatus({
  sampleSize,
  absoluteGap,
  evidenceLevel,
  action,
}) {
  if (action === "WAIT_FOR_MORE_DATA") {
    return "OBSERVING";
  }

  if (
    sampleSize >= 100 &&
    absoluteGap >= 5 &&
    ["MEDIUM", "HIGH"].includes(evidenceLevel) &&
    action === "ADJUST_PROBABILITY"
  ) {
    return "ACTIVE";
  }

  return "OBSERVING";
}

function buildMarketCalibrationRecommendation(row = {}) {
  const marketKey = String(row.market_key || "UNKNOWN")
    .trim()
    .toUpperCase();

  const probabilityBucket = String(
    row.probability_bucket || "UNKNOWN"
  ).trim();

  const sampleSize = calibrationDecisionNumber(row.sample_size);
  const predictedAverage = calibrationDecisionNumber(row.predicted_mean);
  const actualRate = calibrationDecisionNumber(row.actual_mean);

  /*
   * Positif = surestimation.
   * Négatif = sous-estimation.
   */
  const calibrationGap = predictedAverage - actualRate;
  const absoluteGap = Math.abs(calibrationGap);

  const classification = getCalibrationDecisionSeverity({
    sampleSize,
    absoluteGap,
  });

  const proposedAdjustment =
    classification.evidence.key === "INSUFFICIENT"
      ? 0
      : clampCalibrationDecision(-calibrationGap * 0.5, -6, 6);

  const direction =
    calibrationGap > 0
      ? "DOWN"
      : calibrationGap < 0
        ? "UP"
        : "NONE";

  let action = "KEEP_PROBABILITY";

  if (classification.evidence.key === "INSUFFICIENT") {
    action = "WAIT_FOR_MORE_DATA";
  } else if (Math.abs(proposedAdjustment) >= 0.5) {
    action = "ADJUST_PROBABILITY";
  }

  const automaticStatus = getAutomaticCalibrationStatus({
    sampleSize,
    absoluteGap,
    evidenceLevel: classification.evidence.key,
    action,
  });

  const title =
    action === "WAIT_FOR_MORE_DATA"
      ? `${marketKey} ${probabilityBucket} : données insuffisantes`
      : direction === "DOWN"
        ? `Réduire ${marketKey} sur le bucket ${probabilityBucket}`
        : direction === "UP"
          ? `Augmenter ${marketKey} sur le bucket ${probabilityBucket}`
          : `${marketKey} ${probabilityBucket} est bien calibré`;

  const explanation =
    classification.evidence.key === "INSUFFICIENT"
      ? `${sampleSize} observations seulement. Le volume est insuffisant pour produire une calibration forte.`
      : calibrationGap > 0
        ? `La probabilité moyenne annoncée est de ${roundCalibrationDecision(
            predictedAverage,
            1
          )} %, contre ${roundCalibrationDecision(
            actualRate,
            1
          )} % de réussite réelle. Le marché est surestimé de ${roundCalibrationDecision(
            absoluteGap,
            1
          )} point(s).`
        : calibrationGap < 0
          ? `La probabilité moyenne annoncée est de ${roundCalibrationDecision(
              predictedAverage,
              1
            )} %, contre ${roundCalibrationDecision(
              actualRate,
              1
            )} % de réussite réelle. Le marché est sous-estimé de ${roundCalibrationDecision(
              absoluteGap,
              1
            )} point(s).`
          : "La probabilité moyenne correspond au taux de réussite réel.";

  const recommendationText =
    action === "WAIT_FOR_MORE_DATA"
      ? "Attendre davantage de résultats avant toute modification."
      : action === "KEEP_PROBABILITY"
        ? "Conserver le réglage actuel."
        : `${
            direction === "DOWN" ? "Réduire" : "Augmenter"
          } prudemment la probabilité de ${roundCalibrationDecision(
            Math.abs(proposedAdjustment),
            1
          )} point(s).`;

  const coefficient =
    predictedAverage > 0
      ? clampCalibrationDecision(
          (predictedAverage + proposedAdjustment) / predictedAverage,
          0.75,
          1.25
        )
      : 1;

  const recommendationKey = [
    "PROBABILITY_BIAS",
    marketKey,
    probabilityBucket,
    "ALL_TIME",
  ].join(":");

  const evidence = {
    sampleSize,
    evidenceLevel: classification.evidence.key,
    evidenceLabel: classification.evidence.label,
    predictedAverage: roundCalibrationDecision(predictedAverage, 2),
    actualRate: roundCalibrationDecision(actualRate, 2),
    calibrationGap: roundCalibrationDecision(calibrationGap, 2),
    absoluteGap: roundCalibrationDecision(absoluteGap, 2),
    brierScore: roundCalibrationDecision(row.brier_score, 4),
    logLoss: roundCalibrationDecision(row.log_loss, 4),
    accuracy: roundCalibrationDecision(row.accuracy, 2),
  };

  const recommendation = {
    action,
    direction,
    rawAdjustment: roundCalibrationDecision(-calibrationGap, 2),
    proposedAdjustment: roundCalibrationDecision(proposedAdjustment, 2),
    coefficient: roundCalibrationDecision(coefficient, 4),
  };

  return {
    recommendationKey,
    type: "PROBABILITY_BIAS",
    scopeType: "MARKET_BUCKET",
    marketKey,
    probabilityBucket,
    periodKey: "ALL_TIME",
    severity: classification.severity,
    priorityScore: classification.priority,
    status: automaticStatus,
    title,
    explanation,
    recommendationText,
    action,
    direction,
    rawAdjustment: recommendation.rawAdjustment,
    proposedAdjustment: recommendation.proposedAdjustment,
    coefficient: recommendation.coefficient,
    sampleSize,
    predictedAverage: evidence.predictedAverage,
    actualRate: evidence.actualRate,
    calibrationGap: evidence.calibrationGap,
    absoluteGap: evidence.absoluteGap,
    brierScore: evidence.brierScore,
    logLoss: evidence.logLoss,
    accuracy: evidence.accuracy,
    evidenceLevel: classification.evidence.key,
    evidence,
    recommendation,
    sourceEngineVersion: row.engine_version || null,
    sourceModelVersion: row.model_version || null,
    sourceCalculatedAt: row.calculated_at || null,
  };
}

async function insertCalibrationLifecycleEvent({
  recommendationId,
  recommendationKey,
  eventType,
  previousStatus = null,
  newStatus = null,
  previousAdjustment = null,
  newAdjustment = null,
  sampleSize = null,
  newSamples = null,
  baselineGap = null,
  currentGap = null,
  gapImprovement = null,
  baselineBrierScore = null,
  currentBrierScore = null,
  brierImprovement = null,
  effectivenessScore = null,
  reason = null,
  metadata = {},
  client = pool,
}) {
  await client.query(
    `
      INSERT INTO calibration_recommendation_events (
        recommendation_id,
        recommendation_key,
        event_type,
        previous_status,
        new_status,
        previous_adjustment,
        new_adjustment,
        sample_size,
        new_samples,
        baseline_gap,
        current_gap,
        gap_improvement,
        baseline_brier_score,
        current_brier_score,
        brier_improvement,
        effectiveness_score,
        reason,
        metadata
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb
      )
    `,
    [
      recommendationId,
      recommendationKey,
      eventType,
      previousStatus,
      newStatus,
      previousAdjustment,
      newAdjustment,
      sampleSize,
      newSamples,
      baselineGap,
      currentGap,
      gapImprovement,
      baselineBrierScore,
      currentBrierScore,
      brierImprovement,
      effectivenessScore,
      reason,
      JSON.stringify(metadata || {}),
    ]
  );
}

async function generateCalibrationRecommendations({
  source = "manual",
} = {}) {
  await ensureLearningEngineTables();
  await ensureCalibrationDecisionTables();

  const sourceResult = await pool.query(`
    SELECT
      market_key,
      probability_bucket,
      bucket_lower,
      bucket_upper,
      sample_size,
      wins,
      losses,
      predicted_mean,
      actual_mean,
      calibration_gap,
      brier_score,
      log_loss,
      accuracy,
      proposed_adjustment,
      applied_adjustment,
      confidence,
      engine_version,
      model_version,
      calculated_at
    FROM learning_calibration
    ORDER BY market_key ASC, bucket_lower ASC
  `);

  const recommendations = sourceResult.rows.map(
    buildMarketCalibrationRecommendation
  );

  let inserted = 0;
  let updated = 0;
  let activated = 0;

  for (const item of recommendations) {
    const existingResult = await pool.query(
      `
        SELECT
          id,
          status,
          proposed_adjustment,
          activated_sample_size,
          baseline_gap,
          baseline_brier_score
        FROM calibration_recommendations
        WHERE recommendation_key = $1
        LIMIT 1
      `,
      [item.recommendationKey]
    );

    const existing = existingResult.rows[0] || null;

    let safeProposedAdjustment = item.proposedAdjustment;

    if (
      existing &&
      ["ACTIVE", "COOLDOWN"].includes(existing.status)
    ) {
      const existingAdjustment = calibrationDecisionNumber(
        existing.proposed_adjustment
      );

      safeProposedAdjustment = clampCalibrationDecision(
        item.proposedAdjustment,
        existingAdjustment - CALIBRATION_MAX_ADJUSTMENT_STEP,
        existingAdjustment + CALIBRATION_MAX_ADJUSTMENT_STEP
      );
    }

    const safeCoefficient =
      item.predictedAverage > 0
        ? clampCalibrationDecision(
            (item.predictedAverage + safeProposedAdjustment) /
              item.predictedAverage,
            0.75,
            1.25
          )
        : 1;

    const safeRecommendation = {
      ...item.recommendation,
      proposedAdjustment: roundCalibrationDecision(
        safeProposedAdjustment,
        2
      ),
      coefficient: roundCalibrationDecision(safeCoefficient, 4),
    };

    const desiredStatus =
      existing?.status === "EXPIRED"
        ? "EXPIRED"
        : ["ACTIVE", "COOLDOWN"].includes(existing?.status)
          ? existing.status
          : existing?.status === "REVERTED"
            ? "OBSERVING"
            : item.status;

    const result = await pool.query(
      `
        INSERT INTO calibration_recommendations (
          recommendation_key,
          type,
          scope_type,
          market_key,
          probability_bucket,
          period_key,
          severity,
          priority_score,
          status,
          title,
          explanation,
          recommendation_text,
          action,
          direction,
          raw_adjustment,
          proposed_adjustment,
          coefficient,
          sample_size,
          predicted_average,
          actual_rate,
          calibration_gap,
          absolute_gap,
          brier_score,
          log_loss,
          accuracy,
          evidence_level,
          evidence,
          recommendation,
          source_engine_version,
          source_model_version,
          source_calculated_at,
          generated_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17,
          $18, $19, $20, $21, $22, $23, $24, $25,
          $26, $27::jsonb, $28::jsonb, $29, $30, $31,
          NOW(), NOW()
        )
        ON CONFLICT (recommendation_key)
        DO UPDATE SET
          severity = EXCLUDED.severity,
          priority_score = EXCLUDED.priority_score,
          previous_status = calibration_recommendations.status,
          status = EXCLUDED.status,
          title = EXCLUDED.title,
          explanation = EXCLUDED.explanation,
          recommendation_text = EXCLUDED.recommendation_text,
          action = EXCLUDED.action,
          direction = EXCLUDED.direction,
          raw_adjustment = EXCLUDED.raw_adjustment,
          proposed_adjustment = EXCLUDED.proposed_adjustment,
          coefficient = EXCLUDED.coefficient,
          sample_size = EXCLUDED.sample_size,
          predicted_average = EXCLUDED.predicted_average,
          actual_rate = EXCLUDED.actual_rate,
          calibration_gap = EXCLUDED.calibration_gap,
          absolute_gap = EXCLUDED.absolute_gap,
          brier_score = EXCLUDED.brier_score,
          log_loss = EXCLUDED.log_loss,
          accuracy = EXCLUDED.accuracy,
          evidence_level = EXCLUDED.evidence_level,
          evidence = EXCLUDED.evidence,
          recommendation = EXCLUDED.recommendation,
          source_engine_version = EXCLUDED.source_engine_version,
          source_model_version = EXCLUDED.source_model_version,
          source_calculated_at = EXCLUDED.source_calculated_at,
          generated_at = NOW(),
          updated_at = NOW()
        RETURNING id, status, proposed_adjustment, (xmax = 0) AS inserted
      `,
      [
        item.recommendationKey,
        item.type,
        item.scopeType,
        item.marketKey,
        item.probabilityBucket,
        item.periodKey,
        item.severity,
        item.priorityScore,
        desiredStatus,
        item.title,
        item.explanation,
        item.recommendationText,
        item.action,
        item.direction,
        item.rawAdjustment,
        roundCalibrationDecision(safeProposedAdjustment, 2),
        roundCalibrationDecision(safeCoefficient, 4),
        item.sampleSize,
        item.predictedAverage,
        item.actualRate,
        item.calibrationGap,
        item.absoluteGap,
        item.brierScore,
        item.logLoss,
        item.accuracy,
        item.evidenceLevel,
        JSON.stringify(item.evidence),
        JSON.stringify(safeRecommendation),
        item.sourceEngineVersion,
        item.sourceModelVersion,
        item.sourceCalculatedAt,
      ]
    );

    const saved = result.rows[0];

    if (saved?.inserted) {
      inserted += 1;
    } else {
      updated += 1;
    }

    /*
     * Initialise le point de comparaison lors de la première activation.
     */
    if (
      saved?.status === "ACTIVE" &&
      existing?.status !== "ACTIVE"
    ) {
      await pool.query(
        `
          UPDATE calibration_recommendations
          SET
            activated_sample_size = COALESCE(
              activated_sample_size,
              sample_size
            ),
            last_evaluated_sample_size = COALESCE(
              last_evaluated_sample_size,
              sample_size
            ),
            baseline_gap = COALESCE(
              baseline_gap,
              absolute_gap
            ),
            baseline_brier_score = COALESCE(
              baseline_brier_score,
              brier_score
            ),
            activated_at = COALESCE(
              activated_at,
              NOW()
            ),
            updated_at = NOW()
          WHERE id = $1
        `,
        [saved.id]
      );

      await insertCalibrationLifecycleEvent({
        recommendationId: saved.id,
        recommendationKey: item.recommendationKey,
        eventType: "AUTO_ACTIVATION",
        previousStatus: existing?.status || null,
        newStatus: "ACTIVE",
        previousAdjustment: existing?.proposed_adjustment ?? null,
        newAdjustment: saved.proposed_adjustment,
        sampleSize: item.sampleSize,
        baselineGap: item.absoluteGap,
        currentGap: item.absoluteGap,
        baselineBrierScore: item.brierScore,
        currentBrierScore: item.brierScore,
        reason: "AUTOMATIC_ACTIVATION_THRESHOLDS_MET",
        metadata: {
          source,
          evidenceLevel: item.evidenceLevel,
        },
      });

      activated += 1;
    }
  }

  return {
    ok: true,
    source,
    sourceRows: sourceResult.rows.length,
    generated: recommendations.length,
    inserted,
    updated,
    activated,
    generatedAt: new Date().toISOString(),
  };
}

function calculateCalibrationEffectiveness({
  gapImprovement,
  brierImprovement,
}) {
  const score =
    50 +
    calibrationDecisionNumber(gapImprovement) * 8 +
    calibrationDecisionNumber(brierImprovement) * 500;

  return roundCalibrationDecision(
    clampCalibrationDecision(score, 0, 100),
    1
  );
}

function decideCalibrationEvaluation({
  currentStatus,
  currentAdjustment,
  currentGap,
  baselineGap,
  currentBrier,
  baselineBrier,
  newSamples,
}) {
  const gapImprovement =
    calibrationDecisionNumber(baselineGap) -
    calibrationDecisionNumber(currentGap);

  const brierImprovement =
    calibrationDecisionNumber(baselineBrier) -
    calibrationDecisionNumber(currentBrier);

  const effectivenessScore = calculateCalibrationEffectiveness({
    gapImprovement,
    brierImprovement,
  });

  if (newSamples < CALIBRATION_EVALUATION_MIN_NEW_SAMPLES) {
    return {
      shouldUpdate: false,
      newStatus: currentStatus,
      newAdjustment: currentAdjustment,
      gapImprovement,
      brierImprovement,
      effectivenessScore,
      reason: "NOT_ENOUGH_NEW_SAMPLES",
    };
  }

  const gapDegradation =
    gapImprovement <= -CALIBRATION_MAX_GAP_DEGRADATION;

  const brierDegradation =
    brierImprovement <= -CALIBRATION_MAX_BRIER_DEGRADATION;

  if (gapDegradation || brierDegradation) {
    return {
      shouldUpdate: true,
      newStatus: "REVERTED",
      newAdjustment: 0,
      gapImprovement,
      brierImprovement,
      effectivenessScore,
      reason: gapDegradation
        ? "CALIBRATION_GAP_WORSENED"
        : "BRIER_SCORE_WORSENED",
    };
  }

  if (Math.abs(calibrationDecisionNumber(currentGap)) < 3) {
    return {
      shouldUpdate: true,
      newStatus: "COOLDOWN",
      newAdjustment: roundCalibrationDecision(
        calibrationDecisionNumber(currentAdjustment) * 0.5,
        2
      ),
      gapImprovement,
      brierImprovement,
      effectivenessScore,
      reason: "CALIBRATION_TARGET_REACHED",
    };
  }

  if (
    gapImprovement >= CALIBRATION_MIN_GAP_IMPROVEMENT &&
    brierImprovement > -CALIBRATION_MAX_BRIER_DEGRADATION
  ) {
    return {
      shouldUpdate: true,
      newStatus: "ACTIVE",
      newAdjustment: currentAdjustment,
      gapImprovement,
      brierImprovement,
      effectivenessScore,
      reason: "CALIBRATION_IMPROVING",
    };
  }

  return {
    shouldUpdate: true,
    newStatus: "COOLDOWN",
    newAdjustment: roundCalibrationDecision(
      calibrationDecisionNumber(currentAdjustment) * 0.75,
      2
    ),
    gapImprovement,
    brierImprovement,
    effectivenessScore,
    reason: "CALIBRATION_EFFECT_UNCERTAIN",
  };
}

async function evaluateActiveCalibrations({
  source = "automatic",
} = {}) {
  if (calibrationAutoEvaluationRunning) {
    return {
      ok: true,
      skipped: true,
      reason: "CALIBRATION_EVALUATION_ALREADY_RUNNING",
    };
  }

  calibrationAutoEvaluationRunning = true;

  const summary = {
    ok: true,
    source,
    startedAt: new Date().toISOString(),
    found: 0,
    evaluated: 0,
    waiting: 0,
    maintained: 0,
    cooldown: 0,
    reverted: 0,
    failed: 0,
    results: [],
  };

  try {
    await ensureCalibrationDecisionTables();

    const activeResult = await pool.query(`
      SELECT *
      FROM calibration_recommendations
      WHERE status IN ('ACTIVE', 'COOLDOWN')
      ORDER BY priority_score DESC, updated_at ASC
    `);

    summary.found = activeResult.rows.length;

    for (const recommendation of activeResult.rows) {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const referenceSampleSize = calibrationDecisionNumber(
          recommendation.last_evaluated_sample_size,
          calibrationDecisionNumber(
            recommendation.activated_sample_size,
            recommendation.sample_size
          )
        );

        const currentSampleSize = calibrationDecisionNumber(
          recommendation.sample_size
        );

        const newSamples = Math.max(
          0,
          currentSampleSize - referenceSampleSize
        );

        const baselineGap =
          recommendation.baseline_gap !== null &&
          recommendation.baseline_gap !== undefined
            ? calibrationDecisionNumber(recommendation.baseline_gap)
            : calibrationDecisionNumber(recommendation.absolute_gap);

        const baselineBrier =
          recommendation.baseline_brier_score !== null &&
          recommendation.baseline_brier_score !== undefined
            ? calibrationDecisionNumber(
                recommendation.baseline_brier_score
              )
            : calibrationDecisionNumber(recommendation.brier_score);

        const evaluation = decideCalibrationEvaluation({
          currentStatus: recommendation.status,
          currentAdjustment: calibrationDecisionNumber(
            recommendation.proposed_adjustment
          ),
          currentGap: calibrationDecisionNumber(
            recommendation.absolute_gap
          ),
          baselineGap,
          currentBrier: calibrationDecisionNumber(
            recommendation.brier_score
          ),
          baselineBrier,
          newSamples,
        });

        if (!evaluation.shouldUpdate) {
          summary.waiting += 1;
          summary.results.push({
            id: recommendation.id,
            recommendationKey: recommendation.recommendation_key,
            status: recommendation.status,
            newSamples,
            result: evaluation.reason,
          });

          await client.query("ROLLBACK");
          continue;
        }

        await insertCalibrationLifecycleEvent({
          client,
          recommendationId: recommendation.id,
          recommendationKey: recommendation.recommendation_key,
          eventType: "AUTO_EVALUATION",
          previousStatus: recommendation.status,
          newStatus: evaluation.newStatus,
          previousAdjustment: recommendation.proposed_adjustment,
          newAdjustment: evaluation.newAdjustment,
          sampleSize: recommendation.sample_size,
          newSamples,
          baselineGap,
          currentGap: recommendation.absolute_gap,
          gapImprovement: evaluation.gapImprovement,
          baselineBrierScore: baselineBrier,
          currentBrierScore: recommendation.brier_score,
          brierImprovement: evaluation.brierImprovement,
          effectivenessScore: evaluation.effectivenessScore,
          reason: evaluation.reason,
          metadata: {
            source,
            evaluationVersion: "calibration-auto-evaluation-v1",
            minimumNewSamples:
              CALIBRATION_EVALUATION_MIN_NEW_SAMPLES,
          },
        });

        await client.query(
          `
            UPDATE calibration_recommendations
            SET
              previous_status = status,
              status = $2,
              proposed_adjustment = $3,
              coefficient = CASE
                WHEN predicted_average > 0
                THEN LEAST(
                  1.25,
                  GREATEST(
                    0.75,
                    (predicted_average + $3) / predicted_average
                  )
                )
                ELSE 1
              END,
              effectiveness_score = $4,
              gap_improvement = $5,
              brier_improvement = $6,
              last_evaluated_sample_size = sample_size,
              last_evaluated_at = NOW(),
              last_evaluation_reason = $7,
              evaluation_count = COALESCE(evaluation_count, 0) + 1,
              updated_at = NOW()
            WHERE id = $1
          `,
          [
            recommendation.id,
            evaluation.newStatus,
            evaluation.newAdjustment,
            evaluation.effectivenessScore,
            evaluation.gapImprovement,
            evaluation.brierImprovement,
            evaluation.reason,
          ]
        );

        await client.query("COMMIT");

        summary.evaluated += 1;

        if (evaluation.newStatus === "ACTIVE") {
          summary.maintained += 1;
        } else if (evaluation.newStatus === "COOLDOWN") {
          summary.cooldown += 1;
        } else if (evaluation.newStatus === "REVERTED") {
          summary.reverted += 1;
        }

        summary.results.push({
          id: recommendation.id,
          recommendationKey: recommendation.recommendation_key,
          previousStatus: recommendation.status,
          newStatus: evaluation.newStatus,
          previousAdjustment: calibrationDecisionNumber(
            recommendation.proposed_adjustment
          ),
          newAdjustment: evaluation.newAdjustment,
          newSamples,
          gapImprovement: evaluation.gapImprovement,
          brierImprovement: evaluation.brierImprovement,
          effectivenessScore: evaluation.effectivenessScore,
          reason: evaluation.reason,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => null);

        summary.failed += 1;
        summary.results.push({
          id: recommendation.id,
          recommendationKey: recommendation.recommendation_key,
          error: error?.message || "Erreur inconnue",
        });

        console.error(
          "ERREUR AUTO-ÉVALUATION CALIBRATION :",
          recommendation.recommendation_key,
          error
        );
      } finally {
        client.release();
      }
    }

    summary.finishedAt = new Date().toISOString();
    return summary;
  } catch (error) {
    console.error(
      "ERREUR MOTEUR AUTO-ÉVALUATION CALIBRATION :",
      error
    );

    return {
      ...summary,
      ok: false,
      finishedAt: new Date().toISOString(),
      error: error?.message || "Erreur inconnue",
    };
  } finally {
    calibrationAutoEvaluationRunning = false;
  }
}

async function runAutomaticCalibrationCycle({
  source = "scheduler",
} = {}) {
  if (automaticCalibrationCycleRunning) {
    return {
      ok: true,
      skipped: true,
      reason: "AUTOMATIC_CALIBRATION_CYCLE_ALREADY_RUNNING",
    };
  }

  automaticCalibrationCycleRunning = true;
  const startedAt = new Date().toISOString();

  try {
    const learning = await rebuildLearningEngine({
      source: `${source}-learning`,
      force: false,
    });

    const generation = await generateCalibrationRecommendations({
      source: `${source}-generation`,
    });

    const evaluation = await evaluateActiveCalibrations({
      source: `${source}-evaluation`,
    });

    return {
      ok:
        learning?.ok !== false &&
        generation?.ok !== false &&
        evaluation?.ok !== false,
      source,
      startedAt,
      finishedAt: new Date().toISOString(),
      learning,
      generation,
      evaluation,
    };
  } catch (error) {
    console.error(
      "ERREUR CYCLE AUTOMATIQUE CALIBRATION :",
      error
    );

    return {
      ok: false,
      source,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error?.message || "Erreur inconnue",
    };
  } finally {
    automaticCalibrationCycleRunning = false;
  }
}

app.post(
  "/internal/calibration/recommendations/generate",
  async (req, res) => {
    if (!requireOptionalAdminKey(req, res)) {
      return;
    }

    try {
      const result = await generateCalibrationRecommendations({
        source: "admin-route",
      });

      return res.status(result.ok ? 200 : 500).json(result);
    } catch (error) {
      console.error(
        "ERREUR GÉNÉRATION CALIBRATIONS :",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Impossible de générer les calibrations.",
      });
    }
  }
);

app.get(
  "/internal/calibration/automatic-cycle",
  async (req, res) => {
    if (!requireOptionalAdminKey(req, res)) {
      return;
    }

    try {
      const result = await runAutomaticCalibrationCycle({
        source: "manual-test-route",
      });

      return res.status(result.ok ? 200 : 500).json(result);
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Impossible d'exécuter le cycle automatique.",
      });
    }
  }
);

app.get(
  "/public/calibration/recommendations",
  async (req, res) => {
    try {
      await ensureCalibrationDecisionTables();

      const status = String(req.query.status || "")
        .trim()
        .toUpperCase();

      const marketKey = String(req.query.marketKey || "")
        .trim()
        .toUpperCase();

      const limit = Math.min(
        500,
        Math.max(1, Number(req.query.limit) || 100)
      );

      const values = [];
      const where = [];

      if (
        status &&
        CALIBRATION_RECOMMENDATION_STATUSES.has(status)
      ) {
        values.push(status);
        where.push(`status = $${values.length}`);
      }

      if (marketKey) {
        values.push(marketKey);
        where.push(`market_key = $${values.length}`);
      }

      values.push(limit);

      const result = await pool.query(
        `
          SELECT *
          FROM calibration_recommendations
          ${
            where.length > 0
              ? `WHERE ${where.join(" AND ")}`
              : ""
          }
          ORDER BY
            CASE severity
              WHEN 'CRITICAL' THEN 5
              WHEN 'HIGH' THEN 4
              WHEN 'MEDIUM' THEN 3
              WHEN 'LOW' THEN 2
              ELSE 1
            END DESC,
            priority_score DESC,
            absolute_gap DESC NULLS LAST,
            generated_at DESC
          LIMIT $${values.length}
        `,
        values
      );

      const summaryResult = await pool.query(`
        SELECT
          COUNT(*)::INTEGER AS total,
          COUNT(*) FILTER (
            WHERE status = 'OBSERVING'
          )::INTEGER AS observing,
          COUNT(*) FILTER (
            WHERE status = 'ACTIVE'
          )::INTEGER AS active,
          COUNT(*) FILTER (
            WHERE status = 'COOLDOWN'
          )::INTEGER AS cooldown,
          COUNT(*) FILTER (
            WHERE status = 'REVERTED'
          )::INTEGER AS reverted,
          COUNT(*) FILTER (
            WHERE severity = 'CRITICAL'
          )::INTEGER AS critical,
          COUNT(*) FILTER (
            WHERE severity = 'HIGH'
          )::INTEGER AS high
        FROM calibration_recommendations
      `);

      return res.json({
        ok: true,
        count: result.rows.length,
        summary:
          summaryResult.rows[0] || {
            total: 0,
            observing: 0,
            active: 0,
            cooldown: 0,
            reverted: 0,
            critical: 0,
            high: 0,
          },
        recommendations: result.rows,
      });
    } catch (error) {
      console.error(
        "ERREUR LISTE CALIBRATIONS :",
        error
      );

      return res.status(500).json({
        ok: false,
        recommendations: [],
        error:
          error?.message ||
          "Impossible de charger les calibrations.",
      });
    }
  }
);

app.get(
  "/public/calibration/recommendation-events",
  async (req, res) => {
    try {
      await ensureCalibrationDecisionTables();

      const recommendationId = Number(
        req.query.recommendationId
      );

      const limit = Math.min(
        500,
        Math.max(1, Number(req.query.limit) || 100)
      );

      const values = [];
      const where = [];

      if (
        Number.isInteger(recommendationId) &&
        recommendationId > 0
      ) {
        values.push(recommendationId);
        where.push(`recommendation_id = $${values.length}`);
      }

      values.push(limit);

      const result = await pool.query(
        `
          SELECT *
          FROM calibration_recommendation_events
          ${
            where.length > 0
              ? `WHERE ${where.join(" AND ")}`
              : ""
          }
          ORDER BY created_at DESC, id DESC
          LIMIT $${values.length}
        `,
        values
      );

      return res.json({
        ok: true,
        count: result.rows.length,
        events: result.rows,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        events: [],
        error:
          error?.message ||
          "Impossible de charger l'historique des calibrations.",
      });
    }
  }
);

app.get("/public/calibration/summary", async (req, res) => {
  try {

    await ensureLearningEngineTables();

    const { rows } = await pool.query(`
      SELECT
        market_key,
        probability_bucket,
        sample_size,
        accuracy,
        brier_score,
        log_loss,
        calibration_gap,
        calculated_at
      FROM learning_calibration
    `);

    const totalBuckets = rows.length;

    let healthyBuckets = 0;
    let warningBuckets = 0;
    let criticalBuckets = 0;

    let totalAccuracy = 0;
    let totalGap = 0;
    let totalBrier = 0;
    let totalLogLoss = 0;
    let totalPredictions = 0;

    const marketStats = {};

    for (const row of rows) {
      const gap = Math.abs(Number(row.calibration_gap) || 0);

      if (gap < 3) {
        healthyBuckets++;
      } else if (gap < 7) {
        warningBuckets++;
      } else {
        criticalBuckets++;
      }

      totalAccuracy += Number(row.accuracy) || 0;
      totalGap += gap;
      totalBrier += Number(row.brier_score) || 0;
      totalLogLoss += Number(row.log_loss) || 0;
      totalPredictions += Number(row.sample_size) || 0;

      if (!marketStats[row.market_key]) {
        marketStats[row.market_key] = {
          totalGap: 0,
          buckets: 0,
        };
      }

      marketStats[row.market_key].totalGap += gap;
      marketStats[row.market_key].buckets++;
    }

    const averages = Object.entries(marketStats).map(([market, value]) => ({
      market,
      averageGap: value.totalGap / value.buckets,
    }));

    averages.sort((a, b) => a.averageGap - b.averageGap);

    res.json({
      ok: true,
      summary: {
        totalBuckets,

        healthyBuckets,
        warningBuckets,
        criticalBuckets,

        averageAccuracy:
          totalBuckets > 0
            ? Number((totalAccuracy / totalBuckets).toFixed(2))
            : 0,

        averageBrierScore:
          totalBuckets > 0
            ? Number((totalBrier / totalBuckets).toFixed(4))
            : 0,

        averageLogLoss:
          totalBuckets > 0
            ? Number((totalLogLoss / totalBuckets).toFixed(4))
            : 0,

        averageCalibrationGap:
          totalBuckets > 0
            ? Number((totalGap / totalBuckets).toFixed(2))
            : 0,

        bestMarket: averages.length ? averages[0].market : null,

        worstMarket: averages.length
          ? averages[averages.length - 1].market
          : null,

        totalPredictions,

       lastUpdated:
  rows.length > 0
    ? rows.reduce((latest, row) => {
        if (!latest) return row.calculated_at;
        return new Date(row.calculated_at) > new Date(latest)
          ? row.calculated_at
          : latest;
      }, null)
    : null,
      },
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/public/calibration/stats", async (req, res) => {
  try {
    await ensureLearningEngineTables();
    const result = await pool.query(`
      SELECT
        market_key, probability_bucket, bucket_lower, bucket_upper,
        sample_size, wins, losses, predicted_mean, actual_mean,
        calibration_gap, brier_score, log_loss, accuracy,
        proposed_adjustment, applied_adjustment, confidence,
        engine_version, model_version, calculated_at
      FROM learning_calibration
      ORDER BY sample_size DESC, market_key ASC, bucket_lower ASC
    `);

    return res.json({
      ok: true,
      count: result.rows.length,
      engineVersion: LEARNING_ENGINE_VERSION,
      modelVersion: LEARNING_MODEL_VERSION,
      applyEnabled: CALIBRATION_APPLY_ENABLED,
      stats: result.rows,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      stats: [],
      error: error?.message || "Impossible de charger les statistiques de calibration",
    });
  }
});


app.get(
  "/public/calibration/history",
  async (req, res) => {
    try {
      await ensureLearningEngineTables();
      const limit = Math.min(
        500,
        Math.max(1, Number(req.query.limit) || 100)
      );
      const marketKey = normalizeAdaptiveLearningKey(req.query.marketKey);
      const bucket = String(req.query.bucket || "").trim();

      const values = [];
      const where = [];
      if (marketKey) {
        values.push(marketKey);
        where.push(`market_key = $${values.length}`);
      }
      if (bucket) {
        values.push(bucket);
        where.push(`probability_bucket = $${values.length}`);
      }
      values.push(limit);

      const result = await pool.query(
        `
          SELECT * FROM learning_history
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY created_at DESC, id DESC
          LIMIT $${values.length}
        `,
        values
      );

      return res.json({
        ok: true,
        count: result.rows.length,
        history: result.rows,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        history: [],
        error: error?.message || "Impossible de charger l'historique de calibration",
      });
    }
  }
);


/* ==========================================================================\n * BILAN V3 — STATISTIQUES GLOBALES + COTES MANUELLES ADMIN\n * ========================================================================== */
async function ensureBilanV3Columns() {
  await pool.query(`
    ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS manual_market_odd NUMERIC,
      ADD COLUMN IF NOT EXISTS manual_market_key TEXT,
      ADD COLUMN IF NOT EXISTS manual_stake_units NUMERIC NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS manual_odd_source TEXT,
      ADD COLUMN IF NOT EXISTS manual_odd_entered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS manual_odd_updated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS manual_odd_entered_by TEXT,
      ADD COLUMN IF NOT EXISTS manual_profit_units NUMERIC,
      ADD COLUMN IF NOT EXISTS manual_roi_percent NUMERIC,

      ADD COLUMN IF NOT EXISTS official_tracked_market_key TEXT,
      ADD COLUMN IF NOT EXISTS official_tracked_market_label TEXT,
      ADD COLUMN IF NOT EXISTS official_tracked_probability NUMERIC,
      ADD COLUMN IF NOT EXISTS official_tracked_decision_score NUMERIC,
      ADD COLUMN IF NOT EXISTS official_tracked_at TIMESTAMPTZ,

      ADD COLUMN IF NOT EXISTS prematch_final_market_key TEXT,
      ADD COLUMN IF NOT EXISTS prematch_final_market_label TEXT,
      ADD COLUMN IF NOT EXISTS prematch_final_probability NUMERIC,
      ADD COLUMN IF NOT EXISTS prematch_final_decision_score NUMERIC,
      ADD COLUMN IF NOT EXISTS prematch_final_captured_at TIMESTAMPTZ,

      ADD COLUMN IF NOT EXISTS official_market_won BOOLEAN,
      ADD COLUMN IF NOT EXISTS prematch_final_market_won BOOLEAN,
      ADD COLUMN IF NOT EXISTS market_changed BOOLEAN,
      ADD COLUMN IF NOT EXISTS market_change_outcome TEXT;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_predictions_manual_market_odd
    ON predictions(manual_market_odd);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_predictions_official_tracked_market
    ON predictions(official_tracked_market_key);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_predictions_prematch_final_market
    ON predictions(prematch_final_market_key);
  `);

  /*
   * Migration douce des cotes déjà saisies avant la création
   * du double suivi. Le marché officiel est celui auquel la cote
   * manuelle était déjà rattachée. Le dernier marché avant match
   * part du dernier snapshot connu et continuera ensuite à évoluer.
   */
  await pool.query(`
    UPDATE predictions
    SET
      official_tracked_market_key = COALESCE(
        official_tracked_market_key,
        manual_market_key,
        studio_market_key
      ),
      official_tracked_market_label = COALESCE(
        official_tracked_market_label,
        CASE
          WHEN COALESCE(manual_market_key, studio_market_key) = studio_market_key
          THEN studio_market_label
          ELSE manual_market_key
        END
      ),
      official_tracked_probability = COALESCE(
        official_tracked_probability,
        studio_probability
      ),
      official_tracked_decision_score = COALESCE(
        official_tracked_decision_score,
        studio_decision_score
      ),
      official_tracked_at = COALESCE(
        official_tracked_at,
        manual_odd_entered_at,
        manual_odd_updated_at
      ),
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
        studio_saved_at
      )
    WHERE manual_market_odd IS NOT NULL;
  `);
}

function requireOptionalAdminKey(req, res) {
  const configuredKey = String(process.env.ADMIN_API_KEY || "").trim();
  if (!configuredKey) return true;

  const receivedKey = String(req.headers["x-admin-key"] || "").trim();
  if (receivedKey === configuredKey) return true;

  res.status(401).json({
    ok: false,
    error: "Clé administrateur invalide.",
  });
  return false;
}

function parseBilanSnapshot(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return {};
}

function numberOrBilan(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstDefinedBilan(...values) {
  return values.find(
    (value) => value !== undefined && value !== null && value !== ""
  );
}

function getHighestScoreStudioMarket(prediction = {}) {
  const snapshot = parseBilanSnapshot(prediction.studio_snapshot);
  const markets = Array.isArray(snapshot?.markets)
    ? snapshot.markets
    : Array.isArray(snapshot?.studio?.markets)
      ? snapshot.studio.markets
      : [];

  if (markets.length === 0) return snapshot?.primaryMarket || {};

  return markets.reduce((best, current) => {
    if (!current) return best;
    if (!best) return current;

    const currentScore = numberOrBilan(
      current?.decision?.score ??
        current?.marketDecision?.score ??
        current?.decisionScore ??
        current?.score,
      Number.NEGATIVE_INFINITY
    );
    const bestScore = numberOrBilan(
      best?.decision?.score ??
        best?.marketDecision?.score ??
        best?.decisionScore ??
        best?.score,
      Number.NEGATIVE_INFINITY
    );

    return currentScore > bestScore ? current : best;
  }, null) || {};
}

function getGlobalDecisionCategory(prediction = {}) {
  const market = getHighestScoreStudioMarket(prediction);
  const type = String(
    firstDefinedBilan(
      market?.decision?.type,
      market?.marketDecision?.type,
      prediction.studio_decision_type,
      prediction.bet_status,
      ""
    )
  )
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (["VALUE_BET", "STRONG_OPPORTUNITY"].includes(type)) return "strong";
  if (["BET", "RECOMMENDED_BET", "OPPORTUNITY"].includes(type)) return "opportunity";
  if (["WATCH", "PRUDENCE", "TO_WATCH", "MOST_PROBABLE_MARKET", "À_SURVEILLER", "A_SURVEILLER"].includes(type)) return "watch";
  if (["AVOID", "BALANCED_MARKET"].includes(type)) return "avoid";

  const probability = numberOrBilan(
    firstDefinedBilan(
      market?.fairOdds?.calibratedProbability,
      market?.calibratedProbability,
      market?.probability,
      prediction.studio_probability,
      prediction.home_probability,
      prediction.draw_probability,
      prediction.away_probability
    ),
    0
  );
  const score = numberOrBilan(
    firstDefinedBilan(
      market?.decision?.score,
      market?.marketDecision?.score,
      market?.decisionScore,
      prediction.studio_decision_score,
      prediction.confidence
    ),
    0
  );
  const risk = numberOrBilan(prediction.risk, 50);
  const value = numberOrBilan(prediction.value_percentage, 0);

  if (probability >= 60 && score >= 65 && risk <= 55 && value >= 3) return "strong";
  if (probability >= 54 && score >= 58 && risk <= 65) return "opportunity";
  if (probability >= 47 || score >= 50) return "watch";

  // Aucun match terminé ne reste hors des quatre niveaux.
  return "avoid";
}

app.get("/public/bilan/stats", async (req, res) => {
  try {
    await ensureBilanV3Columns();

    const { rows } = await pool.query(`
      SELECT
        fixture_id,
        result_status,
        bet_status,
        confidence,
        risk,
        home_probability,
        draw_probability,
        away_probability,
        value_percentage,
        market_odd,
        manual_market_odd,
        won,
        profit,
        studio_snapshot,
        studio_probability,
        studio_decision_score,
        studio_decision_type
      FROM predictions
      WHERE result_status = 'COMPLETED'
    `);

    const decisionLevels = {
      strong: 0,
      opportunity: 0,
      watch: 0,
      avoid: 0,
    };

    let manualOddsCount = 0;
    for (const prediction of rows) {
      decisionLevels[getGlobalDecisionCategory(prediction)] += 1;
      if (Number(prediction.manual_market_odd) > 1) manualOddsCount += 1;
    }

    const baseStatsResponse = await pool.query(`
      SELECT
        COUNT(*)::INTEGER AS total_predictions,
        COUNT(*) FILTER (WHERE result_status = 'COMPLETED')::INTEGER AS completed_predictions,
        COUNT(*) FILTER (WHERE result_status = 'PENDING')::INTEGER AS pending_predictions,
        COUNT(*) FILTER (WHERE bet_status = 'NO_BET')::INTEGER AS no_bet,
        COUNT(*) FILTER (
          WHERE result_status = 'COMPLETED'
            AND bet_status <> 'NO_BET'
            AND won IS NOT NULL
        )::INTEGER AS settled_bets,
        COUNT(*) FILTER (WHERE won = TRUE)::INTEGER AS wins,
        COUNT(*) FILTER (WHERE won = FALSE)::INTEGER AS losses,
        COALESCE(SUM(profit) FILTER (
          WHERE result_status = 'COMPLETED' AND bet_status <> 'NO_BET'
        ), 0)::NUMERIC AS total_profit,
        COALESCE(AVG(confidence), 0)::NUMERIC AS average_confidence
      FROM predictions
    `);

    const row = baseStatsResponse.rows[0] || {};
    const settledBets = Number(row.settled_bets || 0);
    const wins = Number(row.wins || 0);
    const totalProfit = Number(row.total_profit || 0);

    return res.json({
      ok: true,
      stats: {
        totalPredictions: Number(row.total_predictions || 0),
        completedPredictions: Number(row.completed_predictions || 0),
        pendingPredictions: Number(row.pending_predictions || 0),
        noBet: Number(row.no_bet || 0),
        settledBets,
        wins,
        losses: Number(row.losses || 0),
        winRate: settledBets > 0 ? Number(((wins / settledBets) * 100).toFixed(1)) : 0,
        totalProfit: Number(totalProfit.toFixed(2)),
        roi: settledBets > 0 ? Number(((totalProfit / settledBets) * 100).toFixed(1)) : 0,
        averageConfidence: Number(Number(row.average_confidence || 0).toFixed(1)),
        decisionLevels,
        decisionLevelsTotal: Object.values(decisionLevels).reduce((sum, value) => sum + value, 0),
        manualOdds: {
          completedWithManualOdd: manualOddsCount,
          completedWithoutManualOdd: Math.max(0, rows.length - manualOddsCount),
        },
      },
    });
  } catch (error) {
    console.error("ERREUR /public/bilan/stats :", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Impossible de calculer les statistiques globales du Bilan.",
    });
  }
});


async function markStudioAnalysisStatus(
  fixtureId,
  status,
  errorMessage = null,
  { incrementAttempt = false } = {}
) {
  const allowedStatuses = new Set([
    "READY",
    "PENDING_API",
    "REBUILD_REQUIRED",
    "ERROR",
  ]);

  const normalizedStatus = String(status || "").toUpperCase();

  if (!allowedStatuses.has(normalizedStatus)) {
    throw new Error(`analysis_status invalide : ${normalizedStatus}`);
  }

  await pool.query(
    `
      UPDATE predictions
      SET
        analysis_status = $1,
        analysis_error = $2,
        analysis_status_updated_at = NOW(),
        studio_last_rebuild_at = CASE
          WHEN $3::boolean THEN NOW()
          ELSE studio_last_rebuild_at
        END,
        studio_rebuild_attempts = studio_rebuild_attempts +
          CASE WHEN $3::boolean THEN 1 ELSE 0 END,
        updated_at = NOW()
      WHERE fixture_id = $4
    `,
    [
      normalizedStatus,
      errorMessage ? String(errorMessage).slice(0, 2000) : null,
      Boolean(incrementAttempt),
      Number(fixtureId),
    ]
  );
}

function classifyStudioRebuildError(error) {
  const message = String(
    error?.response?.data?.message ||
    error?.response?.data?.error ||
    error?.message ||
    "Erreur inconnue"
  );

  const normalized = message.toLowerCase();
  const apiUnavailable =
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("429") ||
    normalized.includes("api_football") ||
    normalized.includes("api-football") ||
    normalized.includes("timeout") ||
    normalized.includes("econnreset") ||
    normalized.includes("enotfound");

  return {
    status: apiUnavailable ? "PENDING_API" : "ERROR",
    probableCause: apiUnavailable ? "API_INDISPONIBLE_OU_QUOTA" : "ERREUR_RECONSTRUCTION",
    message,
  };
}

/*
 * ADMIN — VÉRIFICATION MARCHÉ BILAN
 *
 * Liste les matchs terminés dont le marché principal Brain Studio
 * n'est pas suffisamment enregistré pour garantir :
 * BILAN = AI LAB = BRAIN STUDIO.
 */
app.get("/internal/admin/brainstudio/rebuild-needed", async (req, res) => {
  if (!requireOptionalAdminKey(req, res)) return;

  try {
    await ensureStudioPredictionColumns();

    const requestedLimit = Number(req.query.limit);
    const requestedOffset = Number(req.query.offset);

    const limit =
      Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 200)
        : 100;

    const offset =
      Number.isInteger(requestedOffset) && requestedOffset >= 0
        ? requestedOffset
        : 0;

    const auditWhere = `
      result_status = 'COMPLETED'
      AND (
        studio_snapshot IS NULL
        OR jsonb_typeof(studio_snapshot) <> 'object'
        OR studio_market_key IS NULL
        OR BTRIM(studio_market_key) = ''
        OR studio_market_label IS NULL
        OR BTRIM(studio_market_label) = ''
        OR studio_probability IS NULL
        OR studio_decision_score IS NULL
      )
    `;

    const [summaryResult, matchesResult] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE result_status = 'COMPLETED')::int AS total_completed,
          COUNT(*) FILTER (
            WHERE result_status = 'COMPLETED'
              AND NOT (
                studio_snapshot IS NULL
                OR jsonb_typeof(studio_snapshot) <> 'object'
                OR studio_market_key IS NULL
                OR BTRIM(studio_market_key) = ''
                OR studio_market_label IS NULL
                OR BTRIM(studio_market_label) = ''
                OR studio_probability IS NULL
                OR studio_decision_score IS NULL
              )
          )::int AS brain_studio_ok,
          COUNT(*) FILTER (WHERE ${auditWhere})::int AS needs_rebuild
        FROM predictions
      `),
      pool.query(
        `
          SELECT
            id,
            fixture_id,
            fixture_date,
            league_id,
            league_name,
            home_team_name,
            away_team_name,
            home_goals,
            away_goals,
            studio_market_key,
            studio_market_label,
            studio_probability,
            studio_decision_score,
            studio_decision_type,
            studio_decision_grade,
            studio_analysis_version,
            studio_saved_at,
          manual_market_odd,
manual_market_key,
manual_odd_source,
manual_odd_updated_at,
            analysis_status,
            analysis_error,
            analysis_status_updated_at,
            studio_rebuild_attempts,
            studio_last_rebuild_at,
            created_at,
            updated_at,
            ARRAY_REMOVE(ARRAY[
              CASE WHEN studio_snapshot IS NULL THEN 'SNAPSHOT_ABSENT' END,
              CASE
                WHEN studio_snapshot IS NOT NULL
                 AND jsonb_typeof(studio_snapshot) <> 'object'
                THEN 'SNAPSHOT_INVALIDE'
              END,
              CASE
                WHEN studio_market_key IS NULL OR BTRIM(studio_market_key) = ''
                THEN 'MARCHE_CLE_ABSENT'
              END,
              CASE
                WHEN studio_market_label IS NULL OR BTRIM(studio_market_label) = ''
                THEN 'MARCHE_LIBELLE_ABSENT'
              END,
              CASE WHEN studio_probability IS NULL THEN 'PROBABILITE_ABSENTE' END,
              CASE WHEN studio_decision_score IS NULL THEN 'DECISION_SCORE_ABSENT' END
            ], NULL) AS reasons
          FROM predictions
          WHERE ${auditWhere}
          ORDER BY
            fixture_date DESC NULLS LAST,
            updated_at DESC NULLS LAST,
            id DESC
          LIMIT $1 OFFSET $2
        `,
        [limit, offset]
      ),
    ]);

    const summaryRow = summaryResult.rows[0] || {};
    const needsRebuild = Number(summaryRow.needs_rebuild || 0);

    return res.json({
      ok: true,
      name: "Vérification marché Bilan",
      summary: {
        totalCompleted: Number(summaryRow.total_completed || 0),
        brainStudioOk: Number(summaryRow.brain_studio_ok || 0),
        needsRebuild,
      },
      count: matchesResult.rows.length,
      limit,
      offset,
      hasMore: offset + matchesResult.rows.length < needsRebuild,
      nextOffset:
        offset + matchesResult.rows.length < needsRebuild
          ? offset + matchesResult.rows.length
          : null,
      matches: matchesResult.rows.map((row) => {
        const reasons = Array.isArray(row.reasons) ? row.reasons : [];
        const probableCause =
          row.analysis_status === "PENDING_API"
            ? "API_INDISPONIBLE_OU_QUOTA"
            : reasons.includes("SNAPSHOT_ABSENT") && !row.studio_saved_at
              ? "ANALYSE_BRAIN_STUDIO_JAMAIS_SAUVEGARDEE"
              : "SNAPSHOT_INCOMPLET_OU_ANCIEN";

        return {
          ...row,
          status: row.analysis_status || "REBUILD_REQUIRED",
          probableCause,
        };
      }),
    });
  } catch (error) {
    console.error(
      "ERREUR /internal/admin/brainstudio/rebuild-needed :",
      error
    );

    return res.status(500).json({
      ok: false,
      name: "Vérification marché Bilan",
      error:
        error?.message ||
        "Impossible d'effectuer la vérification des marchés du Bilan.",
    });
  }
});
app.get(
  "/internal/admin/brainstudio/rebuild-status",
  async (req, res) => {
    if (!requireOptionalAdminKey(req, res)) {
      return;
    }

    return res.json({
      ok: true,

      adminRebuild: {
        running:
          adminStudioRebuildRunning,
      },

      manualSnapshotRebuild: {
        running:
          manualSnapshotRebuildRunning,
      },

      scheduler: {
        running:
          studioSchedulerRunning,
        lastStartedAt:
          studioSchedulerLastStartedAt,
        lastFinishedAt:
          studioSchedulerLastFinishedAt,
      },
    });
  }
);
app.post("/internal/admin/brainstudio/rebuild-missing", async (req, res) => {
  if (!requireOptionalAdminKey(req, res)) return;

if (adminStudioRebuildRunning) {
  return res.status(409).json({
    ok: false,
    code: "ADMIN_STUDIO_REBUILD_ALREADY_RUNNING",
    retryable: true,
    error:
      "Une reconstruction Admin Brain Studio est déjà en cours.",
  });
}

adminStudioRebuildRunning = true;
  try {
    await ensureStudioPredictionColumns();

    const requestedLimit = Number(req.body?.limit);
    const limit =
      Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 100)
        : 100;

    const requestedFixtureIds = Array.isArray(req.body?.fixtureIds)
      ? [...new Set(
          req.body.fixtureIds
            .map(Number)
            .filter((id) => Number.isInteger(id) && id > 0)
        )]
      : [];

    const params = [];
    let fixtureFilter = "";

    if (requestedFixtureIds.length > 0) {
      params.push(requestedFixtureIds);
      fixtureFilter = `AND fixture_id = ANY($${params.length}::int[])`;
    }

    params.push(limit);

    const candidatesResult = await pool.query(
      `
        SELECT fixture_id, home_team_name, away_team_name
        FROM predictions
        WHERE result_status = 'COMPLETED'
          AND (
            studio_snapshot IS NULL
            OR jsonb_typeof(studio_snapshot) <> 'object'
            OR NULLIF(BTRIM(studio_market_key), '') IS NULL
            OR NULLIF(BTRIM(studio_market_label), '') IS NULL
            OR studio_probability IS NULL
            OR studio_decision_score IS NULL
          )
          ${fixtureFilter}
        ORDER BY fixture_date ASC NULLS LAST, fixture_id ASC
        LIMIT $${params.length}
      `,
      params
    );

    const results = [];
    let rebuilt = 0;
    let pendingApi = 0;
    let failed = 0;

    for (const candidate of candidatesResult.rows) {
      const fixtureId = Number(candidate.fixture_id);

      try {
        await markStudioAnalysisStatus(
          fixtureId,
          "REBUILD_REQUIRED",
          null,
          { incrementAttempt: true }
        );

        const rebuiltResult = await rebuildAutomaticStudioSnapshot(
          fixtureId,
          { allowHistorical: true }
        );

        await markStudioAnalysisStatus(fixtureId, "READY");
        rebuilt += 1;

        results.push({
          fixtureId,
          homeTeam: candidate.home_team_name || null,
          awayTeam: candidate.away_team_name || null,
          ok: true,
          status: "READY",
          marketKey: rebuiltResult?.primaryMarket?.key || null,
          marketLabel: rebuiltResult?.primaryMarket?.label || null,
        });
      } catch (error) {
        const classification = classifyStudioRebuildError(error);

        await markStudioAnalysisStatus(
          fixtureId,
          classification.status,
          classification.message
        );

        if (classification.status === "PENDING_API") {
          pendingApi += 1;
        } else {
          failed += 1;
        }

        results.push({
          fixtureId,
          homeTeam: candidate.home_team_name || null,
          awayTeam: candidate.away_team_name || null,
          ok: false,
          status: classification.status,
          probableCause: classification.probableCause,
          error: classification.message,
        });
      }

      // Évite qu'une reconstruction massive enchaîne les analyses sans pause.
      await waitApiFootball(3000);
    }

    return res.json({
      ok: failed === 0,
      requested: candidatesResult.rows.length,
      processed: results.length,
      rebuilt,
      pendingApi,
      failed,
      remainingAuditRecommended: true,
      results,
    });
  } catch (error) {
    console.error(
      "ERREUR /internal/admin/brainstudio/rebuild-missing :",
      error
    );

    return res.status(500).json({
      ok: false,
      error: error?.message || "Impossible de reconstruire les analyses.",
    });
 } finally {
  adminStudioRebuildRunning = false;
}
});


function normalizeManualOddsMarketKey(value = "") {
  const key = String(value || "")
    .trim()
    .toUpperCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_");

  if (["HOME", "HOME_WIN", "1", "DOMICILE"].includes(key)) return "HOME";
  if (["DRAW", "X", "N", "NUL"].includes(key)) return "DRAW";
  if (["AWAY", "AWAY_WIN", "2", "EXTERIEUR", "EXTÉRIEUR"].includes(key)) {
    return "AWAY";
  }
  if (["OVER25", "OVER_25", "OVER_2_5"].includes(key)) return "OVER25";
  if (["UNDER25", "UNDER_25", "UNDER_2_5"].includes(key)) return "UNDER25";
  if (["BTTS", "BTTS_YES", "BOTH_TEAMS_SCORE", "YES_BTTS"].includes(key)) {
    return "BTTS_YES";
  }
  if (["BTTS_NO", "NO_BTTS"].includes(key)) return "BTTS_NO";

  return key;
}

function evaluateManualOddsMarketResult({
  marketKey,
  homeGoals,
  awayGoals,
} = {}) {
  if (
    homeGoals === null ||
    homeGoals === undefined ||
    awayGoals === null ||
    awayGoals === undefined
  ) {
    return null;
  }

  const home = Number(homeGoals);
  const away = Number(awayGoals);

  if (!Number.isFinite(home) || !Number.isFinite(away)) {
    return null;
  }

  const key = normalizeManualOddsMarketKey(marketKey);

  if (key === "HOME") return home > away;
  if (key === "DRAW") return home === away;
  if (key === "AWAY") return away > home;
  if (key === "OVER25") return home + away >= 3;
  if (key === "UNDER25") return home + away <= 2;
  if (key === "BTTS_YES") return home > 0 && away > 0;
  if (key === "BTTS_NO") return home === 0 || away === 0;

  return null;
}

function calculateManualBetPerformance({
  odd,
  stake = 1,
  predictionCorrect,
} = {}) {
  const normalizedOdd = Number(odd);
  const normalizedStake = Number(stake);

  if (
    !Number.isFinite(normalizedOdd) ||
    normalizedOdd <= 1 ||
    !Number.isFinite(normalizedStake) ||
    normalizedStake <= 0 ||
    typeof predictionCorrect !== "boolean"
  ) {
    return {
      profitUnits: null,
      roiPercent: null,
    };
  }

  const profitUnits = predictionCorrect
    ? normalizedStake * (normalizedOdd - 1)
    : -normalizedStake;

  const roiPercent =
    normalizedStake > 0
      ? (profitUnits / normalizedStake) * 100
      : null;

  return {
    profitUnits: Number(profitUnits.toFixed(2)),
    roiPercent:
      roiPercent === null
        ? null
        : Number(roiPercent.toFixed(2)),
  };
}

async function refreshManualOddsProfits() {
  await ensureBilanV3Columns();

  const result = await pool.query(`
    SELECT
      fixture_id,
      result_status,
      home_goals,
      away_goals,

      manual_market_odd,
      manual_stake_units,
      manual_profit_units,
      manual_roi_percent,

      official_tracked_market_key,
      prematch_final_market_key,

      official_market_won,
      prematch_final_market_won,
      market_changed,
      market_change_outcome
    FROM predictions
    WHERE manual_market_odd IS NOT NULL
      AND official_tracked_market_key IS NOT NULL
      AND result_status = 'COMPLETED'
      AND home_goals IS NOT NULL
      AND away_goals IS NOT NULL
  `);

  let updated = 0;
  let unchanged = 0;
  let unsupported = 0;

  for (const prediction of result.rows) {
    const officialWon =
      evaluateManualOddsMarketResult({
        marketKey:
          prediction.official_tracked_market_key,
        homeGoals: prediction.home_goals,
        awayGoals: prediction.away_goals,
      });

    const prematchMarketKey =
      prediction.prematch_final_market_key ||
      prediction.official_tracked_market_key;

    const prematchWon =
      evaluateManualOddsMarketResult({
        marketKey: prematchMarketKey,
        homeGoals: prediction.home_goals,
        awayGoals: prediction.away_goals,
      });

    if (typeof officialWon !== "boolean") {
      unsupported += 1;
      continue;
    }

    const normalizedOfficialKey =
      normalizeManualOddsMarketKey(
        prediction.official_tracked_market_key
      );

    const normalizedPrematchKey =
      normalizeManualOddsMarketKey(
        prematchMarketKey
      );

    const marketChanged =
      Boolean(normalizedOfficialKey) &&
      Boolean(normalizedPrematchKey) &&
      normalizedOfficialKey !== normalizedPrematchKey;

    let marketChangeOutcome = "INCOMPLETE";

    if (typeof prematchWon === "boolean") {
      if (!marketChanged) {
        marketChangeOutcome = officialWon
          ? "STABLE_WON"
          : "STABLE_LOST";
      } else if (!officialWon && prematchWon) {
        marketChangeOutcome = "BENEFICIAL";
      } else if (officialWon && !prematchWon) {
        marketChangeOutcome = "HARMFUL";
      } else if (officialWon && prematchWon) {
        marketChangeOutcome = "BOTH_WON";
      } else {
        marketChangeOutcome = "BOTH_LOST";
      }
    }

    const performance =
      calculateManualBetPerformance({
        odd: prediction.manual_market_odd,
        stake: prediction.manual_stake_units,
        predictionCorrect: officialWon,
      });

    const currentProfit =
      prediction.manual_profit_units === null
        ? null
        : Number(prediction.manual_profit_units);

    const currentRoi =
      prediction.manual_roi_percent === null
        ? null
        : Number(prediction.manual_roi_percent);

    const noChange =
      currentProfit === performance.profitUnits &&
      currentRoi === performance.roiPercent &&
      prediction.official_market_won === officialWon &&
      prediction.prematch_final_market_won === prematchWon &&
      prediction.market_changed === marketChanged &&
      prediction.market_change_outcome === marketChangeOutcome;

    if (noChange) {
      unchanged += 1;
      continue;
    }

    await pool.query(
      `
        UPDATE predictions
        SET
          manual_profit_units = $2,
          manual_roi_percent = $3,
          official_market_won = $4,
          prematch_final_market_won = $5,
          market_changed = $6,
          market_change_outcome = $7,
          updated_at = NOW()
        WHERE fixture_id = $1
      `,
      [
        prediction.fixture_id,
        performance.profitUnits,
        performance.roiPercent,
        officialWon,
        typeof prematchWon === "boolean"
          ? prematchWon
          : null,
        marketChanged,
        marketChangeOutcome,
      ]
    );

    updated += 1;
  }

  return {
    ok: true,
    scanned: result.rows.length,
    updated,
    unchanged,
    unsupported,
  };
}


/*
 * Route historique conservée pour compatibilité avec le panneau Admin actuel.
 * Elle liste les matchs terminés et accepte toujours le filtre missingOdd=1.
 */
app.get("/internal/admin/bilan/markets", async (req, res) => {
  if (!requireOptionalAdminKey(req, res)) return;

  try {
    await ensureBilanV3Columns();

    const onlyMissing = String(req.query.missingOdd || "") === "1";
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const { rows } = await pool.query(
      `
        SELECT
          fixture_id,
          fixture_date,
          league_id,
          league_name,
          home_team_name,
          away_team_name,
          home_goals,
          away_goals,
          studio_market_key,
          studio_market_label,
          studio_probability,
          studio_decision_type,
          studio_decision_score,
          result_status,
          won,
          market_odd,
          manual_market_odd,
          manual_stake_units,
          manual_profit_units,
          manual_roi_percent,
          manual_odd_source,
          manual_odd_entered_at,
          manual_odd_updated_at,
          manual_odd_entered_by
        FROM predictions
        WHERE result_status = 'COMPLETED'
          AND NULLIF(BTRIM(studio_market_key), '') IS NOT NULL
          AND ($1::boolean = FALSE OR manual_market_odd IS NULL)
        ORDER BY fixture_date DESC NULLS LAST, updated_at DESC NULLS LAST
        LIMIT $2 OFFSET $3
      `,
      [onlyMissing, limit, offset]
    );

    return res.json({
      ok: true,
      count: rows.length,
      limit,
      offset,
      markets: rows,
    });
  } catch (error) {
    console.error("ERREUR /internal/admin/bilan/markets :", error);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

/*
 * Nouvelle route principale : tous les matchs Brain Studio dont le marché
 * principal est connu. Par défaut, seules les ligues actives du League Manager
 * sont affichées. Les cotes déjà saisies restent modifiables.
 *
 * status = ALL | MISSING | FILLED | SETTLED | PENDING
 */
app.get("/internal/admin/manual-odds", async (req, res) => {
  if (!requireOptionalAdminKey(req, res)) return;

  try {
    await ensureBilanV3Columns();
    await ensureLeagueManagerTables();
    await refreshManualOddsProfits();

    const status = String(req.query.status || "ALL")
      .trim()
      .toUpperCase();

    const activeOnly =
      String(req.query.activeOnly ?? "1").trim() !== "0";

    const limit = Math.min(
      500,
      Math.max(1, Number(req.query.limit) || 100)
    );

    const offset = Math.max(
      0,
      Number(req.query.offset) || 0
    );

    const search = String(req.query.search || "")
      .trim()
      .toLowerCase();

    const values = [];
    const where = [
      "NULLIF(BTRIM(p.studio_market_key), '') IS NOT NULL",
    ];

    if (activeOnly) {
      where.push("ls.enabled = TRUE");
    }

    if (status === "MISSING") {
      where.push("p.manual_market_odd IS NULL");
    } else if (status === "FILLED") {
      where.push("p.manual_market_odd IS NOT NULL");
    } else if (status === "SETTLED") {
      where.push(
        "p.manual_market_odd IS NOT NULL",
        "p.manual_profit_units IS NOT NULL"
      );
    } else if (status === "PENDING") {
      where.push(
        "p.manual_market_odd IS NOT NULL",
        "p.manual_profit_units IS NULL"
      );
    }

    if (search) {
      values.push(`%${search}%`);
      where.push(
        `(LOWER(COALESCE(p.home_team_name, '')) LIKE $${values.length}
          OR LOWER(COALESCE(p.away_team_name, '')) LIKE $${values.length}
          OR LOWER(COALESCE(p.league_name, '')) LIKE $${values.length}
          OR CAST(p.fixture_id AS TEXT) LIKE $${values.length})`
      );
    }

    values.push(limit);
    const limitParameter = `$${values.length}`;

    values.push(offset);
    const offsetParameter = `$${values.length}`;

    const result = await pool.query(
      `
        SELECT
          p.id,
          p.fixture_id,
          p.fixture_date,
          p.league_id,
          p.league_name,
          COALESCE(ls.enabled, FALSE) AS league_enabled,
          COALESCE(ls.priority, 'NORMAL') AS league_priority,

          p.home_team_name,
          p.away_team_name,
          p.home_goals,
          p.away_goals,
          p.result_status,

          p.studio_market_key,
          p.studio_market_label,
          p.studio_probability,
          p.studio_decision_score,
          p.studio_decision_type,
          p.studio_decision_grade,

          p.market_odd AS api_market_odd,

          p.manual_market_odd,
          p.manual_stake_units,
          p.manual_profit_units,
          p.manual_roi_percent,
          p.manual_odd_source,
          p.manual_odd_entered_at,
          p.manual_odd_updated_at,
          p.manual_odd_entered_by,

          p.official_tracked_market_key,
          p.official_tracked_market_label,
          p.official_tracked_probability,
          p.official_tracked_decision_score,
          p.official_tracked_at,
          p.official_market_won,

          p.prematch_final_market_key,
          p.prematch_final_market_label,
          p.prematch_final_probability,
          p.prematch_final_decision_score,
          p.prematch_final_captured_at,
          p.prematch_final_market_won,

          p.market_changed,
          p.market_change_outcome,

          p.updated_at
        FROM predictions p
        LEFT JOIN league_settings ls
          ON ls.league_id = p.league_id
        WHERE ${where.join(" AND ")}
        ORDER BY
          CASE WHEN p.manual_market_odd IS NULL THEN 0 ELSE 1 END ASC,
          p.fixture_date DESC NULLS LAST,
          p.fixture_id DESC
        LIMIT ${limitParameter}
        OFFSET ${offsetParameter}
      `,
      values
    );

    const summaryResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE NULLIF(BTRIM(p.studio_market_key), '') IS NOT NULL
            AND ls.enabled = TRUE
        )::INTEGER AS total,

        COUNT(*) FILTER (
          WHERE NULLIF(BTRIM(p.studio_market_key), '') IS NOT NULL
            AND ls.enabled = TRUE
            AND p.manual_market_odd IS NULL
        )::INTEGER AS missing,

        COUNT(*) FILTER (
          WHERE NULLIF(BTRIM(p.studio_market_key), '') IS NOT NULL
            AND ls.enabled = TRUE
            AND p.manual_market_odd IS NOT NULL
        )::INTEGER AS filled,

        COUNT(*) FILTER (
          WHERE NULLIF(BTRIM(p.studio_market_key), '') IS NOT NULL
            AND ls.enabled = TRUE
            AND p.manual_market_odd IS NOT NULL
            AND p.manual_profit_units IS NOT NULL
        )::INTEGER AS settled,

        COUNT(*) FILTER (
          WHERE NULLIF(BTRIM(p.studio_market_key), '') IS NOT NULL
            AND ls.enabled = TRUE
            AND p.manual_market_odd IS NOT NULL
            AND p.manual_profit_units IS NULL
        )::INTEGER AS pending,

        COALESCE(
          SUM(p.manual_stake_units) FILTER (
            WHERE ls.enabled = TRUE
              AND p.manual_profit_units IS NOT NULL
          ),
          0
        )::NUMERIC AS total_stake,

        COALESCE(
          SUM(p.manual_profit_units) FILTER (
            WHERE ls.enabled = TRUE
              AND p.manual_profit_units IS NOT NULL
          ),
          0
        )::NUMERIC AS total_profit

      FROM predictions p
      LEFT JOIN league_settings ls
        ON ls.league_id = p.league_id
    `);

    const summary = summaryResult.rows[0] || {};
    const totalStake = Number(summary.total_stake || 0);
    const totalProfit = Number(summary.total_profit || 0);

    return res.json({
      ok: true,
      summary: {
        total: Number(summary.total || 0),
        missing: Number(summary.missing || 0),
        filled: Number(summary.filled || 0),
        settled: Number(summary.settled || 0),
        pending: Number(summary.pending || 0),
        totalStake: Number(totalStake.toFixed(2)),
        totalProfit: Number(totalProfit.toFixed(2)),
        roi:
          totalStake > 0
            ? Number(((totalProfit / totalStake) * 100).toFixed(2))
            : null,
      },
      rows: result.rows,
      pagination: {
        limit,
        offset,
      },
      filters: {
        status,
        activeOnly,
        search,
      },
    });
  } catch (error) {
    console.error("ERREUR LISTE COTES MANUELLES :", error);

    return res.status(500).json({
      ok: false,
      rows: [],
      error:
        error?.message ||
        "Impossible de charger les cotes manuelles.",
    });
  }
});



/*
 * Performance financière publique en lecture seule.
 * Le suivi officiel commence le 02/08/2026 et utilise uniquement :
 * - le marché principal Brain Studio ;
 * - une cote saisie manuellement par l'administrateur ;
 * - un match joué à partir du 02/08/2026 ;
 * - un résultat financier déjà calculé.
 *
 * Cette route ne permet aucune modification et n'expose pas les outils Admin.
 */
const REAL_PERFORMANCE_TRACKING_START_DATE =
  "2026-08-02";

app.get(
  "/public/bilan/real-performance",
  async (req, res) => {
    try {
      await ensureBilanV3Columns();
      await refreshManualOddsProfits();

      const result = await pool.query(
        `
          SELECT
            COUNT(
              DISTINCT p.fixture_id
            )::INTEGER AS settled_matches,

            COALESCE(
              SUM(
                p.manual_stake_units
              ) FILTER (
                WHERE
                  p.manual_profit_units
                    IS NOT NULL
              ),
              0
            )::NUMERIC AS total_stake,

            COALESCE(
              SUM(
                p.manual_profit_units
              ) FILTER (
                WHERE
                  p.manual_profit_units
                    IS NOT NULL
              ),
              0
            )::NUMERIC AS total_profit,

            ROUND(
              (
                SUM(
                  p.manual_market_odd *
                  p.manual_stake_units
                ) FILTER (
                  WHERE
                    p.manual_profit_units
                      IS NOT NULL
                    AND p.manual_market_odd
                      IS NOT NULL
                    AND p.manual_stake_units
                      IS NOT NULL
                    AND p.manual_stake_units > 0
                )
                /
                NULLIF(
                  SUM(
                    p.manual_stake_units
                  ) FILTER (
                    WHERE
                      p.manual_profit_units
                        IS NOT NULL
                      AND p.manual_market_odd
                        IS NOT NULL
                      AND p.manual_stake_units
                        IS NOT NULL
                      AND p.manual_stake_units > 0
                  ),
                  0
                )
              )::NUMERIC,
              3
            ) AS average_odd

          FROM predictions p

          WHERE
            p.fixture_date::date >=
              $1::date

            AND NULLIF(
              BTRIM(
                p.studio_market_key
              ),
              ''
            ) IS NOT NULL

            AND p.manual_market_odd
              IS NOT NULL

            AND p.manual_profit_units
              IS NOT NULL
        `,
        [
          REAL_PERFORMANCE_TRACKING_START_DATE,
        ]
      );

      const row =
        result.rows[0] || {};

      const settledMatches =
        Number(
          row.settled_matches || 0
        );

      const totalStake =
        Number(
          row.total_stake || 0
        );

      const totalProfit =
        Number(
          row.total_profit || 0
        );

      const averageOdd =
        row.average_odd === null ||
        row.average_odd === undefined
          ? null
          : Number(
              row.average_odd
            );

      const roi =
        totalStake > 0
          ? Number(
              (
                (
                  totalProfit /
                  totalStake
                ) *
                100
              ).toFixed(2)
            )
          : null;

      return res.json({
        ok: true,

        trackingStartDate:
          REAL_PERFORMANCE_TRACKING_START_DATE,

        settledMatches,

        totalStake:
          Number(
            totalStake.toFixed(2)
          ),

        totalProfit:
          Number(
            totalProfit.toFixed(2)
          ),

        roi,

        averageOdd:
          Number.isFinite(
            averageOdd
          )
            ? Number(
                averageOdd.toFixed(2)
              )
            : null,
      });
    } catch (error) {
      console.error(
        "ERREUR PERFORMANCE FINANCIÈRE RÉELLE :",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          trackingStartDate:
            REAL_PERFORMANCE_TRACKING_START_DATE,

          settledMatches: 0,
          totalStake: 0,
          totalProfit: 0,
          roi: null,
          averageOdd: null,

          error:
            error?.message ||
            "Impossible de charger la performance financière réelle.",
        });
    }
  }
);
async function saveOrUpdateManualOdd(req, res) {
  if (!requireOptionalAdminKey(req, res)) return;

  try {
    await ensureBilanV3Columns();

    const fixtureId = Number(req.params.fixtureId);
    const manualOdd = Number(
      req.body?.manualOdd ??
      req.body?.odd
    );
    const stakeUnits = Number(
      req.body?.stakeUnits ?? 1
    );

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide.",
      });
    }

    if (
      !Number.isFinite(manualOdd) ||
      manualOdd <= 1 ||
      manualOdd > 1000
    ) {
      return res.status(400).json({
        ok: false,
        error: "La cote doit être supérieure à 1.",
      });
    }

    if (
      !Number.isFinite(stakeUnits) ||
      stakeUnits <= 0 ||
      stakeUnits > 10000
    ) {
      return res.status(400).json({
        ok: false,
        error: "La mise doit être supérieure à 0.",
      });
    }

    const predictionResult = await pool.query(
      `
        SELECT
          fixture_id,
          result_status,
          home_goals,
          away_goals,
          studio_market_key,
          studio_market_label,
          studio_probability,
          studio_decision_score,
          manual_market_odd
        FROM predictions
        WHERE fixture_id = $1
        LIMIT 1
      `,
      [fixtureId]
    );

    const prediction = predictionResult.rows[0];

    if (!prediction) {
      return res.status(404).json({
        ok: false,
        error: "Analyse introuvable.",
      });
    }

    if (!String(prediction.studio_market_key || "").trim()) {
      return res.status(409).json({
        ok: false,
        error: "Le marché principal Brain Studio est absent.",
      });
    }

    const predictionCorrect =
      prediction.result_status === "COMPLETED"
        ? evaluateManualOddsMarketResult({
            marketKey: prediction.studio_market_key,
            homeGoals: prediction.home_goals,
            awayGoals: prediction.away_goals,
          })
        : null;

    const performance =
      calculateManualBetPerformance({
        odd: manualOdd,
        stake: stakeUnits,
        predictionCorrect,
      });

    const editor = String(
      req.body?.enteredBy || "administrator"
    )
      .trim()
      .slice(0, 200);

    const source = String(
      req.body?.source || "Saisie manuelle"
    )
      .trim()
      .slice(0, 200);

    const result = await pool.query(
      `
        UPDATE predictions
        SET
          manual_market_odd = $2,
          manual_market_key = studio_market_key,
          manual_stake_units = $3,
          manual_profit_units = $4,
          manual_roi_percent = $5,
          manual_odd_source = $6,
          manual_odd_entered_at =
            COALESCE(manual_odd_entered_at, NOW()),
          manual_odd_updated_at = NOW(),
          manual_odd_entered_by = $7,

          /*
           * La saisie Admin fige le pari officiel suivi financièrement.
           * Une nouvelle sauvegarde explicite avant match permet à
           * l'administrateur de remplacer volontairement ce pari officiel.
           */
          official_tracked_market_key = studio_market_key,
          official_tracked_market_label = studio_market_label,
          official_tracked_probability = studio_probability,
          official_tracked_decision_score = studio_decision_score,
          official_tracked_at = NOW(),

          /* Point de départ du dernier marché avant match. */
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
        RETURNING *
      `,
      [
        fixtureId,
        manualOdd,
        stakeUnits,
        performance.profitUnits,
        performance.roiPercent,
        source,
        editor,
      ]
    );

    return res.json({
      ok: true,
      created:
        prediction.manual_market_odd === null ||
        prediction.manual_market_odd === undefined,
      updated:
        prediction.manual_market_odd !== null &&
        prediction.manual_market_odd !== undefined,
      prediction: result.rows[0],
    });
  } catch (error) {
    console.error("ERREUR ENREGISTREMENT COTE MANUELLE :", error);

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Impossible d’enregistrer la cote.",
    });
  }
}

/*
 * Nouvelle route PATCH et ancienne route PUT :
 * elles utilisent exactement la même logique et permettent la modification.
 */
app.patch(
  "/internal/admin/manual-odds/:fixtureId",
  saveOrUpdateManualOdd
);

app.put(
  "/internal/admin/bilan/markets/:fixtureId/odd",
  saveOrUpdateManualOdd
);

app.delete(
  "/internal/admin/manual-odds/:fixtureId",
  async (req, res) => {
    if (!requireOptionalAdminKey(req, res)) return;

    try {
      await ensureBilanV3Columns();

      const fixtureId = Number(req.params.fixtureId);

      if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "fixtureId invalide.",
        });
      }

      const result = await pool.query(
        `
          UPDATE predictions
          SET
            manual_market_odd = NULL,
          manual_market_key = NULL,
            manual_stake_units = 1,
            manual_profit_units = NULL,
            manual_roi_percent = NULL,
            manual_odd_source = NULL,
            manual_odd_entered_at = NULL,
            manual_odd_updated_at = NOW(),
            manual_odd_entered_by = NULL,
            official_tracked_market_key = NULL,
            official_tracked_market_label = NULL,
            official_tracked_probability = NULL,
            official_tracked_decision_score = NULL,
            official_tracked_at = NULL,
            official_market_won = NULL,
            prematch_final_market_won = NULL,
            market_changed = NULL,
            market_change_outcome = NULL,
            updated_at = NOW()
          WHERE fixture_id = $1
          RETURNING fixture_id
        `,
        [fixtureId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error: "Analyse introuvable.",
        });
      }

      return res.json({
        ok: true,
        fixtureId,
      });
    } catch (error) {
      console.error("ERREUR SUPPRESSION COTE MANUELLE :", error);

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Impossible de supprimer la cote.",
      });
    }
  }
);

app.post(
  "/internal/admin/manual-odds/refresh-profits",
  async (req, res) => {
    if (!requireOptionalAdminKey(req, res)) return;

    try {
      const result = await refreshManualOddsProfits();
      return res.json(result);
    } catch (error) {
      console.error("ERREUR RECALCUL PROFITS MANUELS :", error);

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Impossible de recalculer les profits.",
      });
    }
  }
);


/* ==========================================================================\n * DAILY TICKET V2 — SAFE / FUN / MEILLEURE VALUE + ÉDITIONS 12H / 18H / 21H\n * ========================================================================== */
const DAILY_TICKET_SLOTS = Object.freeze({
  "12H": 12,
  "18H": 18,
  "21H": 21,
});

const DAILY_TICKET_TARGET_FUN_ODDS = 1.9;
const DAILY_TICKET_MAX_FUN_SELECTIONS = 3;
const DAILY_TICKET_MIN_FUN_DECISION_SCORE = 50;
const DAILY_TICKET_SCHEDULER_INTERVAL_MS = 60 * 1000;
const DAILY_TICKET_SLOT_GRACE_MINUTES = 20;

let dailyTicketSchedulerRunning = false;
let dailyTicketSettlementRunning = false;

async function ensureDailyTicketTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_ticket_snapshots (
      id BIGSERIAL PRIMARY KEY,
      ticket_date DATE NOT NULL,
      slot TEXT NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      safe_ticket JSONB NOT NULL DEFAULT '{}'::jsonb,
      fun_ticket JSONB NOT NULL DEFAULT '{}'::jsonb,
      best_value_ticket JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

      safe_result_status TEXT NOT NULL DEFAULT 'PENDING',
      fun_result_status TEXT NOT NULL DEFAULT 'PENDING',
      value_result_status TEXT NOT NULL DEFAULT 'PENDING',

      safe_profit_units NUMERIC,
      fun_profit_units NUMERIC,
      value_profit_units NUMERIC,

      total_stake_units NUMERIC NOT NULL DEFAULT 0,
      total_profit_units NUMERIC,
      roi_percent NUMERIC,

      settled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT daily_ticket_snapshots_slot_check
        CHECK (slot IN ('12H', '18H', '21H', 'ON_DEMAND')),

      CONSTRAINT daily_ticket_snapshots_unique_date_slot
        UNIQUE (ticket_date, slot)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_daily_ticket_snapshots_date
    ON daily_ticket_snapshots(ticket_date DESC, generated_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_daily_ticket_snapshots_unsettled
    ON daily_ticket_snapshots(settled_at)
    WHERE settled_at IS NULL;
  `);
}

function parseDailyTicketJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function normalizeDailyTicketDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function getParisDateTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function normalizeDailyTicketSlot(value) {
  const slot = String(value || "").trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(DAILY_TICKET_SLOTS, slot)) {
    return slot;
  }
  if (slot === "ON_DEMAND") return slot;
  return null;
}

function dailyTicketNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundDailyTicket(value, decimals = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** decimals;
  return Math.round(number * factor) / factor;
}

function getDailyTicketMarketDecisionScore(market = {}, prediction = {}) {
  return dailyTicketNumber(
    market?.decision?.score ??
      market?.marketDecision?.score ??
      market?.decisionScore ??
      market?.score ??
      prediction.studio_decision_score,
    0
  );
}

function getDailyTicketMarketProbability(market = {}, prediction = {}) {
  return dailyTicketNumber(
    market?.fairOdds?.calibratedProbability ??
      market?.calibratedProbability ??
      market?.probability ??
      prediction.studio_probability,
    0
  );
}

function getDailyTicketMarketOdd(market = {}, prediction = {}) {
  const marketKey = normalizeManualOddsMarketKey(
    market?.key || market?.marketKey || ""
  );
  const manualKey = normalizeManualOddsMarketKey(
    prediction.manual_market_key || ""
  );
  const manualOdd = dailyTicketNumber(prediction.manual_market_odd, null);

  if (
    marketKey &&
    manualKey &&
    marketKey === manualKey &&
    manualOdd !== null &&
    manualOdd > 1
  ) {
    return {
      odd: manualOdd,
      source: "MANUAL_ADMIN",
      bookmaker:
        prediction.manual_odd_source ||
        prediction.manual_odd_entered_by ||
        "Admin Football AI Pro",
      isManual: true,
    };
  }

  const odd = dailyTicketNumber(
    market?.fairOdds?.bookmakerOdds ??
      market?.bookmakerOdds ??
      market?.odds?.marketOdd ??
      market?.marketOdd,
    null
  );

  return {
    odd: odd !== null && odd > 1 ? odd : null,
    source:
      market?.fairOdds?.bookmakerSource ||
      market?.bookmakerSource ||
      market?.oddsSource ||
      null,
    bookmaker:
      market?.fairOdds?.bookmaker ||
      market?.bookmaker ||
      null,
    isManual: false,
  };
}

function isSupportedDailyTicketMarketKey(value) {
  return [
    "HOME",
    "DRAW",
    "AWAY",
    "OVER25",
    "UNDER25",
    "BTTS_YES",
    "BTTS_NO",
  ].includes(normalizeManualOddsMarketKey(value));
}

function extractDailyTicketMarkets(prediction = {}) {
  const snapshot = parseDailyTicketJson(prediction.studio_snapshot, {});
  const snapshotMarkets = Array.isArray(snapshot?.markets)
    ? snapshot.markets
    : Array.isArray(snapshot?.studio?.markets)
      ? snapshot.studio.markets
      : [];

  const fallbackMarket =
    snapshot?.primaryMarket ||
    snapshot?.bestDecision ||
    (prediction.studio_market_key
      ? {
          key: prediction.studio_market_key,
          label: prediction.studio_market_label,
          probability: prediction.studio_probability,
          decisionScore: prediction.studio_decision_score,
        }
      : null);

  const markets = snapshotMarkets.length > 0
    ? snapshotMarkets
    : fallbackMarket
      ? [fallbackMarket]
      : [];

  const unique = new Map();

  for (const market of markets) {
    const normalizedKey = normalizeManualOddsMarketKey(
      market?.key || market?.marketKey || ""
    );

    if (!normalizedKey || !isSupportedDailyTicketMarketKey(normalizedKey)) {
      continue;
    }

    const decisionScore = getDailyTicketMarketDecisionScore(market, prediction);
    const probability = getDailyTicketMarketProbability(market, prediction);
    const oddData = getDailyTicketMarketOdd(market, prediction);
    const fairOdds = dailyTicketNumber(
      market?.fairOdds?.fairOdds ??
        market?.fairOddsValue ??
        market?.rawFairOdds,
      probability > 0 ? 100 / probability : null
    );

    const valuePercent =
      oddData.odd !== null && probability > 0
        ? roundDailyTicket((probability / 100) * oddData.odd * 100 - 100, 2)
        : null;

    const candidate = {
      id: `${prediction.fixture_id}-${normalizedKey}`,
      fixtureId: Number(prediction.fixture_id),
      matchId: Number(prediction.fixture_id),
      match: {
        home: prediction.home_team_name || "Domicile",
        away: prediction.away_team_name || "Extérieur",
        competition: prediction.league_name || "Compétition inconnue",
        kickoff: prediction.fixture_date || null,
        date: prediction.fixture_date
          ? String(prediction.fixture_date).slice(0, 10)
          : null,
      },
      market: {
        key: normalizedKey,
        label:
          market?.label ||
          market?.marketLabel ||
          prediction.studio_market_label ||
          normalizedKey,
        family: market?.family || null,
      },
      decisionScore: roundDailyTicket(decisionScore, 1) || 0,
      probability: roundDailyTicket(probability, 1) || 0,
      confidence: roundDailyTicket(
        market?.decision?.confidence ?? prediction.confidence,
        1
      ),
      risk: roundDailyTicket(
        market?.decision?.risk ?? prediction.risk,
        1
      ),
      consensus: roundDailyTicket(
        market?.decision?.marketConsensus?.score ??
          market?.consensusScore ??
          prediction.studio_decision_score,
        1
      ),
      bookmakerOdds: oddData.odd,
      bookmaker: oddData.bookmaker,
      oddsSource: oddData.source,
      manualOdds: oddData.isManual,
      fairOdds: roundDailyTicket(fairOdds, 2),
      valueEdge: valuePercent,
      expectedValuePercent: valuePercent,
      resultStatus: "PENDING",
    };

    const previous = unique.get(normalizedKey);
    if (!previous || candidate.decisionScore > previous.decisionScore) {
      unique.set(normalizedKey, candidate);
    }
  }

  return Array.from(unique.values());
}

function selectDailySafeTicket(candidates = []) {
  const selection = [...candidates].sort(
    (a, b) =>
      b.decisionScore - a.decisionScore ||
      b.probability - a.probability
  )[0] || null;

  return {
    available: Boolean(selection),
    title: "SAFE",
    selection,
    selections: selection ? [selection] : [],
    selectionCount: selection ? 1 : 0,
    totalOdds: selection?.bookmakerOdds ?? null,
    combinedOdds: selection?.bookmakerOdds ?? null,
    resultStatus: "PENDING",
    profitUnits: null,
    message: selection
      ? "Marché possédant le meilleur Decision Score global au moment de cette édition."
      : "Aucun marché Brain Studio exploitable pour cette édition.",
  };
}

function compareFunCombination(first, second) {
  if (!second) return -1;

  const firstReached = first.combinedOdds >= DAILY_TICKET_TARGET_FUN_ODDS;
  const secondReached = second.combinedOdds >= DAILY_TICKET_TARGET_FUN_ODDS;

  if (firstReached !== secondReached) return firstReached ? -1 : 1;

  if (firstReached && secondReached) {
    const firstDistance = first.combinedOdds - DAILY_TICKET_TARGET_FUN_ODDS;
    const secondDistance = second.combinedOdds - DAILY_TICKET_TARGET_FUN_ODDS;
    if (firstDistance !== secondDistance) return firstDistance - secondDistance;
  } else if (first.combinedOdds !== second.combinedOdds) {
    return second.combinedOdds - first.combinedOdds;
  }

  if (first.averageDecisionScore !== second.averageDecisionScore) {
    return second.averageDecisionScore - first.averageDecisionScore;
  }

  return first.selections.length - second.selections.length;
}

function selectDailyFunTicket(candidates = [], safeSelection = null) {
  const safeFixtureId = safeSelection?.fixtureId || null;
  const oddsCandidates = candidates
    .filter((candidate) => candidate.bookmakerOdds > 1)
    .filter((candidate) => candidate.decisionScore >= DAILY_TICKET_MIN_FUN_DECISION_SCORE)
    .filter((candidate) => candidate.fixtureId !== safeFixtureId)
    .sort(
      (a, b) =>
        b.decisionScore - a.decisionScore ||
        b.probability - a.probability
    )
    .slice(0, 30);

  const combinations = [];

  function pushCombination(selections) {
    const fixtureIds = new Set(selections.map((selection) => selection.fixtureId));
    if (fixtureIds.size !== selections.length) return;

    const combinedOdds = roundDailyTicket(
      selections.reduce(
        (product, selection) => product * Number(selection.bookmakerOdds),
        1
      ),
      2
    );

    const combinedProbability = roundDailyTicket(
      selections.reduce(
        (product, selection) => product * (Number(selection.probability) / 100),
        1
      ) * 100,
      1
    );

    const averageDecisionScore = roundDailyTicket(
      selections.reduce((sum, selection) => sum + selection.decisionScore, 0) /
        selections.length,
      1
    );

    combinations.push({
      selections,
      combinedOdds,
      combinedProbability,
      averageDecisionScore,
    });
  }

  for (let i = 0; i < oddsCandidates.length; i += 1) {
    pushCombination([oddsCandidates[i]]);

    for (let j = i + 1; j < oddsCandidates.length; j += 1) {
      pushCombination([oddsCandidates[i], oddsCandidates[j]]);

      for (let k = j + 1; k < oddsCandidates.length; k += 1) {
        pushCombination([
          oddsCandidates[i],
          oddsCandidates[j],
          oddsCandidates[k],
        ]);
      }
    }
  }

  combinations.sort(compareFunCombination);
  const best = combinations[0] || null;

  return {
    available: Boolean(best),
    title: "FUN",
    selections: best?.selections || [],
    selectionCount: best?.selections?.length || 0,
    combinedOdds: best?.combinedOdds ?? null,
    totalOdds: best?.combinedOdds ?? null,
    combinedProbability: best?.combinedProbability ?? null,
    averageDecisionScore: best?.averageDecisionScore ?? null,
    targetOdds: DAILY_TICKET_TARGET_FUN_ODDS,
    targetReached:
      Boolean(best) && best.combinedOdds >= DAILY_TICKET_TARGET_FUN_ODDS,
    resultStatus: "PENDING",
    profitUnits: null,
    message: !best
      ? "Aucune combinaison avec cote disponible n'a pu être construite."
      : best.combinedOdds >= DAILY_TICKET_TARGET_FUN_ODDS
        ? `Combiné optimisé pour atteindre au moins ${DAILY_TICKET_TARGET_FUN_ODDS.toFixed(2)}.`
        : `Meilleure combinaison disponible, mais la cible ${DAILY_TICKET_TARGET_FUN_ODDS.toFixed(2)} n'est pas atteinte.`,
  };
}

function selectDailyBestValueTicket(candidates = []) {
  const selection = candidates
    .filter((candidate) => candidate.manualOdds === true)
    .filter((candidate) => candidate.bookmakerOdds > 1)
    .filter((candidate) => candidate.valueEdge !== null)
    .filter((candidate) => candidate.valueEdge > 0)
    .sort(
      (a, b) =>
        b.valueEdge - a.valueEdge ||
        b.decisionScore - a.decisionScore
    )[0] || null;

  return {
    available: Boolean(selection),
    title: "MEILLEURE VALUE",
    selection,
    selections: selection ? [selection] : [],
    selectionCount: selection ? 1 : 0,
    totalOdds: selection?.bookmakerOdds ?? null,
    valuePercent: selection?.valueEdge ?? null,
    resultStatus: "PENDING",
    profitUnits: null,
    message: selection
      ? "Meilleure Value positive calculée avec une cote officielle saisie dans l'Admin."
      : "Aucune Value positive avec cote Admin n'est disponible pour cette édition.",
  };
}

async function loadDailyTicketCandidates(ticketDate, generatedAt = new Date()) {
  const result = await pool.query(
    `
      SELECT
        fixture_id,
        fixture_date,
        league_name,
        home_team_name,
        away_team_name,
        confidence,
        risk,

        studio_market_key,
        studio_market_label,
        studio_probability,
        studio_decision_score,
        studio_snapshot,

        manual_market_odd,
        manual_market_key,
        manual_odd_source,
        manual_odd_entered_by

      FROM predictions
      WHERE (fixture_date AT TIME ZONE 'Europe/Paris')::date = $1::date
        AND fixture_date > $2::timestamptz
        AND NULLIF(BTRIM(COALESCE(studio_market_key, '')), '') IS NOT NULL
      ORDER BY fixture_date ASC, fixture_id ASC
    `,
    [ticketDate, generatedAt.toISOString()]
  );

  const candidates = [];
  const matches = [];

  for (const prediction of result.rows) {
    const markets = extractDailyTicketMarkets(prediction);
    candidates.push(...markets);
    matches.push({
      fixtureId: Number(prediction.fixture_id),
      home: prediction.home_team_name,
      away: prediction.away_team_name,
      kickoff: prediction.fixture_date,
      marketCount: markets.length,
      hasManualOdd: Number(prediction.manual_market_odd) > 1,
    });
  }

  return {
    candidates,
    matches,
    sourceRows: result.rows.length,
  };
}

async function generateDailyTicketSnapshot({
  ticketDate,
  slot,
  force = false,
  source = "scheduler",
  generatedAt = new Date(),
} = {}) {
  await ensureDailyTicketTables();
  await ensureBilanV3Columns();

  const normalizedDate = normalizeDailyTicketDate(ticketDate);
  const normalizedSlot = normalizeDailyTicketSlot(slot);

  if (!normalizedDate) {
    throw new Error("Date de ticket invalide (format attendu : YYYY-MM-DD). ");
  }

  if (!normalizedSlot) {
    throw new Error("Créneau de ticket invalide.");
  }

  if (!force) {
    const existing = await pool.query(
      `
        SELECT *
        FROM daily_ticket_snapshots
        WHERE ticket_date = $1::date
          AND slot = $2
        LIMIT 1
      `,
      [normalizedDate, normalizedSlot]
    );

    if (existing.rows[0]) {
      return {
        created: false,
        snapshot: serializeDailyTicketSnapshot(existing.rows[0]),
      };
    }
  }

  const loaded = await loadDailyTicketCandidates(normalizedDate, generatedAt);
  const safeTicket = selectDailySafeTicket(loaded.candidates);
  const funTicket = selectDailyFunTicket(
    loaded.candidates,
    safeTicket.selection
  );
  const bestValueTicket = selectDailyBestValueTicket(loaded.candidates);

  const metadata = {
    source,
    generatedAt: generatedAt.toISOString(),
    engineVersion: "DailyTicketBackend 2.0.0",
    sourceMatches: loaded.sourceRows,
    analyzedMatches: loaded.matches.length,
    analyzedMarkets: loaded.candidates.length,
    marketsWithOdds: loaded.candidates.filter(
      (candidate) => candidate.bookmakerOdds > 1
    ).length,
    marketsWithManualOdds: loaded.candidates.filter(
      (candidate) => candidate.manualOdds === true
    ).length,
    targetFunOdds: DAILY_TICKET_TARGET_FUN_ODDS,
    matches: loaded.matches,
  };

  const query = force
    ? `
        INSERT INTO daily_ticket_snapshots (
          ticket_date, slot, generated_at,
          safe_ticket, fun_ticket, best_value_ticket, metadata,
          safe_result_status, fun_result_status, value_result_status,
          safe_profit_units, fun_profit_units, value_profit_units,
          total_stake_units, total_profit_units, roi_percent,
          settled_at, updated_at
        )
        VALUES (
          $1::date, $2, $3::timestamptz,
          $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb,
          'PENDING', 'PENDING', 'PENDING',
          NULL, NULL, NULL,
          0, NULL, NULL,
          NULL, NOW()
        )
        ON CONFLICT (ticket_date, slot)
        DO UPDATE SET
          generated_at = EXCLUDED.generated_at,
          safe_ticket = EXCLUDED.safe_ticket,
          fun_ticket = EXCLUDED.fun_ticket,
          best_value_ticket = EXCLUDED.best_value_ticket,
          metadata = EXCLUDED.metadata,
          safe_result_status = 'PENDING',
          fun_result_status = 'PENDING',
          value_result_status = 'PENDING',
          safe_profit_units = NULL,
          fun_profit_units = NULL,
          value_profit_units = NULL,
          total_stake_units = 0,
          total_profit_units = NULL,
          roi_percent = NULL,
          settled_at = NULL,
          updated_at = NOW()
        RETURNING *
      `
    : `
        INSERT INTO daily_ticket_snapshots (
          ticket_date, slot, generated_at,
          safe_ticket, fun_ticket, best_value_ticket, metadata
        )
        VALUES (
          $1::date, $2, $3::timestamptz,
          $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb
        )
        ON CONFLICT (ticket_date, slot) DO NOTHING
        RETURNING *
      `;

  const inserted = await pool.query(query, [
    normalizedDate,
    normalizedSlot,
    generatedAt.toISOString(),
    JSON.stringify(safeTicket),
    JSON.stringify(funTicket),
    JSON.stringify(bestValueTicket),
    JSON.stringify(metadata),
  ]);

  if (!inserted.rows[0]) {
    const existing = await pool.query(
      `
        SELECT *
        FROM daily_ticket_snapshots
        WHERE ticket_date = $1::date AND slot = $2
        LIMIT 1
      `,
      [normalizedDate, normalizedSlot]
    );

    return {
      created: false,
      snapshot: serializeDailyTicketSnapshot(existing.rows[0]),
    };
  }

  return {
    created: true,
    snapshot: serializeDailyTicketSnapshot(inserted.rows[0]),
  };
}

function evaluateDailyTicketSelection(selection, resultByFixtureId) {
  if (!selection?.fixtureId) return "UNAVAILABLE";
  const result = resultByFixtureId.get(Number(selection.fixtureId));
  if (!result) return "PENDING";

  const won = evaluateManualOddsMarketResult({
    marketKey: selection?.market?.key,
    homeGoals: result.home_goals,
    awayGoals: result.away_goals,
  });

  if (typeof won !== "boolean") return "UNAVAILABLE";
  return won ? "WIN" : "LOSS";
}

function settleSingleDailyTicket(ticket, type, resultByFixtureId) {
  const parsed = parseDailyTicketJson(ticket, {});
  if (!parsed.available) {
    return {
      ticket: { ...parsed, resultStatus: "UNAVAILABLE", profitUnits: null },
      status: "UNAVAILABLE",
      profit: null,
      stake: 0,
    };
  }

  const selections = Array.isArray(parsed.selections)
    ? parsed.selections
    : parsed.selection
      ? [parsed.selection]
      : [];

  if (selections.length === 0) {
    return {
      ticket: { ...parsed, resultStatus: "UNAVAILABLE", profitUnits: null },
      status: "UNAVAILABLE",
      profit: null,
      stake: 0,
    };
  }

  const statuses = selections.map((selection) =>
    evaluateDailyTicketSelection(selection, resultByFixtureId)
  );

  let status = "PENDING";
  if (statuses.includes("LOSS")) status = "LOSS";
  else if (statuses.every((value) => value === "WIN")) status = "WIN";
  else if (statuses.every((value) => value === "UNAVAILABLE")) {
    status = "UNAVAILABLE";
  }

  const odd =
    type === "FUN"
      ? dailyTicketNumber(parsed.combinedOdds ?? parsed.totalOdds, null)
      : dailyTicketNumber(
          parsed.totalOdds ??
            parsed.selection?.bookmakerOdds ??
            selections[0]?.bookmakerOdds,
          null
        );

  let profit = null;
  let stake = 0;
  if ((status === "WIN" || status === "LOSS") && odd !== null && odd > 1) {
    stake = 1;
    profit = status === "WIN" ? roundDailyTicket(odd - 1, 2) : -1;
  }

  return {
    ticket: {
      ...parsed,
      selections: selections.map((selection, index) => ({
        ...selection,
        resultStatus: statuses[index],
      })),
      selection:
        parsed.selection && selections[0]
          ? { ...selections[0], resultStatus: statuses[0] }
          : parsed.selection || null,
      resultStatus: status,
      profitUnits: profit,
    },
    status,
    profit,
    stake,
  };
}

async function settleDailyTicketSnapshots({ ticketDate = null } = {}) {
  if (dailyTicketSettlementRunning) {
    return { ok: true, skipped: true, reason: "ALREADY_RUNNING" };
  }

  dailyTicketSettlementRunning = true;

  try {
    await ensureDailyTicketTables();

    const values = [];
    const where = ["(settled_at IS NULL OR updated_at < NOW() - INTERVAL '15 minutes')"];

    if (ticketDate) {
      const normalizedDate = normalizeDailyTicketDate(ticketDate);
      if (!normalizedDate) throw new Error("Date de règlement invalide.");
      values.push(normalizedDate);
      where.push(`ticket_date = $${values.length}::date`);
    } else {
      where.push("ticket_date <= (NOW() AT TIME ZONE 'Europe/Paris')::date");
    }

    const snapshotsResult = await pool.query(
      `
        SELECT *
        FROM daily_ticket_snapshots
        WHERE ${where.join(" AND ")}
        ORDER BY ticket_date ASC, generated_at ASC
      `,
      values
    );

    let updated = 0;

    for (const row of snapshotsResult.rows) {
      const tickets = [
        parseDailyTicketJson(row.safe_ticket, {}),
        parseDailyTicketJson(row.fun_ticket, {}),
        parseDailyTicketJson(row.best_value_ticket, {}),
      ];

      const fixtureIds = [
        ...new Set(
          tickets
            .flatMap((ticket) =>
              Array.isArray(ticket.selections)
                ? ticket.selections
                : ticket.selection
                  ? [ticket.selection]
                  : []
            )
            .map((selection) => Number(selection.fixtureId))
            .filter((fixtureId) => Number.isInteger(fixtureId) && fixtureId > 0)
        ),
      ];

      const results = fixtureIds.length > 0
        ? await pool.query(
            `
              SELECT fixture_id, result_status, home_goals, away_goals
              FROM predictions
              WHERE fixture_id = ANY($1::bigint[])
                AND result_status = 'COMPLETED'
                AND home_goals IS NOT NULL
                AND away_goals IS NOT NULL
            `,
            [fixtureIds]
          )
        : { rows: [] };

      const resultByFixtureId = new Map(
        results.rows.map((result) => [Number(result.fixture_id), result])
      );

      const safe = settleSingleDailyTicket(row.safe_ticket, "SAFE", resultByFixtureId);
      const fun = settleSingleDailyTicket(row.fun_ticket, "FUN", resultByFixtureId);
      const value = settleSingleDailyTicket(
        row.best_value_ticket,
        "VALUE",
        resultByFixtureId
      );

      const settledTickets = [safe, fun, value].filter(
        (ticket) => ticket.status === "WIN" || ticket.status === "LOSS"
      );
      const totalStake = settledTickets.reduce(
        (sum, ticket) => sum + ticket.stake,
        0
      );
      const profits = settledTickets
        .map((ticket) => ticket.profit)
        .filter((profit) => profit !== null);
      const totalProfit = profits.length > 0
        ? roundDailyTicket(profits.reduce((sum, profit) => sum + profit, 0), 2)
        : null;
      const roi = totalStake > 0 && totalProfit !== null
        ? roundDailyTicket((totalProfit / totalStake) * 100, 2)
        : null;

      const allFinal = [safe.status, fun.status, value.status].every((status) =>
        ["WIN", "LOSS", "UNAVAILABLE"].includes(status)
      );

      await pool.query(
        `
          UPDATE daily_ticket_snapshots
          SET
            safe_ticket = $2::jsonb,
            fun_ticket = $3::jsonb,
            best_value_ticket = $4::jsonb,
            safe_result_status = $5,
            fun_result_status = $6,
            value_result_status = $7,
            safe_profit_units = $8,
            fun_profit_units = $9,
            value_profit_units = $10,
            total_stake_units = $11,
            total_profit_units = $12,
            roi_percent = $13,
            settled_at = CASE WHEN $14::boolean THEN NOW() ELSE NULL END,
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          row.id,
          JSON.stringify(safe.ticket),
          JSON.stringify(fun.ticket),
          JSON.stringify(value.ticket),
          safe.status,
          fun.status,
          value.status,
          safe.profit,
          fun.profit,
          value.profit,
          totalStake,
          totalProfit,
          roi,
          allFinal,
        ]
      );

      updated += 1;
    }

    return {
      ok: true,
      checked: snapshotsResult.rows.length,
      updated,
    };
  } finally {
    dailyTicketSettlementRunning = false;
  }
}

function serializeDailyTicketSnapshot(row = {}) {
  return {
    id: row.id == null ? null : Number(row.id),
    date: row.ticket_date ? String(row.ticket_date).slice(0, 10) : null,
    slot: row.slot || null,
    generatedAt: row.generated_at || null,
    safeTicket: parseDailyTicketJson(row.safe_ticket, {}),
    funTicket: parseDailyTicketJson(row.fun_ticket, {}),
    bestValueTicket: parseDailyTicketJson(row.best_value_ticket, {}),
    metadata: parseDailyTicketJson(row.metadata, {}),
    results: {
      safe: row.safe_result_status || "PENDING",
      fun: row.fun_result_status || "PENDING",
      value: row.value_result_status || "PENDING",
    },
    profits: {
      safe:
        row.safe_profit_units == null ? null : Number(row.safe_profit_units),
      fun:
        row.fun_profit_units == null ? null : Number(row.fun_profit_units),
      value:
        row.value_profit_units == null ? null : Number(row.value_profit_units),
      total:
        row.total_profit_units == null ? null : Number(row.total_profit_units),
    },
    totalStake:
      row.total_stake_units == null ? 0 : Number(row.total_stake_units),
    roi: row.roi_percent == null ? null : Number(row.roi_percent),
    settledAt: row.settled_at || null,
    updatedAt: row.updated_at || null,
  };
}

app.get("/public/daily-tickets", async (req, res) => {
  try {
    await ensureDailyTicketTables();
    const paris = getParisDateTimeParts();
    const ticketDate = normalizeDailyTicketDate(req.query.date) || paris.date;

    await settleDailyTicketSnapshots({ ticketDate });

    const result = await pool.query(
      `
        SELECT *
        FROM daily_ticket_snapshots
        WHERE ticket_date = $1::date
        ORDER BY CASE slot
          WHEN '12H' THEN 1
          WHEN '18H' THEN 2
          WHEN '21H' THEN 3
          ELSE 4
        END ASC
      `,
      [ticketDate]
    );

    return res.json({
      ok: true,
      date: ticketDate,
      count: result.rows.length,
      editions: result.rows.map(serializeDailyTicketSnapshot),
    });
  } catch (error) {
    console.error("ERREUR LECTURE DAILY TICKETS :", error);
    return res.status(500).json({
      ok: false,
      editions: [],
      error: error?.message || "Impossible de charger les tickets du jour.",
    });
  }
});

app.get("/public/daily-tickets/history", async (req, res) => {
  try {
    await ensureDailyTicketTables();
    await settleDailyTicketSnapshots();

    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const result = await pool.query(
      `
        SELECT *
        FROM daily_ticket_snapshots
        ORDER BY ticket_date DESC, generated_at DESC
        LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

    const statsResult = await pool.query(`
      SELECT
        COUNT(*)::int AS editions,
        COUNT(*) FILTER (WHERE safe_result_status = 'WIN')::int AS safe_wins,
        COUNT(*) FILTER (WHERE safe_result_status = 'LOSS')::int AS safe_losses,
        COUNT(*) FILTER (WHERE fun_result_status = 'WIN')::int AS fun_wins,
        COUNT(*) FILTER (WHERE fun_result_status = 'LOSS')::int AS fun_losses,
        COUNT(*) FILTER (WHERE value_result_status = 'WIN')::int AS value_wins,
        COUNT(*) FILTER (WHERE value_result_status = 'LOSS')::int AS value_losses,
        COALESCE(SUM(total_stake_units), 0)::numeric AS total_stake,
        COALESCE(SUM(total_profit_units), 0)::numeric AS total_profit
      FROM daily_ticket_snapshots
    `);

    const stats = statsResult.rows[0] || {};
    const totalStake = Number(stats.total_stake || 0);
    const totalProfit = Number(stats.total_profit || 0);

    return res.json({
      ok: true,
      count: result.rows.length,
      limit,
      offset,
      history: result.rows.map(serializeDailyTicketSnapshot),
      stats: {
        editions: Number(stats.editions || 0),
        safeWins: Number(stats.safe_wins || 0),
        safeLosses: Number(stats.safe_losses || 0),
        funWins: Number(stats.fun_wins || 0),
        funLosses: Number(stats.fun_losses || 0),
        valueWins: Number(stats.value_wins || 0),
        valueLosses: Number(stats.value_losses || 0),
        totalStake,
        totalProfit,
        roi:
          totalStake > 0
            ? roundDailyTicket((totalProfit / totalStake) * 100, 2)
            : null,
      },
    });
  } catch (error) {
    console.error("ERREUR HISTORIQUE DAILY TICKETS :", error);
    return res.status(500).json({
      ok: false,
      history: [],
      error: error?.message || "Impossible de charger l'historique des tickets.",
    });
  }
});

app.post("/internal/daily-tickets/generate", async (req, res) => {
  if (!requireOptionalAdminKey(req, res)) return;

  try {
    const paris = getParisDateTimeParts();
    const ticketDate = normalizeDailyTicketDate(req.body?.date) || paris.date;
    const slot = normalizeDailyTicketSlot(req.body?.slot || "ON_DEMAND");

    if (!slot) {
      return res.status(400).json({ ok: false, error: "Créneau invalide." });
    }

    const result = await generateDailyTicketSnapshot({
      ticketDate,
      slot,
      force: req.body?.force === true,
      source: "admin-manual",
    });

    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error("ERREUR GÉNÉRATION DAILY TICKET :", error);
    return res.status(500).json({
      ok: false,
      error: error?.message || "Impossible de générer le ticket.",
    });
  }
});

app.post("/internal/daily-tickets/settle", async (req, res) => {
  if (!requireOptionalAdminKey(req, res)) return;

  try {
    const result = await settleDailyTicketSnapshots({
      ticketDate: req.body?.date || null,
    });
    return res.json(result);
  } catch (error) {
    console.error("ERREUR RÈGLEMENT DAILY TICKETS :", error);
    return res.status(500).json({
      ok: false,
      error: error?.message || "Impossible de régler les tickets.",
    });
  }
});

async function checkDailyTicketSchedule() {
  if (dailyTicketSchedulerRunning) return;
  dailyTicketSchedulerRunning = true;

  try {
    const paris = getParisDateTimeParts();

    for (const [slot, hour] of Object.entries(DAILY_TICKET_SLOTS)) {
      const minutesSinceSlot = (paris.hour - hour) * 60 + paris.minute;

      if (
        minutesSinceSlot < 0 ||
        minutesSinceSlot > DAILY_TICKET_SLOT_GRACE_MINUTES
      ) {
        continue;
      }

      const result = await generateDailyTicketSnapshot({
        ticketDate: paris.date,
        slot,
        force: false,
        source: "automatic-scheduler",
      });

      if (result.created) {
        console.log(`✅ Daily Ticket ${slot} créé pour ${paris.date}`);
      }
    }

    await settleDailyTicketSnapshots();
  } catch (error) {
    console.error("ERREUR SCHEDULER DAILY TICKET :", error);
  } finally {
    dailyTicketSchedulerRunning = false;
  }
}

function startDailyTicketScheduler() {
  if (!AUTOMATIC_SCHEDULERS_ENABLED) {
    console.log("⏸️ Daily Ticket Scheduler désactivé avec les schedulers.");
    return;
  }

  checkDailyTicketSchedule().catch((error) => {
    console.error("ERREUR PREMIÈRE VÉRIFICATION DAILY TICKET :", error);
  });

  setInterval(() => {
    checkDailyTicketSchedule().catch((error) => {
      console.error("ERREUR INTERVAL DAILY TICKET :", error);
    });
  }, DAILY_TICKET_SCHEDULER_INTERVAL_MS);

  console.log("✅ Daily Ticket Scheduler : 12h, 18h et 21h (Europe/Paris)");
}


const AUTOMATIC_CALIBRATION_INTERVAL_MS =
  6 * 60 * 60 * 1000;

const AUTOMATIC_CALIBRATION_FIRST_RUN_DELAY_MS =
  10 * 60 * 1000;

function startAutomaticCalibrationScheduler() {
  if (!AUTOMATIC_SCHEDULERS_ENABLED) {
    console.log(
      "⏸️ Calibration automatique désactivée avec les schedulers."
    );
    return;
  }

  setTimeout(() => {
    runAutomaticCalibrationCycle({
      source: "automatic-first-run",
    }).catch((error) => {
      console.error(
        "ERREUR PREMIER CYCLE AUTOMATIQUE CALIBRATION :",
        error
      );
    });
  }, AUTOMATIC_CALIBRATION_FIRST_RUN_DELAY_MS);

  setInterval(() => {
    runAutomaticCalibrationCycle({
      source: "automatic-scheduler",
    }).catch((error) => {
      console.error(
        "ERREUR SCHEDULER AUTOMATIQUE CALIBRATION :",
        error
      );
    });
  }, AUTOMATIC_CALIBRATION_INTERVAL_MS);

  console.log(
    "✅ Calibration Center automatique : toutes les 6 heures"
  );
}

function startAutomaticSchedulers() {
  if (!AUTOMATIC_SCHEDULERS_ENABLED) {
    console.log(
      "⏸️ Tous les schedulers automatiques sont désactivés."
    );

    console.log(
      "ℹ️ Pour les réactiver : AUTOMATIC_SCHEDULERS_ENABLED=true"
    );

    return;
  }

  if (!API_FOOTBALL_ENABLED) {
    console.log(
      "⏸️ Schedulers non démarrés : API_FOOTBALL_ENABLED=false"
    );
    console.log(
      "ℹ️ Le serveur, Learning, Calibration et les routes SQL restent accessibles."
    );
    return;
  }

  startLineupWatcherScheduler();

  /*
   * Premier rafraîchissement des résultats
   * deux minutes après le démarrage.
   */
  setTimeout(() => {
    runAutomaticResultSync();
  }, 2 * 60 * 1000);

  /*
   * Synchronisation des résultats toutes les 15 minutes.
   */
  setInterval(() => {
    runAutomaticResultSync();
  }, 15 * 60 * 1000);

  /*
   * Premier cycle Brain Studio trois minutes
   * après le démarrage du serveur.
   */
  setTimeout(() => {
    runAutomaticStudioScheduler({
      source: "startup",
    }).catch((error) => {
      console.error(
        "ERREUR DÉMARRAGE BRAIN STUDIO SCHEDULER :",
        error
      );
    });
  }, STUDIO_SCHEDULER_FIRST_RUN_DELAY_MS);

  /*
   * Brain Studio toutes les 15 minutes.
   */
  setInterval(() => {
    runAutomaticStudioScheduler({
      source: "interval",
    }).catch((error) => {
      console.error(
        "ERREUR INTERVAL BRAIN STUDIO SCHEDULER :",
        error
      );
    });
  }, STUDIO_SCHEDULER_INTERVAL_MS);

  /*
   * Vérification chaque minute de l'heure
   * prévue pour l'analyse quotidienne.
   */
  setInterval(() => {
    checkDailyFullAnalysisSchedule().catch((error) => {
      console.error(
        "ERREUR PLANIFICATEUR ANALYSE QUOTIDIENNE :",
        error
      );
    });
  }, 60 * 1000);

  /*
   * Première vérification au démarrage.
   */
  checkDailyFullAnalysisSchedule().catch((error) => {
    console.error(
      "ERREUR PREMIÈRE VÉRIFICATION QUOTIDIENNE :",
      error
    );
  });

  console.log(
    "✅ Synchronisation des résultats : toutes les 15 minutes"
  );

  console.log(
    "✅ Brain Studio Scheduler : toutes les 15 minutes"
  );

  console.log(
    "✅ Planificateur quotidien : actif"
  );
}


/*
 * ============================================================
 * STATISTIQUES PUBLIQUES — VUE PARIEUR
 * ============================================================
 * Cette route expose uniquement des résultats compréhensibles
 * par le public. Elle ne renvoie aucune donnée Learning,
 * Calibration ou coefficient interne de l'IA.
 */
app.get("/public/statistics/dashboard", async (req, res) => {
  try {
    await ensureBilanV3Columns();
    await ensureDailyTicketTables();
    await refreshManualOddsProfits();

    const [
      globalResult,
      competitionsResult,
      marketsResult,
      oddsBandsResult,
      valueScannerResult,
      ticketStatsResult,
    ] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (
            WHERE result_status = 'COMPLETED'
          )::INTEGER AS completed_markets,

          COUNT(*) FILTER (
            WHERE result_status = 'COMPLETED'
              AND COALESCE(official_market_won, won) IS NOT NULL
          )::INTEGER AS evaluated_markets,

          COUNT(*) FILTER (
            WHERE result_status = 'COMPLETED'
              AND COALESCE(official_market_won, won) = TRUE
          )::INTEGER AS wins,

          COUNT(*) FILTER (
            WHERE result_status = 'COMPLETED'
              AND COALESCE(official_market_won, won) = FALSE
          )::INTEGER AS losses,

          COUNT(*) FILTER (
            WHERE manual_market_odd IS NOT NULL
              AND manual_profit_units IS NOT NULL
          )::INTEGER AS settled_real_bets,

          COALESCE(
            SUM(manual_stake_units) FILTER (
              WHERE manual_profit_units IS NOT NULL
            ),
            0
          )::NUMERIC AS total_stake,

          COALESCE(
            SUM(manual_profit_units) FILTER (
              WHERE manual_profit_units IS NOT NULL
            ),
            0
          )::NUMERIC AS total_profit,

          ROUND(
            (
              SUM(manual_market_odd * manual_stake_units) FILTER (
                WHERE manual_profit_units IS NOT NULL
                  AND manual_market_odd > 1
                  AND manual_stake_units > 0
              )
              /
              NULLIF(
                SUM(manual_stake_units) FILTER (
                  WHERE manual_profit_units IS NOT NULL
                    AND manual_market_odd > 1
                    AND manual_stake_units > 0
                ),
                0
              )
            )::NUMERIC,
            3
          ) AS average_odd
        FROM predictions
      `),

      pool.query(`
        SELECT
          COALESCE(NULLIF(BTRIM(league_name), ''), 'Compétition inconnue') AS competition,
          COUNT(*)::INTEGER AS volume,
          COUNT(*) FILTER (
            WHERE result_status = 'COMPLETED'
              AND COALESCE(official_market_won, won) IS NOT NULL
          )::INTEGER AS evaluated,
          COUNT(*) FILTER (
            WHERE result_status = 'COMPLETED'
              AND COALESCE(official_market_won, won) = TRUE
          )::INTEGER AS wins,
          COUNT(*) FILTER (
            WHERE manual_profit_units IS NOT NULL
          )::INTEGER AS settled_bets,
          COALESCE(
            SUM(manual_stake_units) FILTER (
              WHERE manual_profit_units IS NOT NULL
            ),
            0
          )::NUMERIC AS stake,
          COALESCE(
            SUM(manual_profit_units) FILTER (
              WHERE manual_profit_units IS NOT NULL
            ),
            0
          )::NUMERIC AS profit,
          ROUND(
            (
              SUM(manual_market_odd * manual_stake_units) FILTER (
                WHERE manual_profit_units IS NOT NULL
                  AND manual_market_odd > 1
                  AND manual_stake_units > 0
              )
              /
              NULLIF(
                SUM(manual_stake_units) FILTER (
                  WHERE manual_profit_units IS NOT NULL
                    AND manual_market_odd > 1
                    AND manual_stake_units > 0
                ),
                0
              )
            )::NUMERIC,
            2
          ) AS average_odd,
          MAX(fixture_date) AS last_match
        FROM predictions
        WHERE result_status = 'COMPLETED'
        GROUP BY COALESCE(NULLIF(BTRIM(league_name), ''), 'Compétition inconnue')
        HAVING COUNT(*) FILTER (
          WHERE COALESCE(official_market_won, won) IS NOT NULL
        ) > 0
        ORDER BY volume DESC, competition ASC
        LIMIT 100
      `),

      pool.query(`
        SELECT
          COALESCE(
            NULLIF(BTRIM(official_tracked_market_key), ''),
            NULLIF(BTRIM(studio_market_key), ''),
            'UNKNOWN'
          ) AS market_key,
          COALESCE(
            NULLIF(BTRIM(official_tracked_market_label), ''),
            NULLIF(BTRIM(studio_market_label), ''),
            'Marché inconnu'
          ) AS market_label,
          COUNT(*) FILTER (
            WHERE result_status = 'COMPLETED'
              AND COALESCE(official_market_won, won) IS NOT NULL
          )::INTEGER AS evaluated,
          COUNT(*) FILTER (
            WHERE result_status = 'COMPLETED'
              AND COALESCE(official_market_won, won) = TRUE
          )::INTEGER AS wins,
          COUNT(*) FILTER (
            WHERE manual_profit_units IS NOT NULL
          )::INTEGER AS settled_bets,
          COALESCE(
            SUM(manual_stake_units) FILTER (
              WHERE manual_profit_units IS NOT NULL
            ),
            0
          )::NUMERIC AS stake,
          COALESCE(
            SUM(manual_profit_units) FILTER (
              WHERE manual_profit_units IS NOT NULL
            ),
            0
          )::NUMERIC AS profit,
          ROUND(
            AVG(manual_market_odd) FILTER (
              WHERE manual_profit_units IS NOT NULL
                AND manual_market_odd > 1
            )::NUMERIC,
            2
          ) AS average_odd
        FROM predictions
        WHERE result_status = 'COMPLETED'
        GROUP BY
          COALESCE(
            NULLIF(BTRIM(official_tracked_market_key), ''),
            NULLIF(BTRIM(studio_market_key), ''),
            'UNKNOWN'
          ),
          COALESCE(
            NULLIF(BTRIM(official_tracked_market_label), ''),
            NULLIF(BTRIM(studio_market_label), ''),
            'Marché inconnu'
          )
        HAVING COUNT(*) FILTER (
          WHERE COALESCE(official_market_won, won) IS NOT NULL
        ) > 0
        ORDER BY evaluated DESC, market_label ASC
      `),

      pool.query(`
        SELECT
          CASE
            WHEN manual_market_odd < 1.50 THEN '1.01 - 1.49'
            WHEN manual_market_odd < 2.00 THEN '1.50 - 1.99'
            WHEN manual_market_odd < 3.00 THEN '2.00 - 2.99'
            ELSE '3.00 et +'
          END AS odd_band,
          CASE
            WHEN manual_market_odd < 1.50 THEN 1
            WHEN manual_market_odd < 2.00 THEN 2
            WHEN manual_market_odd < 3.00 THEN 3
            ELSE 4
          END AS sort_order,
          COUNT(*)::INTEGER AS bets,
          COUNT(*) FILTER (
            WHERE official_market_won = TRUE
          )::INTEGER AS wins,
          COALESCE(SUM(manual_stake_units), 0)::NUMERIC AS stake,
          COALESCE(SUM(manual_profit_units), 0)::NUMERIC AS profit,
          ROUND(AVG(manual_market_odd)::NUMERIC, 2) AS average_odd
        FROM predictions
        WHERE manual_market_odd IS NOT NULL
          AND manual_profit_units IS NOT NULL
        GROUP BY odd_band, sort_order
        ORDER BY sort_order ASC
      `),

      pool.query(`
        SELECT
          fixture_id,
          fixture_date,
          league_name,
          home_team_name,
          away_team_name,
          COALESCE(
            NULLIF(BTRIM(official_tracked_market_key), ''),
            NULLIF(BTRIM(manual_market_key), ''),
            NULLIF(BTRIM(studio_market_key), '')
          ) AS market_key,
          COALESCE(
            NULLIF(BTRIM(official_tracked_market_label), ''),
            NULLIF(BTRIM(studio_market_label), ''),
            'Marché principal'
          ) AS market_label,
          COALESCE(
            official_tracked_probability,
            studio_probability
          )::NUMERIC AS probability,
          COALESCE(
            official_tracked_decision_score,
            studio_decision_score
          )::NUMERIC AS decision_score,
          manual_market_odd::NUMERIC AS bookmaker_odd,
          (
            (
              COALESCE(
                official_tracked_probability,
                studio_probability
              ) / 100.0
            ) * manual_market_odd - 1
          ) * 100.0 AS value_percent
        FROM predictions
        WHERE result_status = 'PENDING'
          AND fixture_date > NOW()
          AND manual_market_odd > 1
          AND COALESCE(
            official_tracked_probability,
            studio_probability
          ) > 0
          AND COALESCE(
            NULLIF(BTRIM(manual_market_key), ''),
            NULLIF(BTRIM(official_tracked_market_key), ''),
            NULLIF(BTRIM(studio_market_key), '')
          ) IS NOT NULL
        ORDER BY value_percent DESC, decision_score DESC NULLS LAST
        LIMIT 30
      `),

      pool.query(`
        SELECT
          ticket_type,
          COUNT(*)::INTEGER AS tickets,
          COUNT(*) FILTER (WHERE result_status = 'WIN')::INTEGER AS wins,
          COUNT(*) FILTER (WHERE result_status = 'LOSS')::INTEGER AS losses,
          COALESCE(SUM(stake_units), 0)::NUMERIC AS stake,
          COALESCE(SUM(profit_units), 0)::NUMERIC AS profit
        FROM (
          SELECT
            'SAFE'::TEXT AS ticket_type,
            safe_result_status AS result_status,
            CASE WHEN safe_result_status IN ('WIN', 'LOSS') THEN 1 ELSE 0 END::NUMERIC AS stake_units,
            COALESCE(safe_profit_units, 0)::NUMERIC AS profit_units
          FROM daily_ticket_snapshots

          UNION ALL

          SELECT
            'FUN'::TEXT,
            fun_result_status,
            CASE WHEN fun_result_status IN ('WIN', 'LOSS') THEN 1 ELSE 0 END::NUMERIC,
            COALESCE(fun_profit_units, 0)::NUMERIC
          FROM daily_ticket_snapshots

          UNION ALL

          SELECT
            'BEST_VALUE'::TEXT,
            value_result_status,
            CASE WHEN value_result_status IN ('WIN', 'LOSS') THEN 1 ELSE 0 END::NUMERIC,
            COALESCE(value_profit_units, 0)::NUMERIC
          FROM daily_ticket_snapshots
        ) ticket_rows
        WHERE result_status IN ('WIN', 'LOSS')
        GROUP BY ticket_type
        ORDER BY ticket_type ASC
      `),
    ]);

    const globalRow = globalResult.rows[0] || {};
    const evaluatedMarkets = Number(globalRow.evaluated_markets || 0);
    const wins = Number(globalRow.wins || 0);
    const totalStake = Number(globalRow.total_stake || 0);
    const totalProfit = Number(globalRow.total_profit || 0);

    const mapPerformanceRow = (row) => {
      const evaluated = Number(row.evaluated || 0);
      const rowWins = Number(row.wins || 0);
      const stake = Number(row.stake || 0);
      const profit = Number(row.profit || 0);

      return {
        ...row,
        volume: Number(row.volume || evaluated || 0),
        evaluated,
        wins: rowWins,
        accuracy: evaluated > 0
          ? Number(((rowWins / evaluated) * 100).toFixed(1))
          : null,
        settledBets: Number(row.settled_bets || row.bets || 0),
        stake: Number(stake.toFixed(2)),
        profit: Number(profit.toFixed(2)),
        roi: stake > 0
          ? Number(((profit / stake) * 100).toFixed(1))
          : null,
        averageOdd: row.average_odd == null
          ? null
          : Number(row.average_odd),
      };
    };

    const competitions = competitionsResult.rows.map((row) => {
      const mapped = mapPerformanceRow(row);
      const settledBets = Number(mapped.settledBets || 0);

      return {
        ...mapped,
        name: row.competition,
        lastMatch: row.last_match || null,
        sampleQuality:
          settledBets >= 100
            ? "excellent"
            : settledBets >= 50
              ? "bon"
              : settledBets >= 20
                ? "moyen"
                : "faible",
      };
    });

    const markets = marketsResult.rows.map((row) => ({
      ...mapPerformanceRow(row),
      key: row.market_key,
      label: row.market_label,
    }));

    const oddsBands = oddsBandsResult.rows.map((row) => ({
      ...mapPerformanceRow(row),
      band: row.odd_band,
    }));

    const valueScanner = valueScannerResult.rows.map((row) => ({
      fixtureId: Number(row.fixture_id),
      kickoff: row.fixture_date,
      competition: row.league_name || null,
      homeTeam: row.home_team_name,
      awayTeam: row.away_team_name,
      marketKey: row.market_key,
      marketLabel: row.market_label,
      probability: Number(row.probability || 0),
      decisionScore: Number(row.decision_score || 0),
      bookmakerOdd: Number(row.bookmaker_odd || 0),
      valuePercent: Number(Number(row.value_percent || 0).toFixed(1)),
    }));

    const ticketStats = ticketStatsResult.rows.map((row) => {
      const tickets = Number(row.tickets || 0);
      const rowWins = Number(row.wins || 0);
      const stake = Number(row.stake || 0);
      const profit = Number(row.profit || 0);

      return {
        type: row.ticket_type,
        tickets,
        wins: rowWins,
        losses: Number(row.losses || 0),
        accuracy: tickets > 0
          ? Number(((rowWins / tickets) * 100).toFixed(1))
          : null,
        stake: Number(stake.toFixed(2)),
        profit: Number(profit.toFixed(2)),
        roi: stake > 0
          ? Number(((profit / stake) * 100).toFixed(1))
          : null,
      };
    });

    return res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      global: {
        completedMarkets: Number(globalRow.completed_markets || 0),
        evaluatedMarkets,
        wins,
        losses: Number(globalRow.losses || 0),
        accuracy: evaluatedMarkets > 0
          ? Number(((wins / evaluatedMarkets) * 100).toFixed(1))
          : null,
        settledRealBets: Number(globalRow.settled_real_bets || 0),
        totalStake: Number(totalStake.toFixed(2)),
        totalProfit: Number(totalProfit.toFixed(2)),
        roi: totalStake > 0
          ? Number(((totalProfit / totalStake) * 100).toFixed(1))
          : null,
        averageOdd: globalRow.average_odd == null
          ? null
          : Number(globalRow.average_odd),
      },
      competitions,
      markets,
      oddsBands,
      valueScanner,
      ticketStats,
    });
  } catch (error) {
    console.error("ERREUR /public/statistics/dashboard :", error);

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Impossible de charger les statistiques publiques.",
    });
  }
});

/*
 * ============================================================
 * BET QUALIFICATION — CALIBRATION AUTOMATIQUE DES SEUILS
 * ============================================================
 * Mode initial : AUTO_PROPOSE.
 * Les propositions ne deviennent actives qu'après validation admin.
 */
const DEFAULT_BET_QUALIFICATION_CONFIG = Object.freeze({
  safe: {
    minimumBetScore: 85,
    minimumDecisionScore: 82,
    minimumReliability: 65,
    minimumConsensus: 55,
    maximumRisk: 65,
  },
  value: {
    minimumBetScore: 74,
    minimumDecisionScore: 65,
    minimumReliability: 55,
    minimumValuePercent: 0,
    maximumRisk: 75,
    requireBookmakerOdd: true,
  },
  opportunity: {
    minimumBetScore: 65,
    minimumDecisionScore: 60,
    minimumReliability: 50,
    maximumRisk: 80,
  },
  blocking: {
    minimumProbability: 20,
    maximumProbability: 95,
    minimumReliability: 25,
    maximumRisk: 90,
  },
});

function betCalibrationNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function betCalibrationClamp(value, min, max) {
  return Math.max(min, Math.min(max, betCalibrationNumber(value)));
}

function betCalibrationRound(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(betCalibrationNumber(value) * factor) / factor;
}

function cloneBetConfig(value) {
  return JSON.parse(JSON.stringify(value || DEFAULT_BET_QUALIFICATION_CONFIG));
}

async function ensureBetQualificationCalibrationTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qualified_bets (
      id BIGSERIAL PRIMARY KEY,
      fixture_id BIGINT NOT NULL,
      market_key TEXT NOT NULL,
      market_label TEXT,
      category TEXT NOT NULL,
      bet_score NUMERIC,
      decision_score NUMERIC,
      probability NUMERIC,
      confidence NUMERIC,
      consensus NUMERIC,
      reliability NUMERIC,
      risk NUMERIC,
      value_percent NUMERIC,
      bookmaker_odd NUMERIC,
      qualification_version TEXT,
      qualification_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      frozen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      kickoff TIMESTAMPTZ,
      result_status TEXT NOT NULL DEFAULT 'PENDING',
      won BOOLEAN,
      profit_units NUMERIC,
      roi_percent NUMERIC,
      settled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (fixture_id, market_key)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_qualified_bets_calibration
    ON qualified_bets(category, result_status, bet_score);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bet_qualification_config (
      id BIGSERIAL PRIMARY KEY,
      version TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'INACTIVE',
      mode TEXT NOT NULL DEFAULT 'AUTO_PROPOSE',
      config JSONB NOT NULL,
      source TEXT NOT NULL DEFAULT 'DEFAULT',
      metrics_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      change_reason TEXT,
      parent_config_id BIGINT REFERENCES bet_qualification_config(id),
      active_from TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_bet_config
    ON bet_qualification_config((status))
    WHERE status = 'ACTIVE';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bet_qualification_proposals (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'PROPOSED',
      source TEXT NOT NULL DEFAULT 'AUTO_PROPOSE',
      current_config_id BIGINT REFERENCES bet_qualification_config(id),
      proposed_config JSONB NOT NULL,
      metrics_before JSONB NOT NULL DEFAULT '{}'::jsonb,
      metrics_after JSONB NOT NULL DEFAULT '{}'::jsonb,
      impact JSONB NOT NULL DEFAULT '{}'::jsonb,
      reason TEXT,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      reviewed_by TEXT,
      created_config_id BIGINT REFERENCES bet_qualification_config(id)
    );
  `);

  const existing = await pool.query(`
    SELECT id FROM bet_qualification_config
    WHERE status = 'ACTIVE'
    LIMIT 1
  `);

  if (existing.rows.length === 0) {
    await pool.query(
      `
        INSERT INTO bet_qualification_config (
          version, status, mode, config, source,
          metrics_snapshot, change_reason, active_from
        ) VALUES ($1, 'ACTIVE', 'AUTO_PROPOSE', $2::jsonb, 'DEFAULT', '{}'::jsonb, $3, NOW())
        ON CONFLICT (version) DO NOTHING
      `,
      [
        'bet-qualification-v1.0.0',
        JSON.stringify(DEFAULT_BET_QUALIFICATION_CONFIG),
        'Configuration initiale issue du BetQualificationEngine.',
      ]
    );
  }
}

async function getActiveBetQualificationConfig() {
  await ensureBetQualificationCalibrationTables();
  const result = await pool.query(`
    SELECT *
    FROM bet_qualification_config
    WHERE status = 'ACTIVE'
    ORDER BY active_from DESC NULLS LAST, id DESC
    LIMIT 1
  `);

  const row = result.rows[0];
  return row
    ? {
        id: Number(row.id),
        version: row.version,
        status: row.status,
        mode: row.mode,
        config: row.config || cloneBetConfig(),
        source: row.source,
        metricsSnapshot: row.metrics_snapshot || {},
        changeReason: row.change_reason,
        activeFrom: row.active_from,
        createdAt: row.created_at,
      }
    : null;
}

function evaluateBetRows(rows, config) {
  const categories = ['SAFE', 'VALUE', 'OPPORTUNITY'];
  const summary = {};

  for (const category of categories) {
    const key = category.toLowerCase();
    const rules = config[key];
    const selected = rows.filter((row) => {
      const score = betCalibrationNumber(row.bet_score);
      const decision = betCalibrationNumber(row.decision_score);
      const reliability = betCalibrationNumber(row.reliability);
      const consensus = betCalibrationNumber(row.consensus);
      const risk = betCalibrationNumber(row.risk, 50);
      const value = row.value_percent == null ? null : betCalibrationNumber(row.value_percent);
      const odd = row.bookmaker_odd == null ? null : betCalibrationNumber(row.bookmaker_odd);

      if (score < rules.minimumBetScore) return false;
      if (decision < rules.minimumDecisionScore) return false;
      if (reliability < rules.minimumReliability) return false;
      if (risk > rules.maximumRisk) return false;
      if (category === 'SAFE' && consensus < rules.minimumConsensus) return false;
      if (category === 'VALUE') {
        if (odd == null || odd <= 1) return false;
        if (value == null || value < rules.minimumValuePercent) return false;
      }
      return true;
    });

    const settled = selected.filter((row) => ['WIN', 'LOSS', 'VOID'].includes(String(row.result_status || '').toUpperCase()));
    const priced = settled.filter((row) => Number.isFinite(Number(row.profit_units)));
    const wins = settled.filter((row) => row.won === true || String(row.result_status).toUpperCase() === 'WIN').length;
    const profit = priced.reduce((sum, row) => sum + betCalibrationNumber(row.profit_units), 0);

    summary[category] = {
      volume: selected.length,
      settled: settled.length,
      priced: priced.length,
      wins,
      losses: settled.filter((row) => row.won === false || String(row.result_status).toUpperCase() === 'LOSS').length,
      winRate: settled.length > 0 ? betCalibrationRound((wins / settled.length) * 100, 2) : null,
      profitUnits: betCalibrationRound(profit, 2),
      roi: priced.length > 0 ? betCalibrationRound((profit / priced.length) * 100, 2) : null,
      averageOdd: priced.length > 0
        ? betCalibrationRound(priced.reduce((sum, row) => sum + betCalibrationNumber(row.bookmaker_odd), 0) / priced.length, 2)
        : null,
      averageBetScore: selected.length > 0
        ? betCalibrationRound(selected.reduce((sum, row) => sum + betCalibrationNumber(row.bet_score), 0) / selected.length, 2)
        : null,
    };
  }

  const pricedTotal = Object.values(summary).reduce((sum, item) => sum + item.priced, 0);
  const profitTotal = Object.values(summary).reduce((sum, item) => sum + item.profitUnits, 0);

  return {
    categories: summary,
    total: {
      volume: Object.values(summary).reduce((sum, item) => sum + item.volume, 0),
      settled: Object.values(summary).reduce((sum, item) => sum + item.settled, 0),
      priced: pricedTotal,
      profitUnits: betCalibrationRound(profitTotal, 2),
      roi: pricedTotal > 0 ? betCalibrationRound((profitTotal / pricedTotal) * 100, 2) : null,
    },
  };
}

function generateCandidateConfigs(currentConfig) {
  const candidates = [];
  const deltas = [-2, -1, 0, 1, 2];

  for (const category of ['safe', 'value', 'opportunity']) {
    for (const delta of deltas) {
      if (delta === 0) continue;
      const candidate = cloneBetConfig(currentConfig);
      candidate[category].minimumBetScore = betCalibrationClamp(
        candidate[category].minimumBetScore + delta,
        category === 'safe' ? 78 : category === 'value' ? 68 : 58,
        95
      );
      candidates.push({
        config: candidate,
        category: category.toUpperCase(),
        delta,
        field: 'minimumBetScore',
      });
    }
  }

  return candidates;
}

function proposalScore(before, after) {
  const beforeRoi = before.total.roi;
  const afterRoi = after.total.roi;
  if (beforeRoi == null || afterRoi == null) return -Infinity;

  const volumeRatio = before.total.priced > 0
    ? after.total.priced / before.total.priced
    : 0;
  if (after.total.priced < 30 || volumeRatio < 0.55) return -Infinity;

  const roiGain = afterRoi - beforeRoi;
  const profitGain = after.total.profitUnits - before.total.profitUnits;
  return roiGain * 3 + profitGain * 0.15 + Math.min(1, volumeRatio) * 2;
}

async function buildBetQualificationProposal() {
  await ensureBetQualificationCalibrationTables();
  const active = await getActiveBetQualificationConfig();
  const rowsResult = await pool.query(`
    SELECT
      category, bet_score, decision_score, probability,
      confidence, consensus, reliability, risk,
      value_percent, bookmaker_odd, result_status,
      won, profit_units, roi_percent, frozen_at
    FROM qualified_bets
    WHERE frozen_at >= NOW() - INTERVAL '365 days'
      AND result_status IN ('WIN', 'LOSS', 'VOID')
    ORDER BY frozen_at DESC
  `);
  const rows = rowsResult.rows;
  const before = evaluateBetRows(rows, active.config);

  if (before.total.priced < 100) {
    return {
      created: false,
      reason: 'INSUFFICIENT_SAMPLE',
      minimumRequired: 100,
      pricedSample: before.total.priced,
      active,
      metrics: before,
    };
  }

  let best = null;
  for (const candidate of generateCandidateConfigs(active.config)) {
    const after = evaluateBetRows(rows, candidate.config);
    const score = proposalScore(before, after);
    if (!best || score > best.score) {
      best = { ...candidate, after, score };
    }
  }

  if (!best || !Number.isFinite(best.score)) {
    return {
      created: false,
      reason: 'NO_SAFE_IMPROVEMENT',
      active,
      metrics: before,
    };
  }

  const roiGain = betCalibrationRound((best.after.total.roi || 0) - (before.total.roi || 0), 2);
  const volumeChange = before.total.priced > 0
    ? betCalibrationRound(((best.after.total.priced - before.total.priced) / before.total.priced) * 100, 2)
    : 0;

  if (roiGain < 0.75) {
    return {
      created: false,
      reason: 'IMPROVEMENT_TOO_SMALL',
      estimatedRoiGain: roiGain,
      active,
      metrics: before,
    };
  }

  const reason = `${best.category}: ${best.field} ${best.delta > 0 ? '+' : ''}${best.delta}. ROI simulé ${roiGain >= 0 ? '+' : ''}${roiGain} %, volume ${volumeChange >= 0 ? '+' : ''}${volumeChange} %.`;

  const inserted = await pool.query(
    `
      INSERT INTO bet_qualification_proposals (
        status, source, current_config_id, proposed_config,
        metrics_before, metrics_after, impact, reason
      ) VALUES ('PROPOSED', 'AUTO_PROPOSE', $1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6)
      RETURNING *
    `,
    [
      active.id,
      JSON.stringify(best.config),
      JSON.stringify(before),
      JSON.stringify(best.after),
      JSON.stringify({
        changedCategory: best.category,
        changedField: best.field,
        delta: best.delta,
        estimatedRoiGain: roiGain,
        estimatedVolumeChangePercent: volumeChange,
        score: betCalibrationRound(best.score, 3),
      }),
      reason,
    ]
  );

  return {
    created: true,
    proposal: inserted.rows[0],
    active,
  };
}

app.get('/public/bet-qualification/config', async (req, res) => {
  try {
    const active = await getActiveBetQualificationConfig();
    return res.json({ ok: true, active });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Impossible de charger la configuration.' });
  }
});

app.get('/internal/bet-qualification/calibration/dashboard', async (req, res) => {
  if (!requireOptionalAdminKey(req, res)) return;
  try {
    await ensureBetQualificationCalibrationTables();
    const active = await getActiveBetQualificationConfig();
    const rowsResult = await pool.query(`
      SELECT * FROM qualified_bets
      WHERE frozen_at >= NOW() - INTERVAL '365 days'
      ORDER BY frozen_at DESC
    `);
    const proposalsResult = await pool.query(`
      SELECT * FROM bet_qualification_proposals
      ORDER BY generated_at DESC
      LIMIT 30
    `);
    const configsResult = await pool.query(`
      SELECT id, version, status, mode, source, change_reason, active_from, created_at, config, metrics_snapshot
      FROM bet_qualification_config
      ORDER BY created_at DESC
      LIMIT 20
    `);

    return res.json({
      ok: true,
      mode: active?.mode || 'AUTO_PROPOSE',
      active,
      metrics: evaluateBetRows(rowsResult.rows, active.config),
      proposals: proposalsResult.rows,
      versions: configsResult.rows,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Impossible de charger la calibration des paris.' });
  }
});

app.post('/internal/bet-qualification/calibration/proposals/generate', async (req, res) => {
  if (!requireOptionalAdminKey(req, res)) return;
  try {
    const result = await buildBetQualificationProposal();
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Impossible de générer une proposition.' });
  }
});

app.post('/internal/bet-qualification/calibration/proposals/:proposalId/approve', async (req, res) => {
  if (!requireOptionalAdminKey(req, res)) return;
  const client = await pool.connect();
  try {
    await ensureBetQualificationCalibrationTables();
    const proposalId = Number(req.params.proposalId);
    if (!Number.isInteger(proposalId) || proposalId <= 0) {
      return res.status(400).json({ ok: false, error: 'proposalId invalide.' });
    }

    await client.query('BEGIN');
    const proposalResult = await client.query(
      `SELECT * FROM bet_qualification_proposals WHERE id = $1 FOR UPDATE`,
      [proposalId]
    );
    const proposal = proposalResult.rows[0];
    if (!proposal) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Proposition introuvable.' });
    }
    if (proposal.status !== 'PROPOSED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'Cette proposition a déjà été traitée.' });
    }

    await client.query(`UPDATE bet_qualification_config SET status = 'INACTIVE', updated_at = NOW() WHERE status = 'ACTIVE'`);
    const version = `bet-qualification-auto-${Date.now()}`;
    const configResult = await client.query(
      `
        INSERT INTO bet_qualification_config (
          version, status, mode, config, source, metrics_snapshot,
          change_reason, parent_config_id, active_from
        ) VALUES ($1, 'ACTIVE', 'AUTO_PROPOSE', $2::jsonb, 'APPROVED_PROPOSAL', $3::jsonb, $4, $5, NOW())
        RETURNING *
      `,
      [
        version,
        JSON.stringify(proposal.proposed_config),
        JSON.stringify(proposal.metrics_after || {}),
        proposal.reason,
        proposal.current_config_id,
      ]
    );

    await client.query(
      `
        UPDATE bet_qualification_proposals
        SET status = 'APPROVED', reviewed_at = NOW(), reviewed_by = $2, created_config_id = $3
        WHERE id = $1
      `,
      [proposalId, String(req.body?.reviewedBy || 'administrator').slice(0, 200), configResult.rows[0].id]
    );
    await client.query('COMMIT');
    return res.json({ ok: true, active: configResult.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ ok: false, error: error?.message || 'Impossible d’approuver la proposition.' });
  } finally {
    client.release();
  }
});

app.post('/internal/bet-qualification/calibration/proposals/:proposalId/reject', async (req, res) => {
  if (!requireOptionalAdminKey(req, res)) return;
  try {
    const proposalId = Number(req.params.proposalId);
    const result = await pool.query(
      `
        UPDATE bet_qualification_proposals
        SET status = 'REJECTED', reviewed_at = NOW(), reviewed_by = $2
        WHERE id = $1 AND status = 'PROPOSED'
        RETURNING *
      `,
      [proposalId, String(req.body?.reviewedBy || 'administrator').slice(0, 200)]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Proposition active introuvable.' });
    }
    return res.json({ ok: true, proposal: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Impossible de refuser la proposition.' });
  }
});

app.post('/internal/bet-qualification/calibration/configs/:configId/rollback', async (req, res) => {
  if (!requireOptionalAdminKey(req, res)) return;
  const client = await pool.connect();
  try {
    const configId = Number(req.params.configId);
    await client.query('BEGIN');
    const targetResult = await client.query(`SELECT * FROM bet_qualification_config WHERE id = $1 FOR UPDATE`, [configId]);
    const target = targetResult.rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Version introuvable.' });
    }
    await client.query(`UPDATE bet_qualification_config SET status = 'INACTIVE', updated_at = NOW() WHERE status = 'ACTIVE'`);
    const version = `bet-qualification-rollback-${Date.now()}`;
    const restored = await client.query(
      `
        INSERT INTO bet_qualification_config (
          version, status, mode, config, source, metrics_snapshot,
          change_reason, parent_config_id, active_from
        ) VALUES ($1, 'ACTIVE', 'AUTO_PROPOSE', $2::jsonb, 'ROLLBACK', $3::jsonb, $4, $5, NOW())
        RETURNING *
      `,
      [version, JSON.stringify(target.config), JSON.stringify(target.metrics_snapshot || {}), `Retour à la version ${target.version}.`, target.id]
    );
    await client.query('COMMIT');
    return res.json({ ok: true, active: restored.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ ok: false, error: error?.message || 'Impossible de restaurer la version.' });
  } finally {
    client.release();
  }
});


/* ========================================================================== */
/* BILAN SÉPARÉ — IA COMPLET + RECOMMANDATIONS OFFICIELLES                    */
/* ========================================================================== */

function bilanPublicNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bilanPublicRound(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(bilanPublicNumber(value) * factor) / factor;
}

function getBilanSnapshotMarkets(snapshotValue) {
  const snapshot = parseBilanSnapshot(snapshotValue);

  if (Array.isArray(snapshot?.markets)) {
    return snapshot.markets;
  }

  if (Array.isArray(snapshot?.studio?.markets)) {
    return snapshot.studio.markets;
  }

  const fallbackMarket =
    snapshot?.primaryMarket ||
    snapshot?.bestDecision ||
    null;

  return fallbackMarket ? [fallbackMarket] : [];
}

function getBilanMarketKey(market = {}) {
  return normalizeManualOddsMarketKey(
    market?.key ||
      market?.marketKey ||
      market?.market_key ||
      ""
  );
}

function getBilanMarketLabel(market = {}, key = "") {
  return (
    market?.label ||
    market?.marketLabel ||
    market?.market_label ||
    ({
      HOME: "Victoire domicile",
      DRAW: "Match nul",
      AWAY: "Victoire extérieur",
      OVER25: "Plus de 2,5 buts",
      UNDER25: "Moins de 2,5 buts",
      BTTS_YES: "Les deux équipes marquent",
      BTTS_NO: "Les deux équipes ne marquent pas",
    }[key] || key || "Marché inconnu")
  );
}

app.get("/public/bilan/ia", async (req, res) => {
  try {
    await ensureStudioPredictionColumns();

    const result = await pool.query(`
      SELECT
        fixture_id,
        home_goals,
        away_goals,
        studio_snapshot
      FROM predictions
      WHERE result_status = 'COMPLETED'
        AND studio_snapshot IS NOT NULL
      ORDER BY fixture_date DESC NULLS LAST
    `);

    const byMarketMap = new Map();
    let matches = 0;
    let marketsAnalyzed = 0;
    let wins = 0;
    let losses = 0;

    for (const prediction of result.rows) {
      const markets = getBilanSnapshotMarkets(
        prediction.studio_snapshot
      );

      let evaluatedForMatch = 0;

      for (const market of markets) {
        const marketKey = getBilanMarketKey(market);
        if (!marketKey) continue;

        const won = evaluateManualOddsMarketResult({
          marketKey,
          homeGoals: prediction.home_goals,
          awayGoals: prediction.away_goals,
        });

        if (typeof won !== "boolean") continue;

        evaluatedForMatch += 1;
        marketsAnalyzed += 1;

        if (won) wins += 1;
        else losses += 1;

        if (!byMarketMap.has(marketKey)) {
          byMarketMap.set(marketKey, {
            marketKey,
            marketLabel: getBilanMarketLabel(market, marketKey),
            evaluated: 0,
            wins: 0,
            losses: 0,
          });
        }

        const stats = byMarketMap.get(marketKey);
        stats.evaluated += 1;
        if (won) stats.wins += 1;
        else stats.losses += 1;
      }

      if (evaluatedForMatch > 0) {
        matches += 1;
      }
    }

    const byMarket = Array.from(byMarketMap.values()).map(
      (stats) => ({
        ...stats,
        accuracy:
          stats.evaluated > 0
            ? bilanPublicRound(
                (stats.wins / stats.evaluated) * 100,
                2
              )
            : 0,
      })
    );

    return res.json({
      ok: true,
      matches,
      marketsAnalyzed,
      wins,
      losses,
      accuracy:
        marketsAnalyzed > 0
          ? bilanPublicRound(
              (wins / marketsAnalyzed) * 100,
              2
            )
          : 0,
      byMarket,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("ERREUR /public/bilan/ia :", error);

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Impossible de charger /public/bilan/ia.",
    });
  }
});

function formatQualifiedBetForPublic(row = {}) {
  const snapshot =
    row.qualification_snapshot &&
    typeof row.qualification_snapshot === "object"
      ? row.qualification_snapshot
      : {};

  return {
    id: row.id,
    fixtureId: Number(row.fixture_id),
    homeTeam:
      row.home_team_name ||
      snapshot?.match?.homeTeam ||
      snapshot?.match?.home ||
      "Domicile",
    awayTeam:
      row.away_team_name ||
      snapshot?.match?.awayTeam ||
      snapshot?.match?.away ||
      "Extérieur",
    competition:
      row.league_name ||
      snapshot?.match?.competition ||
      snapshot?.match?.league ||
      "Compétition inconnue",
    kickoff: row.kickoff || row.fixture_date || null,
    marketKey: row.market_key,
    marketLabel: row.market_label || row.market_key,
    category: String(row.category || "OPPORTUNITY").toUpperCase(),
    betScore:
      row.bet_score === null ? null : Number(row.bet_score),
    decisionScore:
      row.decision_score === null
        ? null
        : Number(row.decision_score),
    probability:
      row.probability === null ? null : Number(row.probability),
    confidence:
      row.confidence === null ? null : Number(row.confidence),
    consensus:
      row.consensus === null ? null : Number(row.consensus),
    reliability:
      row.reliability === null ? null : Number(row.reliability),
    risk: row.risk === null ? null : Number(row.risk),
    valuePercent:
      row.value_percent === null
        ? null
        : Number(row.value_percent),
    bookmakerOdd:
      row.bookmaker_odd === null
        ? null
        : Number(row.bookmaker_odd),
    resultStatus: row.result_status,
    won:
      row.won === null || row.won === undefined
        ? null
        : row.won === true,
    profitUnits:
      row.profit_units === null
        ? null
        : Number(row.profit_units),
    roiPercent:
      row.roi_percent === null
        ? null
        : Number(row.roi_percent),
    frozenAt: row.frozen_at,
    settledAt: row.settled_at,
    qualificationVersion: row.qualification_version || null,
  };
}

function summarizeQualifiedBetRows(rows = []) {
  const volume = rows.length;
  const settledRows = rows.filter((row) =>
    ["WIN", "LOSS", "VOID"].includes(
      String(row.result_status || "").toUpperCase()
    )
  );
  const decisiveRows = settledRows.filter((row) =>
    ["WIN", "LOSS"].includes(
      String(row.result_status || "").toUpperCase()
    )
  );
  const pricedRows = decisiveRows.filter(
    (row) =>
      Number(row.bookmaker_odd) > 1 &&
      Number.isFinite(Number(row.profit_units))
  );

  const wins = decisiveRows.filter(
    (row) => String(row.result_status).toUpperCase() === "WIN"
  ).length;
  const losses = decisiveRows.filter(
    (row) => String(row.result_status).toUpperCase() === "LOSS"
  ).length;
  const voids = settledRows.filter(
    (row) => String(row.result_status).toUpperCase() === "VOID"
  ).length;
  const profit = pricedRows.reduce(
    (sum, row) => sum + bilanPublicNumber(row.profit_units),
    0
  );
  const averageOdd =
    pricedRows.length > 0
      ? pricedRows.reduce(
          (sum, row) => sum + bilanPublicNumber(row.bookmaker_odd),
          0
        ) / pricedRows.length
      : null;

  return {
    volume,
    settled: settledRows.length,
    pending: Math.max(0, volume - settledRows.length),
    wins,
    losses,
    voids,
    priced: pricedRows.length,
    accuracy:
      decisiveRows.length > 0
        ? bilanPublicRound((wins / decisiveRows.length) * 100, 2)
        : 0,
    profit: bilanPublicRound(profit, 2),
    roi:
      pricedRows.length > 0
        ? bilanPublicRound((profit / pricedRows.length) * 100, 2)
        : null,
    averageOdd:
      averageOdd === null
        ? null
        : bilanPublicRound(averageOdd, 2),
  };
}


/*
 * ============================================================
 * DAILY BET PORTFOLIO ENGINE — IA PICKS + PREMIUM
 * ============================================================
 * Sélection relative quotidienne :
 * - conserve les catégories Premium SAFE / VALUE / OPPORTUNITY ;
 * - complète avec IA_PICK parmi les meilleurs candidats du jour ;
 * - un seul pari par match ;
 * - diversification par marché et compétition ;
 * - gel uniquement entre T-30 et T-10.
 */
const DAILY_PORTFOLIO_VERSION = "daily-portfolio-v1.0.0";
const DAILY_PORTFOLIO_MIN_TARGET = 3;
const DAILY_PORTFOLIO_MAX_TARGET = 12;
const DAILY_PORTFOLIO_SHARE = 0.14;
const DAILY_PORTFOLIO_MAX_PER_MARKET = 3;
const DAILY_PORTFOLIO_MAX_PER_LEAGUE = 3;

function portfolioNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function portfolioNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function portfolioClamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, portfolioNumber(value)));
}

function portfolioRound(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(portfolioNumber(value) * factor) / factor;
}

function portfolioMarketKey(value) {
  return normalizeManualOddsMarketKey(value || "");
}

function portfolioSnapshotMarkets(prediction = {}) {
  const snapshot = prediction.studio_snapshot && typeof prediction.studio_snapshot === "object"
    ? prediction.studio_snapshot
    : {};
  const markets = Array.isArray(snapshot.markets)
    ? snapshot.markets
    : Array.isArray(snapshot?.studio?.markets)
      ? snapshot.studio.markets
      : [];
  if (markets.length > 0) return markets;
  const fallback = snapshot.primaryMarket || snapshot.bestDecision;
  if (fallback) return [fallback];
  if (prediction.studio_market_key) {
    return [{
      key: prediction.studio_market_key,
      label: prediction.studio_market_label,
      probability: prediction.studio_probability,
      decisionScore: prediction.studio_decision_score,
    }];
  }
  return [];
}

function portfolioCandidateFromMarket(prediction, market) {
  const marketKey = portfolioMarketKey(market?.key || market?.marketKey);
  if (!isSupportedDailyTicketMarketKey(marketKey)) return null;

  const qualification = market?.betQualification || market?.qualification || {};
  const criteria = qualification?.criteria || {};
  const decisionScore = portfolioClamp(
    market?.decision?.score ?? market?.marketDecision?.score ?? market?.decisionScore ?? market?.score ?? prediction.studio_decision_score
  );
  const probability = portfolioClamp(
    market?.fairOdds?.calibratedProbability ?? market?.calibratedProbability ?? market?.probability ?? prediction.studio_probability
  );
  const reliability = portfolioClamp(
    criteria.reliability ?? market?.marketReliability?.score ?? market?.reliability?.score ?? market?.reliability ?? 50
  );
  const consensus = portfolioClamp(
    criteria.consensus ?? market?.decision?.marketConsensus?.score ?? market?.consensusScore ?? 50
  );
  const risk = portfolioClamp(
    criteria.risk ?? market?.decision?.risk ?? prediction.risk ?? 50
  );
  const confidence = portfolioClamp(
    criteria.confidence ?? market?.decision?.confidence ?? prediction.confidence ?? 50
  );
  const oddData = getDailyTicketMarketOdd(market, prediction);
  const valuePercent = portfolioNullableNumber(
    criteria.valuePercent ?? market?.expectedValuePercent ?? market?.valueEdge
  ) ?? (
    oddData.odd && probability > 0
      ? portfolioRound((probability / 100) * oddData.odd * 100 - 100, 2)
      : null
  );
  const betScore = portfolioClamp(
    qualification?.betScore ??
      decisionScore * 0.35 +
      probability * 0.12 +
      confidence * 0.13 +
      consensus * 0.12 +
      reliability * 0.18 +
      (100 - risk) * 0.10
  );
  const blockingReasons = Array.isArray(qualification?.blockingReasons)
    ? qualification.blockingReasons.filter(Boolean)
    : [];
  const hardBlocked =
    blockingReasons.length > 0 ||
    decisionScore < 60 ||
    betScore < 55 ||
    reliability < 45 ||
    risk > 82 ||
    probability < 20 ||
    probability > 95;

  const valueQuality = valuePercent === null
    ? 45
    : portfolioClamp(50 + valuePercent * 2.5);
  const missingOddPenalty = oddData.odd && oddData.odd > 1 ? 0 : 6;
  const highRiskPenalty = Math.max(0, risk - 60) * 0.18;
  const portfolioScore = portfolioClamp(
    betScore * 0.35 +
    decisionScore * 0.25 +
    reliability * 0.15 +
    consensus * 0.10 +
    probability * 0.05 +
    valueQuality * 0.10 -
    missingOddPenalty -
    highRiskPenalty
  );

  const premiumCategory = ["SAFE", "VALUE", "OPPORTUNITY"].includes(
    String(qualification?.category || "").toUpperCase()
  ) && qualification?.qualified === true
    ? String(qualification.category).toUpperCase()
    : null;

  return {
    fixtureId: Number(prediction.fixture_id),
    kickoff: prediction.fixture_date,
    leagueName: prediction.league_name || "Compétition inconnue",
    homeTeam: prediction.home_team_name || "Domicile",
    awayTeam: prediction.away_team_name || "Extérieur",
    marketKey,
    marketLabel: market?.label || market?.marketLabel || marketKey,
    category: premiumCategory || "IA_PICK",
    selectionSource: premiumCategory ? "PREMIUM" : "DAILY_PORTFOLIO",
    portfolioScore: portfolioRound(portfolioScore, 1),
    betScore: portfolioRound(betScore, 1),
    decisionScore: portfolioRound(decisionScore, 1),
    probability: portfolioRound(probability, 1),
    confidence: portfolioRound(confidence, 1),
    consensus: portfolioRound(consensus, 1),
    reliability: portfolioRound(reliability, 1),
    risk: portfolioRound(risk, 1),
    valuePercent,
    bookmakerOdd: oddData.odd,
    bookmaker: oddData.bookmaker,
    bookmakerSource: oddData.source,
    qualificationVersion:
      qualification?.version || qualification?.thresholdsVersion || DAILY_PORTFOLIO_VERSION,
    qualificationSnapshot: {
      originalQualification: qualification,
      portfolio: {
        version: DAILY_PORTFOLIO_VERSION,
        portfolioScore: portfolioRound(portfolioScore, 1),
        selectionSource: premiumCategory ? "PREMIUM" : "DAILY_PORTFOLIO",
        safetyFloor: {
          minimumDecisionScore: 60,
          minimumBetScore: 55,
          minimumReliability: 45,
          maximumRisk: 82,
          probabilityRange: [20, 95],
        },
      },
    },
    hardBlocked,
    blockingReasons,
  };
}

function buildDailyPortfolio(candidates = [], matchCount = 0) {
  const target = Math.max(
    DAILY_PORTFOLIO_MIN_TARGET,
    Math.min(
      DAILY_PORTFOLIO_MAX_TARGET,
      Math.round(Math.max(1, matchCount) * DAILY_PORTFOLIO_SHARE)
    )
  );
  const ranked = candidates
    .filter((candidate) => candidate && !candidate.hardBlocked)
    .sort((a, b) =>
      Number(Boolean(b.bookmakerOdd)) - Number(Boolean(a.bookmakerOdd)) ||
      b.portfolioScore - a.portfolioScore ||
      b.betScore - a.betScore ||
      b.decisionScore - a.decisionScore
    );

  const selected = [];
  const usedFixtures = new Set();
  const marketCounts = new Map();
  const leagueCounts = new Map();

  for (const candidate of ranked) {
    if (selected.length >= target) break;
    if (usedFixtures.has(candidate.fixtureId)) continue;
    const marketCount = marketCounts.get(candidate.marketKey) || 0;
    const leagueCount = leagueCounts.get(candidate.leagueName) || 0;
    if (marketCount >= DAILY_PORTFOLIO_MAX_PER_MARKET) continue;
    if (leagueCount >= DAILY_PORTFOLIO_MAX_PER_LEAGUE) continue;

    selected.push({
      ...candidate,
      dailyRank: selected.length + 1,
      targetSize: target,
    });
    usedFixtures.add(candidate.fixtureId);
    marketCounts.set(candidate.marketKey, marketCount + 1);
    leagueCounts.set(candidate.leagueName, leagueCount + 1);
  }

  return { target, rankedCount: ranked.length, selected };
}

async function ensureDailyPortfolioColumns() {
  await ensureBetQualificationCalibrationTables();
  await pool.query(`
    ALTER TABLE qualified_bets
      ADD COLUMN IF NOT EXISTS selection_source TEXT,
      ADD COLUMN IF NOT EXISTS portfolio_score NUMERIC,
      ADD COLUMN IF NOT EXISTS daily_rank INTEGER,
      ADD COLUMN IF NOT EXISTS portfolio_date DATE,
      ADD COLUMN IF NOT EXISTS bookmaker TEXT,
      ADD COLUMN IF NOT EXISTS bookmaker_source TEXT;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_qualified_bets_portfolio_date
    ON qualified_bets(portfolio_date, daily_rank);
  `);
}

async function loadDailyPortfolio(date = null) {
  await ensureDailyPortfolioColumns();
  const portfolioDate = date || new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const result = await pool.query(
    `
      SELECT *
      FROM predictions
      WHERE (fixture_date AT TIME ZONE 'Europe/Paris')::date = $1::date
        AND fixture_date > NOW()
        AND studio_snapshot IS NOT NULL
      ORDER BY fixture_date ASC, fixture_id ASC
    `,
    [portfolioDate]
  );
  const candidates = [];
  const automaticOddsMap = await oddsSyncService.getCurrentOddsMap(
    result.rows.map((prediction) => prediction.fixture_id)
  );

  for (const prediction of result.rows) {
    for (const rawMarket of portfolioSnapshotMarkets(prediction)) {
      const market = oddsSyncService.applyOddsToMarket(
        prediction.fixture_id,
        rawMarket,
        automaticOddsMap
      );
      const candidate = portfolioCandidateFromMarket(prediction, market);
      if (candidate) candidates.push(candidate);
    }
  }
  const portfolio = buildDailyPortfolio(candidates, result.rows.length);
  return {
    date: portfolioDate,
    sourceMatches: result.rows.length,
    analyzedMarkets: candidates.length,
    ...portfolio,
  };
}

async function freezeDailyPortfolioSelections() {
  const portfolio = await loadDailyPortfolio();
  const now = Date.now();
  let frozen = 0;
  let skipped = 0;

  for (const candidate of portfolio.selected) {
    const kickoff = new Date(candidate.kickoff);
    if (Number.isNaN(kickoff.getTime())) {
      skipped += 1;
      continue;
    }
    const minutesBefore = (kickoff.getTime() - now) / 60000;
    if (minutesBefore > 30 || minutesBefore < 10) continue;

    const result = await pool.query(
      `
        INSERT INTO qualified_bets (
          fixture_id, market_key, market_label, category,
          bet_score, decision_score, probability, confidence,
          consensus, reliability, risk, value_percent,
          bookmaker_odd, bookmaker, bookmaker_source,
          qualification_version, qualification_snapshot,
          selection_source, portfolio_score, daily_rank,
          portfolio_date, frozen_at, kickoff,
          result_status, updated_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15,
          $16, $17::jsonb,
          $18, $19, $20,
          $21::date, NOW(), $22,
          'PENDING', NOW()
        )
        ON CONFLICT (fixture_id, market_key) DO NOTHING
        RETURNING id
      `,
      [
        candidate.fixtureId,
        candidate.marketKey,
        candidate.marketLabel,
        candidate.category,
        candidate.betScore,
        candidate.decisionScore,
        candidate.probability,
        candidate.confidence,
        candidate.consensus,
        candidate.reliability,
        candidate.risk,
        candidate.valuePercent,
        candidate.bookmakerOdd,
        candidate.bookmaker,
        candidate.bookmakerSource,
        candidate.qualificationVersion,
        JSON.stringify(candidate.qualificationSnapshot),
        candidate.selectionSource,
        candidate.portfolioScore,
        candidate.dailyRank,
        portfolio.date,
        kickoff.toISOString(),
      ]
    );
    if (result.rows.length > 0) frozen += 1;
    else skipped += 1;
  }

  return { ...portfolio, frozen, skipped, checkedAt: new Date().toISOString() };
}

function settlePortfolioMarket(marketKey, homeGoals, awayGoals) {
  const key = portfolioMarketKey(marketKey);
  const total = homeGoals + awayGoals;
  if (key === "HOME") return homeGoals > awayGoals;
  if (key === "DRAW") return homeGoals === awayGoals;
  if (key === "AWAY") return awayGoals > homeGoals;
  if (key === "OVER25") return total >= 3;
  if (key === "UNDER25") return total <= 2;
  if (key === "BTTS_YES") return homeGoals > 0 && awayGoals > 0;
  if (key === "BTTS_NO") return homeGoals === 0 || awayGoals === 0;
  return null;
}

async function settleDailyPortfolioBets() {
  await ensureDailyPortfolioColumns();
  const result = await pool.query(`
    SELECT qb.id, qb.market_key, qb.bookmaker_odd,
           p.home_goals, p.away_goals, p.result_status
    FROM qualified_bets qb
    JOIN predictions p ON p.fixture_id = qb.fixture_id
    WHERE qb.result_status = 'PENDING'
      AND UPPER(COALESCE(p.result_status, '')) IN ('FT','AET','PEN','FINISHED','COMPLETED')
      AND p.home_goals IS NOT NULL
      AND p.away_goals IS NOT NULL
  `);
  let settled = 0;
  for (const row of result.rows) {
    const won = settlePortfolioMarket(
      row.market_key,
      Number(row.home_goals),
      Number(row.away_goals)
    );
    if (won === null) continue;
    const odd = portfolioNullableNumber(row.bookmaker_odd);
    const profit = odd && odd > 1 ? (won ? odd - 1 : -1) : null;
    await pool.query(
      `
        UPDATE qualified_bets
        SET result_status = $2,
            won = $3,
            profit_units = $4,
            roi_percent = $5,
            settled_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [row.id, won ? "WIN" : "LOSS", won, profit, profit === null ? null : profit * 100]
    );
    settled += 1;
  }
  return { settled, checked: result.rows.length, settledAt: new Date().toISOString() };
}

app.get("/public/bet-portfolio/daily", async (req, res) => {
  try {
    const portfolio = await loadDailyPortfolio(req.query.date || null);
    return res.json({ ok: true, version: DAILY_PORTFOLIO_VERSION, ...portfolio });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || "Impossible de charger le portefeuille IA." });
  }
});

app.post("/internal/bet-portfolio/freeze", async (req, res) => {
  if (!requireOptionalAdminKey(req, res)) return;
  try {
    return res.json({ ok: true, ...(await freezeDailyPortfolioSelections()) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || "Impossible de figer le portefeuille IA." });
  }
});

app.post("/internal/bet-portfolio/settle", async (req, res) => {
  if (!requireOptionalAdminKey(req, res)) return;
  try {
    return res.json({ ok: true, ...(await settleDailyPortfolioBets()) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || "Impossible de régler le portefeuille IA." });
  }
});

if (AUTOMATIC_SCHEDULERS_ENABLED) {
  setTimeout(() => {
    freezeDailyPortfolioSelections().catch((error) =>
      console.error("DAILY PORTFOLIO FREEZE INIT :", error)
    );
    settleDailyPortfolioBets().catch((error) =>
      console.error("DAILY PORTFOLIO SETTLE INIT :", error)
    );
  }, 90 * 1000);

  setInterval(() => {
    freezeDailyPortfolioSelections().catch((error) =>
      console.error("DAILY PORTFOLIO FREEZE :", error)
    );
  }, 60 * 1000);

  setInterval(() => {
    settleDailyPortfolioBets().catch((error) =>
      console.error("DAILY PORTFOLIO SETTLE :", error)
    );
  }, 5 * 60 * 1000);
}



/*
 * ============================================================
 * BILAN DÉTAILLÉ — DERNIER MARCHÉ PRINCIPAL PAR MATCH
 * ============================================================
 * Ce bilan est strictement analytique :
 * - un seul marché principal par match terminé ;
 * - résultat correct / incorrect ;
 * - cote observée au moment du snapshot ou dernière cote stockée ;
 * - aucun calcul de mise, profit ou ROI.
 */

function detailedBilanNormalizeMarketKey(value = "") {
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

function detailedBilanMarketLabel(key, fallback = null) {
  return (
    {
      HOME: "Victoire domicile",
      DRAW: "Match nul",
      AWAY: "Victoire extérieur",
      BTTS_YES: "Les deux équipes marquent",
      BTTS_NO: "Les deux équipes ne marquent pas",
      OVER25: "Plus de 2,5 buts",
      UNDER25: "Moins de 2,5 buts",
    }[key] ||
    fallback ||
    key ||
    "Marché inconnu"
  );
}

function detailedBilanEvaluateMarket(marketKey, homeGoals, awayGoals) {
  const key = detailedBilanNormalizeMarketKey(marketKey);
  const home = Number(homeGoals);
  const away = Number(awayGoals);

  if (!Number.isFinite(home) || !Number.isFinite(away)) {
    return null;
  }

  if (key === "HOME") return home > away;
  if (key === "DRAW") return home === away;
  if (key === "AWAY") return away > home;
  if (key === "BTTS_YES") return home > 0 && away > 0;
  if (key === "BTTS_NO") return home === 0 || away === 0;
  if (key === "OVER25") return home + away >= 3;
  if (key === "UNDER25") return home + away <= 2;

  return null;
}

function detailedBilanNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function detailedBilanExtractSnapshotMarket(prediction = {}) {
  const snapshot =
    prediction.studio_snapshot &&
    typeof prediction.studio_snapshot === "object"
      ? prediction.studio_snapshot
      : {};

  const primary =
    snapshot.primaryMarket ||
    snapshot.bestDecision ||
    snapshot.studio?.primaryMarket ||
    null;

  const marketKey = detailedBilanNormalizeMarketKey(
    prediction.studio_market_key ||
      primary?.key ||
      primary?.marketKey ||
      ""
  );

  const marketLabel =
    prediction.studio_market_label ||
    primary?.label ||
    primary?.marketLabel ||
    detailedBilanMarketLabel(marketKey);

  const probability = detailedBilanNumberOrNull(
    prediction.studio_probability ??
      primary?.fairOdds?.calibratedProbability ??
      primary?.calibratedProbability ??
      primary?.probability
  );

  const decisionScore = detailedBilanNumberOrNull(
    prediction.studio_decision_score ??
      primary?.decision?.score ??
      primary?.marketDecision?.score ??
      primary?.decisionScore ??
      primary?.score
  );

  const snapshotOdd = detailedBilanNumberOrNull(
    primary?.fairOdds?.bookmakerOdds ??
      primary?.oddsMetrics?.bookmakerOdds ??
      primary?.bookmakerOdds ??
      snapshot?.bookmakerOdd
  );

  const snapshotBookmaker =
    primary?.fairOdds?.bookmaker ||
    primary?.oddsMetrics?.bookmaker ||
    primary?.bookmaker ||
    snapshot?.bookmaker ||
    null;

  const snapshotSource =
    primary?.fairOdds?.bookmakerSource ||
    primary?.oddsMetrics?.bookmakerSource ||
    primary?.bookmakerSource ||
    snapshot?.bookmakerOddSource ||
    null;

  return {
    marketKey,
    marketLabel,
    probability,
    decisionScore,
    snapshotOdd,
    snapshotBookmaker,
    snapshotSource,
  };
}

app.get("/public/bilan/detaille", async (req, res) => {
  try {
    await ensureStudioPredictionColumns();

    /*
     * Aucun plafond arbitraire ici :
     * la route doit rendre disponible tout l'historique des matchs terminés.
     * L'interface limite seulement le nombre de cartes visibles et permet
     * d'en charger davantage par blocs de 50.
     */
    const result = await pool.query(
      `
        SELECT DISTINCT ON (p.fixture_id)
          p.fixture_id,
          p.fixture_date,
          p.home_team_name,
          p.away_team_name,
          p.league_name,
          p.home_goals,
          p.away_goals,
          p.result_status,
          p.studio_market_key,
          p.studio_market_label,
          p.studio_probability,
          p.studio_decision_score,
          p.studio_snapshot,
          p.studio_saved_at,
          p.manual_market_key,
          p.manual_market_odd,
          p.manual_odd_source,
          p.manual_odd_updated_at
        FROM predictions p
        WHERE UPPER(COALESCE(p.result_status, '')) IN (
          'FT', 'AET', 'PEN', 'FINISHED', 'COMPLETED'
        )
          AND p.home_goals IS NOT NULL
          AND p.away_goals IS NOT NULL
          AND (
            p.studio_snapshot IS NOT NULL
            OR NULLIF(BTRIM(COALESCE(p.studio_market_key, '')), '') IS NOT NULL
          )
        ORDER BY
          p.fixture_id,
          p.updated_at DESC NULLS LAST,
          p.id DESC
      `
    );

    const fixtureIds = result.rows
      .map((row) => Number(row.fixture_id))
      .filter((fixtureId) => Number.isInteger(fixtureId));

    let oddsMap = new Map();

    if (fixtureIds.length > 0) {
      const oddsResult = await pool.query(
        `
          SELECT DISTINCT ON (fixture_id, market_key)
            fixture_id,
            market_key,
            odd,
            bookmaker_name,
            source,
            captured_at
          FROM market_odds
          WHERE fixture_id = ANY($1::bigint[])
          ORDER BY
            fixture_id,
            market_key,
            captured_at DESC,
            id DESC
        `,
        [fixtureIds]
      );

      oddsMap = new Map(
        oddsResult.rows.map((row) => [
          `${Number(row.fixture_id)}:${detailedBilanNormalizeMarketKey(
            row.market_key
          )}`,
          row,
        ])
      );
    }

    const analyses = [];

    for (const prediction of result.rows) {
      const primary = detailedBilanExtractSnapshotMarket(prediction);

      if (!primary.marketKey) continue;

      const won = detailedBilanEvaluateMarket(
        primary.marketKey,
        prediction.home_goals,
        prediction.away_goals
      );

      if (won === null) continue;

      const manualKey = detailedBilanNormalizeMarketKey(
        prediction.manual_market_key
      );
      const manualOdd =
        manualKey === primary.marketKey
          ? detailedBilanNumberOrNull(prediction.manual_market_odd)
          : null;

      const automaticOdd = oddsMap.get(
        `${Number(prediction.fixture_id)}:${primary.marketKey}`
      );

      const bookmakerOdd =
        manualOdd && manualOdd > 1
          ? manualOdd
          : primary.snapshotOdd && primary.snapshotOdd > 1
            ? primary.snapshotOdd
            : detailedBilanNumberOrNull(automaticOdd?.odd);

      const bookmaker =
        manualOdd && manualOdd > 1
          ? prediction.manual_odd_source || "Admin Football AI Pro"
          : primary.snapshotOdd && primary.snapshotOdd > 1
            ? primary.snapshotBookmaker
            : automaticOdd?.bookmaker_name || null;

      const bookmakerSource =
        manualOdd && manualOdd > 1
          ? "MANUAL_ADMIN"
          : primary.snapshotOdd && primary.snapshotOdd > 1
            ? primary.snapshotSource || "STUDIO_SNAPSHOT"
            : automaticOdd?.source || null;

      analyses.push({
        fixtureId: Number(prediction.fixture_id),
        kickoff: prediction.fixture_date,
        homeTeam: prediction.home_team_name || "Domicile",
        awayTeam: prediction.away_team_name || "Extérieur",
        competition:
          prediction.league_name || "Compétition inconnue",
        homeGoals: Number(prediction.home_goals),
        awayGoals: Number(prediction.away_goals),
        finalScore: `${Number(prediction.home_goals)}-${Number(
          prediction.away_goals
        )}`,
        marketKey: primary.marketKey,
        marketLabel: detailedBilanMarketLabel(
          primary.marketKey,
          primary.marketLabel
        ),
        probability: primary.probability,
        decisionScore: primary.decisionScore,
        bookmakerOdd:
          bookmakerOdd && bookmakerOdd > 1 ? bookmakerOdd : null,
        bookmaker,
        bookmakerSource,
        correct: won,
        result: won ? "CORRECT" : "INCORRECT",
        analyzedAt: prediction.studio_saved_at || null,
      });
    }

    analyses.sort(
      (first, second) =>
        new Date(second.kickoff || 0).getTime() -
        new Date(first.kickoff || 0).getTime()
    );

    const correct = analyses.filter((item) => item.correct === true).length;
    const incorrect = analyses.filter((item) => item.correct === false).length;

    return res.json({
      ok: true,
      summary: {
        matches: analyses.length,
        correct,
        incorrect,
        accuracy:
          analyses.length > 0
            ? Math.round((correct / analyses.length) * 10000) / 100
            : 0,
        withOdds: analyses.filter(
          (item) => Number(item.bookmakerOdd) > 1
        ).length,
      },
      recent: analyses,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("ERREUR /public/bilan/detaille :", error);

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Impossible de charger le Bilan détaillé.",
    });
  }
});


app.get("/public/bilan/paris", async (req, res) => {
  try {
    await ensureBetQualificationCalibrationTables();

    const result = await pool.query(`
      SELECT
        qb.*,
        p.fixture_date,
        p.home_team_name,
        p.away_team_name,
        p.league_name
      FROM qualified_bets qb
      LEFT JOIN predictions p
        ON p.fixture_id = qb.fixture_id
      ORDER BY qb.frozen_at DESC, qb.id DESC
      LIMIT 1000
    `);

    const rows = result.rows;
    const categories = {};

    for (const category of ["SAFE", "VALUE", "OPPORTUNITY", "IA_PICK"]) {
      categories[category] = summarizeQualifiedBetRows(
        rows.filter(
          (row) =>
            String(row.category || "").toUpperCase() === category
        )
      );
    }

    const trackingStartedAt =
      rows.length > 0
        ? rows.reduce((oldest, row) => {
            const current = row.frozen_at
              ? new Date(row.frozen_at)
              : null;
            if (!current || Number.isNaN(current.getTime())) {
              return oldest;
            }
            if (!oldest || current < oldest) return current;
            return oldest;
          }, null)?.toISOString() || null
        : null;

    return res.json({
      ok: true,
      overall: summarizeQualifiedBetRows(rows),
      categories,
      recent: rows.slice(0, 250).map(formatQualifiedBetForPublic),
      trackingStartedAt,
      freezeRule: {
        normalFreezeMinutesBeforeKickoff: 30,
        latestFreezeMinutesBeforeKickoff: 10,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("ERREUR /public/bilan/paris :", error);

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Impossible de charger /public/bilan/paris.",
    });
  }
});

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `FootballBrain API running on 0.0.0.0:${PORT}`
    );

    console.log(
      `API-Football : ${
        API_FOOTBALL_ENABLED
          ? "✅ autorisée"
          : "⏸️ désactivée"
      }`
    );

    console.log(
      `Schedulers automatiques : ${
        AUTOMATIC_SCHEDULERS_ENABLED
          ? "✅ actifs"
          : "⏸️ désactivés"
      }`
    );

    ensureStudioPredictionColumns()
      .catch((error) => {
        console.error(
          "ERREUR COLONNES STUDIO :",
          error
        );
      });

    aiEventEngine
      .ensureTables()
      .catch((error) => {
        console.error(
          "ERREUR TABLE AI_EVENTS :",
          error
        );
      });

    ensureLeagueManagerTables()
      .catch((error) => {
        console.error(
          "ERREUR TABLE LEAGUE MANAGER :",
          error
        );
      });

    ensureLearningEngineTables()
      .catch((error) => {
        console.error(
          "ERREUR TABLES LEARNING ENGINE :",
          error
        );
      });


    ensureCalibrationDecisionTables()
      .catch((error) => {
        console.error(
          "ERREUR TABLES CALIBRATION CENTER :",
          error
        );
      });

    ensureDailyTicketTables()
      .catch((error) => {
        console.error(
          "ERREUR TABLE DAILY TICKETS :",
          error
        );
      });

    oddsSyncService
      .ensureTables()
      .catch((error) => {
        console.error(
          "ERREUR TABLES ODDS SYNC :",
          error
        );
      });

    /*
     * Les initialisations SQL restent actives.
     * Seules les tâches consommatrices d'API
     * dépendent de l'interrupteur.
     */
    oddsSyncService.startScheduler();
    startAutomaticCalibrationScheduler();
    startDailyTicketScheduler();
    startAutomaticSchedulers();
  }
);