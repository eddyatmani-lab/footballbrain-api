const LOTOFOOT_VERSION =
  "lotofoot-engine-v1.0.0";

const LOTOFOOT_MODE =
  "ACTIVE_CONTROLLED";

const SUPPORTED_GRID_TYPES =
  new Set([
    "LF7",
    "LF8",
    "LF12",
    "LF15",
  ]);

function numberOr(
  value,
  fallback = 0
) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function normalizeGridType(
  value
) {
  const normalized =
    String(value || "")
      .trim()
      .toUpperCase()
      .replace(
        /^LOTO[\s_-]*FOOT[\s_-]*/,
        "LF"
      )
      .replace(
        /^LF[\s_-]*/,
        "LF"
      );

  return SUPPORTED_GRID_TYPES.has(
    normalized
  )
    ? normalized
    : null;
}

function normalizePick(
  value
) {
  const normalized =
    String(value || "")
      .trim()
      .toUpperCase();

  if (
    normalized === "1" ||
    normalized === "N" ||
    normalized === "2"
  ) {
    return normalized;
  }

  return null;
}

function clamp(
  value,
  minimum = 0,
  maximum = 100
) {
  return Math.max(
    minimum,
    Math.min(
      maximum,
      numberOr(value)
    )
  );
}

function normalizeProbabilityTriple({
  home,
  draw,
  away,
}) {
  const values = {
    home: Math.max(
      0,
      numberOr(home)
    ),
    draw: Math.max(
      0,
      numberOr(draw)
    ),
    away: Math.max(
      0,
      numberOr(away)
    ),
  };

  const total =
    values.home +
    values.draw +
    values.away;

  if (total <= 0) {
    return {
      home: 0,
      draw: 0,
      away: 0,
    };
  }

  return {
    home: Number(
      (
        values.home /
        total *
        100
      ).toFixed(2)
    ),

    draw: Number(
      (
        values.draw /
        total *
        100
      ).toFixed(2)
    ),

    away: Number(
      (
        values.away /
        total *
        100
      ).toFixed(2)
    ),
  };
}

function createLotoFootEngine({
  app,
  pool,
  adminGuard,
  schedulersEnabled = true,
} = {}) {
  if (!app) {
    throw new Error(
      "LotoFootEngine : app Express manquante."
    );
  }

  if (!pool) {
    throw new Error(
      "LotoFootEngine : pool PostgreSQL manquant."
    );
  }

  async function ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lotofoot_grids (
        id BIGSERIAL PRIMARY KEY,

        grid_type TEXT NOT NULL,
        official_grid_number TEXT,
        source TEXT NOT NULL DEFAULT 'MANUAL_IMPORT',

        title TEXT,
        deadline_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'DRAFT',

        unit_stake NUMERIC(10,2)
          NOT NULL DEFAULT 1.00,

        metadata JSONB
          NOT NULL DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        CONSTRAINT lotofoot_grids_grid_type_check
          CHECK (
            grid_type IN (
              'LF7',
              'LF8',
              'LF12',
              'LF15'
            )
          )
      );
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        idx_lotofoot_grids_official_unique
      ON lotofoot_grids (
        grid_type,
        official_grid_number
      )
      WHERE official_grid_number IS NOT NULL;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
        idx_lotofoot_grids_status
      ON lotofoot_grids (
        status,
        deadline_at
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lotofoot_matches (
        id BIGSERIAL PRIMARY KEY,

        grid_id BIGINT NOT NULL
          REFERENCES lotofoot_grids(id)
          ON DELETE CASCADE,

        line_number INTEGER NOT NULL,

        fixture_id BIGINT,

        home_team_name TEXT NOT NULL,
        away_team_name TEXT NOT NULL,

        fixture_date TIMESTAMPTZ,

        league_id BIGINT,
        league_name TEXT,

        matching_status TEXT
          NOT NULL DEFAULT 'UNMATCHED',

        matching_confidence NUMERIC(5,2),

        public_home_percent NUMERIC(6,2),
        public_draw_percent NUMERIC(6,2),
        public_away_percent NUMERIC(6,2),

        final_result TEXT,

        home_goals INTEGER,
        away_goals INTEGER,

        metadata JSONB
          NOT NULL DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        UNIQUE (
          grid_id,
          line_number
        ),

        CONSTRAINT lotofoot_matches_line_number_check
          CHECK (
            line_number > 0
          ),

        CONSTRAINT lotofoot_matches_final_result_check
          CHECK (
            final_result IS NULL OR
            final_result IN (
              '1',
              'N',
              '2'
            )
          )
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
        idx_lotofoot_matches_fixture
      ON lotofoot_matches (
        fixture_id
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
        idx_lotofoot_matches_grid
      ON lotofoot_matches (
        grid_id,
        line_number
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lotofoot_predictions (
        id BIGSERIAL PRIMARY KEY,

        grid_id BIGINT NOT NULL
          REFERENCES lotofoot_grids(id)
          ON DELETE CASCADE,

        lotofoot_match_id BIGINT NOT NULL
          REFERENCES lotofoot_matches(id)
          ON DELETE CASCADE,

        fixture_id BIGINT,

        footballbrain_home_probability
          NUMERIC(6,2),

        footballbrain_draw_probability
          NUMERIC(6,2),

        footballbrain_away_probability
          NUMERIC(6,2),

        ai_pick TEXT,

        base_score NUMERIC(6,2),
        trap_score NUMERIC(6,2),
        cover_score NUMERIC(6,2),
        surprise_score NUMERIC(6,2),

        recommended_cover TEXT
          NOT NULL DEFAULT 'SIMPLE',

        recommended_selection TEXT,

        analysis_version TEXT
          NOT NULL DEFAULT 'lotofoot-engine-v1.0.0',

        status TEXT
          NOT NULL DEFAULT 'PENDING',

        prediction_payload JSONB
          NOT NULL DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        settled_at TIMESTAMPTZ,

        UNIQUE (
          lotofoot_match_id,
          analysis_version
        ),

        CONSTRAINT lotofoot_predictions_ai_pick_check
          CHECK (
            ai_pick IS NULL OR
            ai_pick IN (
              '1',
              'N',
              '2'
            )
          ),

        CONSTRAINT lotofoot_predictions_cover_check
          CHECK (
            recommended_cover IN (
              'SIMPLE',
              'DOUBLE',
              'TRIPLE'
            )
          )
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
        idx_lotofoot_predictions_grid
      ON lotofoot_predictions (
        grid_id,
        status
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lotofoot_settlements (
        id BIGSERIAL PRIMARY KEY,

        prediction_id BIGINT NOT NULL
          REFERENCES lotofoot_predictions(id)
          ON DELETE CASCADE,

        grid_id BIGINT NOT NULL
          REFERENCES lotofoot_grids(id)
          ON DELETE CASCADE,

        lotofoot_match_id BIGINT NOT NULL
          REFERENCES lotofoot_matches(id)
          ON DELETE CASCADE,

        actual_result TEXT NOT NULL,

        ai_pick_correct BOOLEAN,

        selection_covered BOOLEAN,

        base_hit BOOLEAN,
        trap_event BOOLEAN,

        settled_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        metadata JSONB
          NOT NULL DEFAULT '{}'::jsonb,

        UNIQUE (
          prediction_id
        ),

        CONSTRAINT lotofoot_settlements_actual_result_check
          CHECK (
            actual_result IN (
              '1',
              'N',
              '2'
            )
          )
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lotofoot_learning (
        id BIGSERIAL PRIMARY KEY,

        learning_type TEXT NOT NULL,
        learning_bucket TEXT NOT NULL,

        sample_size INTEGER
          NOT NULL DEFAULT 0,

        hit_count INTEGER
          NOT NULL DEFAULT 0,

        hit_rate NUMERIC(8,4),

        average_predicted_probability
          NUMERIC(8,4),

        actual_frequency
          NUMERIC(8,4),

        calibration_gap
          NUMERIC(8,4),

        brier_score NUMERIC(12,8),

        reliability_level TEXT
          NOT NULL DEFAULT
          'INSUFFICIENT_DATA',

        learning_version TEXT
          NOT NULL DEFAULT
          'lotofoot-learning-v1',

        calculated_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        UNIQUE (
          learning_type,
          learning_bucket,
          learning_version
        )
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lotofoot_runs (
        id BIGSERIAL PRIMARY KEY,

        run_type TEXT NOT NULL,
        status TEXT NOT NULL,

        rows_processed INTEGER
          NOT NULL DEFAULT 0,

        summary JSONB
          NOT NULL DEFAULT '{}'::jsonb,

        error_message TEXT,

        started_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        finished_at TIMESTAMPTZ
      );
    `);
  }

  async function getStatus() {
    await ensureTables();

    const result =
      await pool.query(`
        SELECT
          (
            SELECT COUNT(*)::INTEGER
            FROM lotofoot_grids
          ) AS grids,

          (
            SELECT COUNT(*)::INTEGER
            FROM lotofoot_matches
          ) AS matches,

          (
            SELECT COUNT(*)::INTEGER
            FROM lotofoot_predictions
          ) AS predictions,

          (
            SELECT COUNT(*)::INTEGER
            FROM lotofoot_settlements
          ) AS settled,

          (
            SELECT COUNT(*)::INTEGER
            FROM lotofoot_learning
          ) AS learning_groups
      `);

    const row =
      result.rows[0] || {};

    return {
      ok: true,
      version:
        LOTOFOOT_VERSION,

      mode:
        LOTOFOOT_MODE,

      grids:
        numberOr(
          row.grids
        ),

      matches:
        numberOr(
          row.matches
        ),

      predictions:
        numberOr(
          row.predictions
        ),

      settled:
        numberOr(
          row.settled
        ),

      learningGroups:
        numberOr(
          row.learning_groups
        ),

      supportedGridTypes:
        [
          "LF7",
          "LF8",
          "LF12",
          "LF15",
        ],

      schedulersEnabled:
        Boolean(
          schedulersEnabled
        ),

      generatedAt:
        new Date().toISOString(),
    };
  }

  function protectAdmin(
    handler
  ) {
    return async function protectedHandler(
      req,
      res,
      next
    ) {
      if (
        typeof adminGuard ===
        "function"
      ) {
        let guardPassed =
          false;

        const guardNext = () => {
          guardPassed = true;
        };

        await adminGuard(
          req,
          res,
          guardNext
        );

        if (
          !guardPassed ||
          res.headersSent
        ) {
          return;
        }
      }

      return handler(
        req,
        res,
        next
      );
    };
  }

  function registerRoutes() {
    app.get(
      "/internal/lotofoot/status",
      protectAdmin(
        async (req, res) => {
          try {
            const status =
              await getStatus();

            return res.json(
              status
            );
          } catch (error) {
            console.error(
              "LOTOFOOT STATUS ERROR :",
              error
            );

            return res
              .status(500)
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,

                error:
                  error?.message ||
                  "Impossible de charger le statut Loto Foot.",
              });
          }
        }
      )
    );

    app.post(
      "/internal/lotofoot/ensure-tables",
      protectAdmin(
        async (req, res) => {
          try {
            await ensureTables();

            return res.json({
              ok: true,
              version:
                LOTOFOOT_VERSION,

              message:
                "Tables Loto Foot prêtes.",

              generatedAt:
                new Date().toISOString(),
            });
          } catch (error) {
            console.error(
              "LOTOFOOT ENSURE TABLES ERROR :",
              error
            );

            return res
              .status(500)
              .json({
                ok: false,
                error:
                  error?.message ||
                  "Impossible de préparer les tables Loto Foot.",
              });
          }
        }
      )
    );
  }

  async function initialize() {
    await ensureTables();

    console.log(
      "✅ LotoFootEngine initialisé",
      {
        version:
          LOTOFOOT_VERSION,

        mode:
          LOTOFOOT_MODE,

        schedulersEnabled:
          Boolean(
            schedulersEnabled
          ),
      }
    );
  }

  return {
    version:
      LOTOFOOT_VERSION,

    mode:
      LOTOFOOT_MODE,

    ensureTables,
    getStatus,
    registerRoutes,
    initialize,

    helpers: {
      normalizeGridType,
      normalizePick,
      normalizeProbabilityTriple,
      clamp,
    },
  };
}

module.exports = {
  createLotoFootEngine,
};
