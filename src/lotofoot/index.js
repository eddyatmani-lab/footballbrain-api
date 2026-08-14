const LOTOFOOT_VERSION =
  "lotofoot-engine-v1.2.0-fixture-matcher";

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


const GRID_LINE_RULES = {
  LF7: {
    standard: 7,
    allowed: [6, 7],
  },
  LF8: {
    standard: 8,
    allowed: [7, 8],
  },
  LF12: {
    standard: 12,
    allowed: [9, 10, 11, 12],
  },
  LF15: {
    standard: 15,
    allowed: [12, 13, 14, 15],
  },
};

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function nullablePercent(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  if (
    !Number.isFinite(number) ||
    number < 0 ||
    number > 100
  ) {
    return NaN;
  }

  return Number(number.toFixed(2));
}

function validateManualGridPayload(payload) {
  const gridType =
    normalizeGridType(
      payload?.gridType
    );

  if (!gridType) {
    throw new Error(
      "gridType invalide. Valeurs acceptées : LF7, LF8, LF12, LF15."
    );
  }

  const matches =
    Array.isArray(payload?.matches)
      ? payload.matches
      : [];

  const rule =
    GRID_LINE_RULES[gridType];

  if (
    !rule.allowed.includes(
      matches.length
    )
  ) {
    throw new Error(
      `${gridType} : ${matches.length} lignes reçues. Nombre autorisé : ${rule.allowed.join(", ")}.`
    );
  }

  const seen =
    new Set();

  const normalizedMatches =
    matches.map(
      (match, index) => {
        const lineNumber =
          Number(
            match?.lineNumber ??
            index + 1
          );

        if (
          !Number.isInteger(
            lineNumber
          ) ||
          lineNumber <= 0
        ) {
          throw new Error(
            `Ligne ${index + 1} : lineNumber invalide.`
          );
        }

        if (
          seen.has(lineNumber)
        ) {
          throw new Error(
            `lineNumber ${lineNumber} présent plusieurs fois.`
          );
        }

        seen.add(lineNumber);

        const homeTeam =
          normalizeText(
            match?.homeTeam
          );

        const awayTeam =
          normalizeText(
            match?.awayTeam
          );

        if (
          !homeTeam ||
          !awayTeam
        ) {
          throw new Error(
            `Ligne ${lineNumber} : les deux équipes sont obligatoires.`
          );
        }

        const publicData =
          match?.public || {};

        const homePercent =
          nullablePercent(
            publicData["1"] ??
            match?.publicHomePercent
          );

        const drawPercent =
          nullablePercent(
            publicData["N"] ??
            publicData["n"] ??
            match?.publicDrawPercent
          );

        const awayPercent =
          nullablePercent(
            publicData["2"] ??
            match?.publicAwayPercent
          );

        if (
          Number.isNaN(homePercent) ||
          Number.isNaN(drawPercent) ||
          Number.isNaN(awayPercent)
        ) {
          throw new Error(
            `Ligne ${lineNumber} : pourcentage public invalide (0 à 100 attendu).`
          );
        }

        const percentages =
          [
            homePercent,
            drawPercent,
            awayPercent,
          ];

        const provided =
          percentages.filter(
            (value) =>
              value !== null
          );

        if (
          provided.length !== 0 &&
          provided.length !== 3
        ) {
          throw new Error(
            `Ligne ${lineNumber} : renseigne les 3 pourcentages publics 1/N/2 ou aucun.`
          );
        }

        if (
          provided.length === 3
        ) {
          const sum =
            provided.reduce(
              (total, value) =>
                total + value,
              0
            );

          if (
            Math.abs(
              sum - 100
            ) > 2
          ) {
            throw new Error(
              `Ligne ${lineNumber} : les pourcentages publics totalisent ${sum.toFixed(2)} %, attendu environ 100 %.`
            );
          }
        }

        return {
          lineNumber,
          homeTeam,
          awayTeam,
          fixtureId:
            match?.fixtureId
              ? Number(
                  match.fixtureId
                )
              : null,
          fixtureDate:
            match?.fixtureDate ||
            null,
          leagueId:
            match?.leagueId
              ? Number(
                  match.leagueId
                )
              : null,
          leagueName:
            normalizeText(
              match?.leagueName
            ) || null,
          publicHomePercent:
            homePercent,
          publicDrawPercent:
            drawPercent,
          publicAwayPercent:
            awayPercent,
          metadata:
            match?.metadata &&
            typeof match.metadata ===
              "object"
              ? match.metadata
              : {},
        };
      }
    );

  normalizedMatches.sort(
    (a, b) =>
      a.lineNumber -
      b.lineNumber
  );

  return {
    gridType,
    officialGridNumber:
      normalizeText(
        payload?.officialGridNumber
      ) || null,
    title:
      normalizeText(
        payload?.title
      ) || null,
    deadlineAt:
      payload?.deadlineAt ||
      null,
    unitStake:
      Number.isFinite(
        Number(
          payload?.unitStake
        )
      )
        ? Number(
            payload.unitStake
          )
        : 1,
    metadata:
      payload?.metadata &&
      typeof payload.metadata ===
        "object"
        ? payload.metadata
        : {},
    matches:
      normalizedMatches,
  };
}


function normalizeTeamNameForMatch(
  value
) {
  return String(value || "")
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .replace(
      /\b(fc|afc|sc|ac|as|rc|cf|club|football|foot)\b/g,
      " "
    )
    .replace(
      /[^a-z0-9]+/g,
      " "
    )
    .trim()
    .replace(/\s+/g, " ");
}

function teamNameSimilarity(
  expected,
  candidate
) {
  const a =
    normalizeTeamNameForMatch(
      expected
    );

  const b =
    normalizeTeamNameForMatch(
      candidate
    );

  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 100;
  }

  if (
    a.includes(b) ||
    b.includes(a)
  ) {
    const shortest =
      Math.min(
        a.length,
        b.length
      );

    const longest =
      Math.max(
        a.length,
        b.length
      );

    return Math.max(
      82,
      Math.round(
        shortest /
        Math.max(1, longest) *
        100
      )
    );
  }

  const tokensA =
    new Set(
      a.split(" ")
        .filter(Boolean)
    );

  const tokensB =
    new Set(
      b.split(" ")
        .filter(Boolean)
    );

  const union =
    new Set([
      ...tokensA,
      ...tokensB,
    ]);

  let intersection = 0;

  for (
    const token of tokensA
  ) {
    if (
      tokensB.has(token)
    ) {
      intersection += 1;
    }
  }

  if (union.size === 0) {
    return 0;
  }

  const jaccard =
    intersection /
    union.size *
    100;

  return Math.round(
    jaccard
  );
}

function fixtureMatchScore(
  lotoMatch,
  fixture
) {
  const homeScore =
    teamNameSimilarity(
      lotoMatch?.home_team_name,
      fixture?.teams?.home?.name
    );

  const awayScore =
    teamNameSimilarity(
      lotoMatch?.away_team_name,
      fixture?.teams?.away?.name
    );

  const direct =
    homeScore * 0.5 +
    awayScore * 0.5;

  const reverseHome =
    teamNameSimilarity(
      lotoMatch?.home_team_name,
      fixture?.teams?.away?.name
    );

  const reverseAway =
    teamNameSimilarity(
      lotoMatch?.away_team_name,
      fixture?.teams?.home?.name
    );

  const reversed =
    reverseHome * 0.5 +
    reverseAway * 0.5;

  return {
    score:
      Math.round(
        Math.max(
          direct,
          reversed * 0.9
        )
      ),

    orientation:
      direct >= reversed
        ? "DIRECT"
        : "REVERSED",

    homeScore:
      Math.round(homeScore),

    awayScore:
      Math.round(awayScore),
  };
}

function formatParisDate(
  value
) {
  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  const formatter =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          "Europe/Paris",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    );

  return formatter.format(date);
}

function addCalendarDays(
  dateString,
  days
) {
  const date =
    new Date(
      `${dateString}T12:00:00Z`
    );

  date.setUTCDate(
    date.getUTCDate() +
    days
  );

  return date
    .toISOString()
    .slice(0, 10);
}

function createLotoFootEngine({
  app,
  pool,
  callApiFootball,
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

  if (
    typeof callApiFootball !==
    "function"
  ) {
    throw new Error(
      "LotoFootEngine : callApiFootball manquante."
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


  async function importManualGrid(
    payload
  ) {
    await ensureTables();

    const data =
      validateManualGridPayload(
        payload
      );

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      let existingGrid =
        null;

      if (
        data.officialGridNumber
      ) {
        const existingResult =
          await client.query(
            `
              SELECT id
              FROM lotofoot_grids
              WHERE grid_type = $1
                AND official_grid_number = $2
              LIMIT 1
            `,
            [
              data.gridType,
              data.officialGridNumber,
            ]
          );

        existingGrid =
          existingResult.rows[0] ||
          null;
      }

      if (existingGrid) {
        throw new Error(
          `La grille ${data.gridType} n°${data.officialGridNumber} existe déjà (id ${existingGrid.id}).`
        );
      }

      const gridResult =
        await client.query(
          `
            INSERT INTO lotofoot_grids (
              grid_type,
              official_grid_number,
              source,
              title,
              deadline_at,
              status,
              unit_stake,
              metadata,
              updated_at
            )
            VALUES (
              $1,
              $2,
              'MANUAL_IMPORT',
              $3,
              $4,
              'IMPORTED',
              $5,
              $6::jsonb,
              NOW()
            )
            RETURNING *
          `,
          [
            data.gridType,
            data.officialGridNumber,
            data.title,
            data.deadlineAt,
            data.unitStake,
            JSON.stringify(
              data.metadata
            ),
          ]
        );

      const grid =
        gridResult.rows[0];

      const insertedMatches =
        [];

      for (
        const match of
        data.matches
      ) {
        const matchResult =
          await client.query(
            `
              INSERT INTO lotofoot_matches (
                grid_id,
                line_number,
                fixture_id,
                home_team_name,
                away_team_name,
                fixture_date,
                league_id,
                league_name,
                matching_status,
                matching_confidence,
                public_home_percent,
                public_draw_percent,
                public_away_percent,
                metadata,
                updated_at
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                $13,
                $14::jsonb,
                NOW()
              )
              RETURNING *
            `,
            [
              grid.id,
              match.lineNumber,
              match.fixtureId,
              match.homeTeam,
              match.awayTeam,
              match.fixtureDate,
              match.leagueId,
              match.leagueName,
              match.fixtureId
                ? "MANUAL_FIXTURE"
                : "UNMATCHED",
              match.fixtureId
                ? 100
                : null,
              match.publicHomePercent,
              match.publicDrawPercent,
              match.publicAwayPercent,
              JSON.stringify(
                match.metadata
              ),
            ]
          );

        insertedMatches.push(
          matchResult.rows[0]
        );
      }

      await client.query(
        "COMMIT"
      );

      return {
        ok: true,
        version:
          LOTOFOOT_VERSION,
        imported: true,
        grid: {
          id:
            numberOr(grid.id),
          gridType:
            grid.grid_type,
          officialGridNumber:
            grid.official_grid_number,
          source:
            grid.source,
          title:
            grid.title,
          deadlineAt:
            grid.deadline_at,
          status:
            grid.status,
          unitStake:
            numberOr(
              grid.unit_stake,
              1
            ),
          matches:
            insertedMatches.length,
        },
        generatedAt:
          new Date().toISOString(),
      };
    } catch (error) {
      await client.query(
        "ROLLBACK"
      );

      throw error;
    } finally {
      client.release();
    }
  }

  async function listGrids({
    limit = 50,
  } = {}) {
    await ensureTables();

    const safeLimit =
      Math.max(
        1,
        Math.min(
          200,
          Number(limit) || 50
        )
      );

    const result =
      await pool.query(
        `
          SELECT
            g.*,
            COUNT(m.id)::INTEGER
              AS match_count
          FROM lotofoot_grids g
          LEFT JOIN lotofoot_matches m
            ON m.grid_id = g.id
          GROUP BY g.id
          ORDER BY
            g.deadline_at DESC NULLS LAST,
            g.id DESC
          LIMIT $1
        `,
        [safeLimit]
      );

    return result.rows;
  }

  async function getGrid(
    gridId
  ) {
    await ensureTables();

    const id =
      Number(gridId);

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      return null;
    }

    const gridResult =
      await pool.query(
        `
          SELECT *
          FROM lotofoot_grids
          WHERE id = $1
          LIMIT 1
        `,
        [id]
      );

    const grid =
      gridResult.rows[0];

    if (!grid) {
      return null;
    }

    const matchesResult =
      await pool.query(
        `
          SELECT *
          FROM lotofoot_matches
          WHERE grid_id = $1
          ORDER BY line_number ASC
        `,
        [id]
      );

    return {
      ...grid,
      matches:
        matchesResult.rows,
    };
  }


  async function loadCandidateFixtures(
    grid
  ) {
    const baseDate =
      formatParisDate(
        grid?.deadline_at ||
        new Date()
      );

    if (!baseDate) {
      throw new Error(
        "Impossible de déterminer la date de recherche de la grille."
      );
    }

    /*
     * Fenêtre volontairement large :
     * J-1 / J / J+1.
     * Certaines grilles clôturent avant une série de matchs répartis
     * autour de minuit ou sur deux journées.
     */
    const dates = [
      addCalendarDays(
        baseDate,
        -1
      ),
      baseDate,
      addCalendarDays(
        baseDate,
        1
      ),
    ];

    const fixturesById =
      new Map();

    for (
      const date of dates
    ) {
      const response =
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
          response?.data?.response
        )
          ? response.data.response
          : [];

      for (
        const fixture of
        fixtures
      ) {
        const fixtureId =
          Number(
            fixture?.fixture?.id
          );

        if (
          Number.isInteger(
            fixtureId
          ) &&
          fixtureId > 0
        ) {
          fixturesById.set(
            fixtureId,
            fixture
          );
        }
      }
    }

    return [
      ...fixturesById.values(),
    ];
  }

  async function matchGridFixtures(
    gridId,
    {
      minimumScore = 72,
      force = false,
    } = {}
  ) {
    await ensureTables();

    const grid =
      await getGrid(
        gridId
      );

    if (!grid) {
      throw new Error(
        "Grille Loto Foot introuvable."
      );
    }

    const candidates =
      await loadCandidateFixtures(
        grid
      );

    const results = [];

    for (
      const lotoMatch of
      grid.matches
    ) {
      if (
        lotoMatch.fixture_id &&
        !force
      ) {
        results.push({
          lineNumber:
            Number(
              lotoMatch.line_number
            ),
          status:
            "ALREADY_MATCHED",
          fixtureId:
            Number(
              lotoMatch.fixture_id
            ),
          confidence:
            numberOr(
              lotoMatch.matching_confidence,
              100
            ),
        });

        continue;
      }

      const ranked =
        candidates
          .map((fixture) => {
            const scoring =
              fixtureMatchScore(
                lotoMatch,
                fixture
              );

            return {
              fixture,
              ...scoring,
            };
          })
          .sort(
            (a, b) =>
              b.score -
              a.score
          );

      const best =
        ranked[0] ||
        null;

      const second =
        ranked[1] ||
        null;

      const ambiguous =
        best &&
        second &&
        best.score -
          second.score <
          6;

      if (
        !best ||
        best.score <
          minimumScore ||
        ambiguous
      ) {
        await pool.query(
          `
            UPDATE lotofoot_matches
            SET
              fixture_id = NULL,
              fixture_date = NULL,
              league_id = NULL,
              league_name = NULL,
              matching_status = $2,
              matching_confidence = $3,
              updated_at = NOW()
            WHERE id = $1
          `,
          [
            lotoMatch.id,
            ambiguous
              ? "AMBIGUOUS"
              : "UNMATCHED",
            best
              ? best.score
              : 0,
          ]
        );

        results.push({
          lineNumber:
            Number(
              lotoMatch.line_number
            ),
          homeTeam:
            lotoMatch.home_team_name,
          awayTeam:
            lotoMatch.away_team_name,
          status:
            ambiguous
              ? "AMBIGUOUS"
              : "UNMATCHED",
          confidence:
            best
              ? best.score
              : 0,
          bestCandidate:
            best
              ? {
                  fixtureId:
                    Number(
                      best.fixture
                        ?.fixture?.id
                    ),
                  homeTeam:
                    best.fixture
                      ?.teams?.home?.name,
                  awayTeam:
                    best.fixture
                      ?.teams?.away?.name,
                  score:
                    best.score,
                }
              : null,
        });

        continue;
      }

      const fixture =
        best.fixture;

      await pool.query(
        `
          UPDATE lotofoot_matches
          SET
            fixture_id = $2,
            fixture_date = $3,
            league_id = $4,
            league_name = $5,
            matching_status = 'MATCHED',
            matching_confidence = $6,
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          lotoMatch.id,
          Number(
            fixture?.fixture?.id
          ),
          fixture?.fixture?.date ||
            null,
          fixture?.league?.id ||
            null,
          fixture?.league?.name ||
            null,
          best.score,
        ]
      );

      results.push({
        lineNumber:
          Number(
            lotoMatch.line_number
          ),
        homeTeam:
          lotoMatch.home_team_name,
        awayTeam:
          lotoMatch.away_team_name,
        status:
          "MATCHED",
        fixtureId:
          Number(
            fixture?.fixture?.id
          ),
        fixtureDate:
          fixture?.fixture?.date ||
          null,
        leagueId:
          fixture?.league?.id ||
          null,
        leagueName:
          fixture?.league?.name ||
          null,
        confidence:
          best.score,
        apiHomeTeam:
          fixture?.teams?.home?.name ||
          null,
        apiAwayTeam:
          fixture?.teams?.away?.name ||
          null,
      });
    }

    const matched =
      results.filter(
        (item) =>
          item.status ===
            "MATCHED" ||
          item.status ===
            "ALREADY_MATCHED"
      ).length;

    const ambiguous =
      results.filter(
        (item) =>
          item.status ===
          "AMBIGUOUS"
      ).length;

    const unmatched =
      results.filter(
        (item) =>
          item.status ===
          "UNMATCHED"
      ).length;

    return {
      ok: true,
      version:
        LOTOFOOT_VERSION,
      gridId:
        Number(grid.id),
      gridType:
        grid.grid_type,
      officialGridNumber:
        grid.official_grid_number,
      candidates:
        candidates.length,
      total:
        results.length,
      matched,
      ambiguous,
      unmatched,
      results,
      generatedAt:
        new Date().toISOString(),
    };
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
      "/internal/lotofoot/grid/:gridId/match-fixtures",
      protectAdmin(
        async (req, res) => {
          try {
            const result =
              await matchGridFixtures(
                req.params.gridId,
                {
                  minimumScore:
                    Number(
                      req.body
                        ?.minimumScore
                    ) || 72,
                  force:
                    req.body
                      ?.force === true,
                }
              );

            return res.json(
              result
            );
          } catch (error) {
            console.error(
              "LOTOFOOT FIXTURE MATCHER ERROR :",
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
                  "Impossible de matcher les rencontres Loto Foot.",
              });
          }
        }
      )
    );

    app.post(
      "/internal/lotofoot/import-grid",
      protectAdmin(
        async (req, res) => {
          try {
            const result =
              await importManualGrid(
                req.body || {}
              );

            return res
              .status(201)
              .json(result);
          } catch (error) {
            console.error(
              "LOTOFOOT IMPORT GRID ERROR :",
              error
            );

            const message =
              error?.message ||
              "Impossible d'importer la grille Loto Foot.";

            const isDuplicate =
              /existe déjà/i.test(
                message
              );

            return res
              .status(
                isDuplicate
                  ? 409
                  : 400
              )
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  message,
              });
          }
        }
      )
    );

    app.get(
      "/internal/lotofoot/grids",
      protectAdmin(
        async (req, res) => {
          try {
            const grids =
              await listGrids({
                limit:
                  req.query?.limit,
              });

            return res.json({
              ok: true,
              version:
                LOTOFOOT_VERSION,
              count:
                grids.length,
              grids,
              generatedAt:
                new Date().toISOString(),
            });
          } catch (error) {
            return res
              .status(500)
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  error?.message ||
                  "Impossible de lister les grilles.",
              });
          }
        }
      )
    );

    app.get(
      "/internal/lotofoot/grid/:gridId",
      protectAdmin(
        async (req, res) => {
          try {
            const grid =
              await getGrid(
                req.params.gridId
              );

            if (!grid) {
              return res
                .status(404)
                .json({
                  ok: false,
                  version:
                    LOTOFOOT_VERSION,
                  error:
                    "Grille Loto Foot introuvable.",
                });
            }

            return res.json({
              ok: true,
              version:
                LOTOFOOT_VERSION,
              grid,
              generatedAt:
                new Date().toISOString(),
            });
          } catch (error) {
            return res
              .status(500)
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  error?.message ||
                  "Impossible de charger la grille.",
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
    importManualGrid,
    listGrids,
    getGrid,
    matchGridFixtures,
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
