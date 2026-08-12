"use strict";

/*
 * ============================================================
 * FOOTBALL AI PRO — GOALSCORER ENGINE V1
 * ============================================================
 *
 * Objectifs :
 * - analyser les joueurs AVANT les compositions officielles ;
 * - supporter BUTEUR et BUTEUR_OU_REMPLACANT ;
 * - calculer une probabilité individuelle et une fair odd ;
 * - utiliser API-Football sans hardcoder un bet-id "buteur" ;
 * - stocker les prédictions avant coup d'envoi ;
 * - régler les résultats après match ;
 * - construire un Learning dédié calibration/Brier/ROI.
 *
 * IMPORTANT :
 * "Buteur ou remplaçant" dépend des règles du bookmaker.
 * Le modèle estime l'avantage de couverture avant compo, mais le
 * settlement passe en REVIEW si la chaîne de remplacement ne peut
 * pas être démontrée dans les events API-Football.
 */

const GOALSCORER_VERSION =
  "goalscorer-engine-v1.0.0";

const MARKET_TYPES = Object.freeze({
  ANYTIME: "ANYTIME_GOALSCORER",
  REPLACEMENT:
    "SCORER_OR_REPLACEMENT",
});

const FINISHED_STATUSES =
  new Set(["FT", "AET", "PEN"]);

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n)
    ? n
    : null;
}

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n)
    ? n
    : fallback;
}

function clamp(value, min, max) {
  return Math.min(
    max,
    Math.max(min, numberOr(value))
  );
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return (
    Math.round(
      (Number(value) +
        Number.EPSILON) *
        factor
    ) / factor
  );
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function safeJson(value) {
  try {
    return JSON.stringify(
      value ?? {}
    );
  } catch {
    return "{}";
  }
}

function probabilityFromLambda(lambda) {
  const safeLambda =
    clamp(lambda, 0, 3);

  return clamp(
    (1 - Math.exp(-safeLambda)) *
      100,
    0.5,
    85
  );
}

function impliedProbability(odd) {
  const n = numberOrNull(odd);

  if (!n || n <= 1) {
    return null;
  }

  return 100 / n;
}

function fairOdd(probability) {
  const p =
    numberOr(probability) / 100;

  if (p <= 0) return null;

  return round(1 / p, 2);
}

function probabilityBucket(probability) {
  const p = numberOr(probability);

  if (p < 10) return "00_10";
  if (p < 20) return "10_20";
  if (p < 30) return "20_30";
  if (p < 40) return "30_40";
  if (p < 50) return "40_50";
  return "50_PLUS";
}

function positionGroup(position) {
  const normalized =
    normalizeToken(position);

  if (
    normalized.includes("ATT") ||
    normalized.includes("FORWARD")
  ) {
    return "ATTACKER";
  }

  if (
    normalized.includes("MID")
  ) {
    return "MIDFIELDER";
  }

  if (
    normalized.includes("DEF")
  ) {
    return "DEFENDER";
  }

  if (
    normalized.includes("GOAL")
  ) {
    return "GOALKEEPER";
  }

  return "UNKNOWN";
}

function scorerStatus({
  probability,
  dataQuality,
}) {
  const p = numberOr(probability);
  const quality =
    numberOr(dataQuality);

  if (quality < 45) {
    return "REJECTED";
  }

  if (p >= 40 && quality >= 70) {
    return "GOALSCORER_PLUS";
  }

  if (p >= 30 && quality >= 60) {
    return "GOALSCORER";
  }

  if (p >= 20) {
    return "WATCH";
  }

  return "REJECTED";
}

function extractStatBlock(
  playerResponse,
  leagueId,
  teamId
) {
  const statistics =
    Array.isArray(
      playerResponse?.statistics
    )
      ? playerResponse.statistics
      : [];

  return (
    statistics.find(
      (stat) =>
        Number(stat?.league?.id) ===
          Number(leagueId) &&
        Number(stat?.team?.id) ===
          Number(teamId)
    ) ||
    statistics.find(
      (stat) =>
        Number(stat?.team?.id) ===
        Number(teamId)
    ) ||
    statistics[0] ||
    null
  );
}

function buildPlayerFeatures({
  playerResponse,
  stat,
  teamExpectedGoals,
  teamAverageGoals,
  injured,
  lineupState,
  marketType,
  replacementPoolProbability,
}) {
  const player =
    playerResponse?.player || {};

  const games =
    stat?.games || {};

  const goals =
    stat?.goals || {};

  const shots =
    stat?.shots || {};

  const penalty =
    stat?.penalty || {};

  const substitutes =
    stat?.substitutes || {};

  const appearances =
    Math.max(
      0,
      numberOr(
        games.appearences ??
          games.appearances
      )
    );

  const starts =
    Math.max(
      0,
      numberOr(games.lineups)
    );

  const minutes =
    Math.max(
      0,
      numberOr(games.minutes)
    );

  const goalsTotal =
    Math.max(
      0,
      numberOr(goals.total)
    );

  const shotsTotal =
    Math.max(
      0,
      numberOr(shots.total)
    );

  const shotsOn =
    Math.max(
      0,
      numberOr(shots.on)
    );

  const penaltyGoals =
    Math.max(
      0,
      numberOr(penalty.scored)
    );

  const subIn =
    Math.max(
      0,
      numberOr(substitutes.in)
    );

  const goalsPer90 =
    minutes > 0
      ? (goalsTotal * 90) / minutes
      : 0;

  const shotsPer90 =
    minutes > 0
      ? (shotsTotal * 90) / minutes
      : 0;

  const shotsOnPer90 =
    minutes > 0
      ? (shotsOn * 90) / minutes
      : 0;

  const starterRate =
    appearances > 0
      ? clamp(
          starts / appearances,
          0,
          1
        )
      : 0;

  const avgMinutes =
    appearances > 0
      ? minutes / appearances
      : 0;

  let starterProbability =
    clamp(
      starterRate * 0.65 +
        clamp(
          avgMinutes / 90,
          0,
          1
        ) *
          0.35,
      0.08,
      0.98
    );

  if (
    lineupState === "STARTER"
  ) {
    starterProbability = 1;
  } else if (
    lineupState === "SUBSTITUTE"
  ) {
    starterProbability = 0.02;
  }

  if (injured) {
    starterProbability *= 0.25;
  }

  let expectedMinutes;

  if (
    lineupState === "STARTER"
  ) {
    expectedMinutes =
      clamp(avgMinutes || 78, 55, 90);
  } else if (
    lineupState === "SUBSTITUTE"
  ) {
    expectedMinutes =
      clamp(
        avgMinutes > 0
          ? Math.min(avgMinutes, 35)
          : 25,
        10,
        40
      );
  } else {
    expectedMinutes =
      clamp(
        starterProbability *
          clamp(
            avgMinutes || 75,
            55,
            88
          ) +
          (1 -
            starterProbability) *
            22,
        15,
        88
      );
  }

  const teamGoalScaling =
    clamp(
      numberOr(
        teamExpectedGoals,
        1.35
      ) /
        Math.max(
          0.55,
          numberOr(
            teamAverageGoals,
            1.35
          )
        ),
      0.65,
      1.65
    );

  const shotSignal =
    clamp(
      0.85 +
        shotsOnPer90 * 0.035 +
        shotsPer90 * 0.012,
      0.85,
      1.22
    );

  const penaltySignal =
    penaltyGoals > 0
      ? clamp(
          1 +
            Math.min(
              0.12,
              penaltyGoals * 0.025
            ),
          1,
          1.12
        )
      : 1;

  const injurySignal =
    injured ? 0.35 : 1;

  const rawLambda =
    Math.max(
      0.015,
      goalsPer90 *
        (expectedMinutes / 90) *
        teamGoalScaling *
        shotSignal *
        penaltySignal *
        injurySignal
    );

  const anytimeProbability =
    probabilityFromLambda(
      rawLambda
    );

  /*
   * Garantie remplaçant :
   * on ne prétend pas connaître le futur remplaçant avant compo.
   * On ajoute uniquement la couverture liée à la probabilité
   * que le joueur ne porte pas toute l'exposition du poste.
   */
  const nonStarterExposure =
    clamp(
      1 - starterProbability,
      0,
      1
    );

  const replacementProbability =
    clamp(
      numberOr(
        replacementPoolProbability,
        10
      ),
      2,
      30
    );

  const guaranteeBoost =
    marketType ===
    MARKET_TYPES.REPLACEMENT
      ? nonStarterExposure *
        replacementProbability
      : 0;

  const finalProbability =
    marketType ===
    MARKET_TYPES.REPLACEMENT
      ? clamp(
          100 -
            ((100 -
              anytimeProbability) *
              (100 -
                guaranteeBoost)) /
              100,
          anytimeProbability,
          85
        )
      : anytimeProbability;

  const dataPoints = [
    appearances >= 3,
    minutes >= 180,
    goalsTotal !== null,
    shotsTotal > 0,
    numberOr(
      teamExpectedGoals
    ) > 0,
    numberOr(
      teamAverageGoals
    ) > 0,
    lineupState !== "UNKNOWN",
    !injured,
  ];

  const dataQuality =
    round(
      (
        dataPoints.filter(Boolean)
          .length /
        dataPoints.length
      ) *
        100,
      1
    );

  return {
    playerId:
      Number(player.id),
    playerName:
      player.name ||
      `${player.firstname || ""} ${
        player.lastname || ""
      }`.trim(),
    position:
      games.position ||
      player.position ||
      null,
    positionGroup:
      positionGroup(
        games.position ||
          player.position
      ),

    appearances,
    starts,
    minutes,
    avgMinutes:
      round(avgMinutes, 2),
    goals: goalsTotal,
    goalsPer90:
      round(goalsPer90, 4),
    shots: shotsTotal,
    shotsPer90:
      round(shotsPer90, 4),
    shotsOnTarget: shotsOn,
    shotsOnTargetPer90:
      round(shotsOnPer90, 4),
    penaltyGoals,
    substituteIns: subIn,

    injured:
      Boolean(injured),
    lineupState,
    starterProbability:
      round(
        starterProbability * 100,
        2
      ),
    expectedMinutes:
      round(expectedMinutes, 1),

    teamGoalScaling:
      round(teamGoalScaling, 4),
    rawLambda:
      round(rawLambda, 5),
    anytimeProbability:
      round(anytimeProbability, 2),
    replacementProbabilityEstimate:
      round(
        replacementProbability,
        2
      ),
    guaranteeBoost:
      round(
        guaranteeBoost,
        2
      ),
    probability:
      round(finalProbability, 2),
    fairOdd:
      fairOdd(finalProbability),
    dataQuality,
  };
}

function teamGoalAverage(
  stats,
  side
) {
  const goals =
    stats?.goals?.for?.average || {};

  return numberOr(
    goals?.[side] ??
      goals?.total,
    1.35
  );
}

function opponentConcededAverage(
  stats,
  side
) {
  const conceded =
    stats?.goals?.against
      ?.average || {};

  return numberOr(
    conceded?.[side] ??
      conceded?.total,
    1.35
  );
}

function expectedTeamGoals({
  teamStats,
  opponentStats,
  homeAway,
}) {
  const ownSide =
    homeAway === "HOME"
      ? "home"
      : "away";

  const opponentSide =
    homeAway === "HOME"
      ? "away"
      : "home";

  const own =
    teamGoalAverage(
      teamStats,
      ownSide
    );

  const opponentConceded =
    opponentConcededAverage(
      opponentStats,
      opponentSide
    );

  return clamp(
    own * 0.55 +
      opponentConceded * 0.45,
    0.45,
    3.25
  );
}

function normalizePlayerName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      " "
    )
    .trim();
}

function scanOddsForPlayer({
  oddsResponse,
  playerName,
  marketType,
}) {
  const normalizedPlayer =
    normalizePlayerName(playerName);

  if (!normalizedPlayer) {
    return null;
  }

  const fixtures =
    Array.isArray(oddsResponse)
      ? oddsResponse
      : [];

  const matches = [];

  for (const fixture of fixtures) {
    for (
      const bookmaker of
        fixture?.bookmakers || []
    ) {
      for (
        const bet of
          bookmaker?.bets || []
      ) {
        const betName =
          String(
            bet?.name || ""
          ).toLowerCase();

        const isScorerBet =
          /scor|buteur|goal scorer|goalscorer/.test(
            betName
          );

        if (!isScorerBet) {
          continue;
        }

        const isReplacement =
          /replac|substitut|rempla|coaching/.test(
            betName
          );

        if (
          marketType ===
            MARKET_TYPES.REPLACEMENT &&
          !isReplacement
        ) {
          continue;
        }

        if (
          marketType ===
            MARKET_TYPES.ANYTIME &&
          isReplacement
        ) {
          continue;
        }

        for (
          const value of
            bet?.values || []
        ) {
          const valueName =
            normalizePlayerName(
              value?.value
            );

          if (
            !valueName ||
            !(
              valueName.includes(
                normalizedPlayer
              ) ||
              normalizedPlayer.includes(
                valueName
              )
            )
          ) {
            continue;
          }

          const odd =
            numberOrNull(value?.odd);

          if (!odd || odd <= 1) {
            continue;
          }

          matches.push({
            odd,
            bookmakerId:
              bookmaker?.id ?? null,
            bookmakerName:
              bookmaker?.name ?? null,
            betId:
              bet?.id ?? null,
            betName:
              bet?.name ?? null,
            value:
              value?.value ?? null,
          });
        }
      }
    }
  }

  if (matches.length === 0) {
    return null;
  }

  return [...matches].sort(
    (a, b) => b.odd - a.odd
  )[0];
}

async function fetchPagedPlayers({
  callApiFootball,
  teamId,
  leagueId,
  season,
}) {
  const rows = [];

  let page = 1;
  let totalPages = 1;

  while (
    page <= totalPages &&
    page <= 5
  ) {
    const response =
      await callApiFootball(
        "/players",
        {
          team: teamId,
          league: leagueId,
          season,
          page,
        }
      );

    const payload =
      response?.data || {};

    rows.push(
      ...(
        Array.isArray(
          payload.response
        )
          ? payload.response
          : []
      )
    );

    totalPages =
      Math.max(
        1,
        numberOr(
          payload?.paging?.total,
          1
        )
      );

    page += 1;
  }

  return rows;
}

function createGoalscorerEngine({
  app,
  pool,
  callApiFootball,
  adminGuard,
  schedulersEnabled = true,
}) {
  let tablesReady = false;
  let ensurePromise = null;
  let schedulerTimer = null;
  let schedulerRunning = false;

  const guards =
    typeof adminGuard ===
    "function"
      ? [adminGuard]
      : [];

  async function ensureTables() {
    if (tablesReady) {
      return;
    }

    if (ensurePromise) {
      return ensurePromise;
    }

    ensurePromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS goalscorer_predictions (
          id BIGSERIAL PRIMARY KEY,

          fixture_id BIGINT NOT NULL,
          fixture_date TIMESTAMPTZ,
          league_id BIGINT,
          season INTEGER,

          team_id BIGINT NOT NULL,
          opponent_id BIGINT,
          home_away TEXT,

          player_id BIGINT NOT NULL,
          player_name TEXT NOT NULL,
          position TEXT,
          position_group TEXT,

          market_type TEXT NOT NULL,
          replacement_guarantee BOOLEAN
            NOT NULL DEFAULT FALSE,

          starter_probability NUMERIC(8,4),
          expected_minutes NUMERIC(8,3),

          appearances INTEGER,
          starts INTEGER,
          minutes INTEGER,
          goals INTEGER,
          goals_per90 NUMERIC(10,5),
          shots INTEGER,
          shots_per90 NUMERIC(10,5),
          shots_on_target INTEGER,
          shots_on_target_per90 NUMERIC(10,5),
          penalty_goals INTEGER,

          team_expected_goals NUMERIC(10,5),
          team_average_goals NUMERIC(10,5),
          opponent_conceded_average NUMERIC(10,5),

          anytime_probability NUMERIC(8,4),
          guarantee_boost NUMERIC(8,4),
          predicted_probability NUMERIC(8,4)
            NOT NULL,
          fair_odd NUMERIC(10,4),

          market_odd NUMERIC(10,4),
          odd_source TEXT,
          bookmaker_id BIGINT,
          bookmaker_name TEXT,
          api_bet_id BIGINT,
          api_bet_name TEXT,
          value_edge NUMERIC(10,4),

          data_quality NUMERIC(8,3),
          scorer_status TEXT NOT NULL,

          injured BOOLEAN NOT NULL DEFAULT FALSE,
          lineup_state TEXT NOT NULL DEFAULT 'UNKNOWN',

          model_version TEXT NOT NULL,
          model_inputs JSONB,
          raw_player JSONB,

          result_status TEXT NOT NULL DEFAULT 'PENDING',
          scored BOOLEAN,
          player_goals INTEGER,
          replacement_player_id BIGINT,
          replacement_player_name TEXT,
          replacement_scored BOOLEAN,
          settlement_note TEXT,

          profit_units NUMERIC(10,4),

          analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          settled_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

          UNIQUE (
            fixture_id,
            player_id,
            market_type
          )
        );
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS
          idx_goalscorer_predictions_fixture
        ON goalscorer_predictions (
          fixture_id
        );
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS
          idx_goalscorer_predictions_pending
        ON goalscorer_predictions (
          result_status,
          fixture_date
        );
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS goalscorer_learning_stats (
          id BIGSERIAL PRIMARY KEY,

          market_type TEXT NOT NULL,
          probability_bucket TEXT NOT NULL,
          position_group TEXT NOT NULL,

          sample_size INTEGER NOT NULL DEFAULT 0,
          wins INTEGER NOT NULL DEFAULT 0,
          losses INTEGER NOT NULL DEFAULT 0,

          average_predicted_probability
            NUMERIC(10,5),
          actual_score_rate
            NUMERIC(10,5),
          calibration_gap
            NUMERIC(10,5),
          brier_score
            NUMERIC(10,6),

          bets_with_odds INTEGER NOT NULL DEFAULT 0,
          profit_units NUMERIC(12,5),
          roi_percentage NUMERIC(10,5),

          reliability_level TEXT NOT NULL,
          learning_version TEXT NOT NULL,

          calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

          UNIQUE (
            market_type,
            probability_bucket,
            position_group
          )
        );
      `);

      tablesReady = true;
    })();

    try {
      await ensurePromise;
    } finally {
      ensurePromise = null;
    }
  }

  async function getFixtureContext(
    fixtureId
  ) {
    const dbResult =
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
            official_xg_home,
            official_xg_away,
            result_status,
            home_goals,
            away_goals
          FROM predictions
          WHERE fixture_id = $1
          LIMIT 1
        `,
        [fixtureId]
      );

    const dbRow =
      dbResult.rows[0] || null;

    const fixtureResponse =
      await callApiFootball(
        "/fixtures",
        { id: fixtureId }
      );

    const fixture =
      fixtureResponse?.data
        ?.response?.[0];

    if (!fixture && !dbRow) {
      throw new Error(
        "Fixture introuvable."
      );
    }

    return {
      fixtureId:
        Number(fixtureId),

      fixtureDate:
        fixture?.fixture?.date ||
        dbRow?.fixture_date ||
        null,

      leagueId:
        Number(
          fixture?.league?.id ||
            dbRow?.league_id
        ),

      leagueName:
        fixture?.league?.name ||
        dbRow?.league_name ||
        null,

      season:
        Number(
          fixture?.league?.season
        ),

      homeTeamId:
        Number(
          fixture?.teams?.home?.id ||
            dbRow?.home_team_id
        ),

      homeTeamName:
        fixture?.teams?.home
          ?.name ||
        dbRow?.home_team_name ||
        null,

      awayTeamId:
        Number(
          fixture?.teams?.away?.id ||
            dbRow?.away_team_id
        ),

      awayTeamName:
        fixture?.teams?.away
          ?.name ||
        dbRow?.away_team_name ||
        null,

      status:
        fixture?.fixture?.status
          ?.short ||
        dbRow?.result_status ||
        null,

      homeGoals:
        numberOrNull(
          fixture?.goals?.home ??
            dbRow?.home_goals
        ),

      awayGoals:
        numberOrNull(
          fixture?.goals?.away ??
            dbRow?.away_goals
        ),

      dbRow,
      fixture,
    };
  }

  async function getLineupStateMap(
    fixtureId
  ) {
    try {
      const response =
        await callApiFootball(
          "/fixtures/lineups",
          {
            fixture: fixtureId,
          }
        );

      const lineups =
        response?.data
          ?.response || [];

      const map = new Map();

      for (const team of lineups) {
        for (
          const item of
            team?.startXI || []
        ) {
          const id =
            Number(
              item?.player?.id
            );

          if (id) {
            map.set(
              id,
              "STARTER"
            );
          }
        }

        for (
          const item of
            team?.substitutes || []
        ) {
          const id =
            Number(
              item?.player?.id
            );

          if (id) {
            map.set(
              id,
              "SUBSTITUTE"
            );
          }
        }
      }

      return map;
    } catch {
      return new Map();
    }
  }

  async function getInjurySet({
    leagueId,
    season,
    fixtureId,
  }) {
    try {
      const response =
        await callApiFootball(
          "/injuries",
          {
            league: leagueId,
            season,
            fixture: fixtureId,
          }
        );

      return new Set(
        (
          response?.data
            ?.response || []
        )
          .map(
            (item) =>
              Number(
                item?.player?.id
              )
          )
          .filter(Boolean)
      );
    } catch {
      return new Set();
    }
  }

  async function getTeamStats({
    leagueId,
    season,
    teamId,
  }) {
    const response =
      await callApiFootball(
        "/teams/statistics",
        {
          league: leagueId,
          season,
          team: teamId,
        }
      );

    return (
      response?.data?.response ||
      {}
    );
  }

  async function getPrematchOdds(
    fixtureId
  ) {
    try {
      const response =
        await callApiFootball(
          "/odds",
          {
            fixture: fixtureId,
          }
        );

      return (
        response?.data?.response ||
        []
      );
    } catch {
      return [];
    }
  }

  function replacementPoolProbability(
    features
  ) {
    const candidates =
      features
        .filter(
          (item) =>
            item.positionGroup ===
              "ATTACKER" ||
            item.positionGroup ===
              "MIDFIELDER"
        )
        .filter(
          (item) =>
            item.appearances >= 2
        )
        .sort(
          (a, b) =>
            b.anytimeProbability -
            a.anytimeProbability
        )
        .slice(0, 5);

    if (
      candidates.length === 0
    ) {
      return 9;
    }

    return clamp(
      candidates.reduce(
        (sum, item) =>
          sum +
          item.anytimeProbability,
        0
      ) /
        candidates.length *
        0.45,
      4,
      22
    );
  }

  async function analyzeFixture({
    fixtureId,
    marketTypes = [
      MARKET_TYPES.ANYTIME,
      MARKET_TYPES.REPLACEMENT,
    ],
    persist = true,
  }) {
    await ensureTables();

    const context =
      await getFixtureContext(
        fixtureId
      );

    if (
      !context.leagueId ||
      !context.season ||
      !context.homeTeamId ||
      !context.awayTeamId
    ) {
      throw new Error(
        "Contexte fixture incomplet pour Goalscorer."
      );
    }

    const [
      homePlayers,
      awayPlayers,
      homeStats,
      awayStats,
      injuries,
      lineupMap,
      odds,
    ] = await Promise.all([
      fetchPagedPlayers({
        callApiFootball,
        teamId:
          context.homeTeamId,
        leagueId:
          context.leagueId,
        season:
          context.season,
      }),

      fetchPagedPlayers({
        callApiFootball,
        teamId:
          context.awayTeamId,
        leagueId:
          context.leagueId,
        season:
          context.season,
      }),

      getTeamStats({
        leagueId:
          context.leagueId,
        season:
          context.season,
        teamId:
          context.homeTeamId,
      }),

      getTeamStats({
        leagueId:
          context.leagueId,
        season:
          context.season,
        teamId:
          context.awayTeamId,
      }),

      getInjurySet({
        leagueId:
          context.leagueId,
        season:
          context.season,
        fixtureId:
          context.fixtureId,
      }),

      getLineupStateMap(
        context.fixtureId
      ),

      getPrematchOdds(
        context.fixtureId
      ),
    ]);

    const teamContexts = [
      {
        teamId:
          context.homeTeamId,
        opponentId:
          context.awayTeamId,
        homeAway: "HOME",
        players: homePlayers,
        teamStats: homeStats,
        opponentStats: awayStats,
      },
      {
        teamId:
          context.awayTeamId,
        opponentId:
          context.homeTeamId,
        homeAway: "AWAY",
        players: awayPlayers,
        teamStats: awayStats,
        opponentStats: homeStats,
      },
    ];

    const rows = [];

    for (
      const teamContext of
        teamContexts
    ) {
      const ownSide =
        teamContext.homeAway ===
        "HOME"
          ? "home"
          : "away";

      const opponentSide =
        teamContext.homeAway ===
        "HOME"
          ? "away"
          : "home";

      const teamAverage =
        teamGoalAverage(
          teamContext.teamStats,
          ownSide
        );

      const opponentConceded =
        opponentConcededAverage(
          teamContext.opponentStats,
          opponentSide
        );

      const teamExpected =
        expectedTeamGoals({
          teamStats:
            teamContext.teamStats,
          opponentStats:
            teamContext
              .opponentStats,
          homeAway:
            teamContext.homeAway,
        });

      /*
       * Premier passage : profil buteur classique.
       * Il sert aussi à estimer la profondeur offensive
       * de l'équipe pour la garantie remplaçant.
       */
      const baseFeatures =
        teamContext.players
          .map(
            (playerResponse) => {
              const stat =
                extractStatBlock(
                  playerResponse,
                  context.leagueId,
                  teamContext.teamId
                );

              if (!stat) {
                return null;
              }

              const position =
                stat?.games
                  ?.position ||
                playerResponse?.player
                  ?.position;

              if (
                positionGroup(
                  position
                ) ===
                "GOALKEEPER"
              ) {
                return null;
              }

              const playerId =
                Number(
                  playerResponse
                    ?.player?.id
                );

              return buildPlayerFeatures({
                playerResponse,
                stat,
                teamExpectedGoals:
                  teamExpected,
                teamAverageGoals:
                  teamAverage,
                injured:
                  injuries.has(
                    playerId
                  ),
                lineupState:
                  lineupMap.get(
                    playerId
                  ) ||
                  "UNKNOWN",
                marketType:
                  MARKET_TYPES.ANYTIME,
                replacementPoolProbability:
                  9,
              });
            }
          )
          .filter(Boolean);

      const poolProbability =
        replacementPoolProbability(
          baseFeatures
        );

      for (
        const playerResponse of
          teamContext.players
      ) {
        const stat =
          extractStatBlock(
            playerResponse,
            context.leagueId,
            teamContext.teamId
          );

        if (!stat) continue;

        const playerId =
          Number(
            playerResponse
              ?.player?.id
          );

        const position =
          stat?.games?.position ||
          playerResponse?.player
            ?.position;

        if (
          positionGroup(
            position
          ) ===
          "GOALKEEPER"
        ) {
          continue;
        }

        /*
         * Evite d'afficher tout l'effectif sans signal.
         * Un joueur doit avoir au moins un minimum
         * d'exposition saison.
         */
        const appearances =
          numberOr(
            stat?.games
              ?.appearences ??
            stat?.games
              ?.appearances
          );

        const minutes =
          numberOr(
            stat?.games
              ?.minutes
          );

        if (
          appearances < 2 ||
          minutes < 90
        ) {
          continue;
        }

        for (
          const marketType of
            marketTypes
        ) {
          const features =
            buildPlayerFeatures({
              playerResponse,
              stat,
              teamExpectedGoals:
                teamExpected,
              teamAverageGoals:
                teamAverage,
              injured:
                injuries.has(
                  playerId
                ),
              lineupState:
                lineupMap.get(
                  playerId
                ) ||
                "UNKNOWN",
              marketType,
              replacementPoolProbability:
                poolProbability,
            });

          const bestOdd =
            scanOddsForPlayer({
              oddsResponse: odds,
              playerName:
                features.playerName,
              marketType,
            });

          const marketOdd =
            bestOdd?.odd || null;

          const implied =
            impliedProbability(
              marketOdd
            );

          const valueEdge =
            implied == null
              ? null
              : round(
                  features
                    .probability -
                    implied,
                  2
                );

          const status =
            scorerStatus({
              probability:
                features.probability,
              dataQuality:
                features.dataQuality,
            });

          const row = {
            ...features,
            fixtureId:
              context.fixtureId,
            fixtureDate:
              context.fixtureDate,
            leagueId:
              context.leagueId,
            leagueName:
              context.leagueName,
            season:
              context.season,
            teamId:
              teamContext.teamId,
            opponentId:
              teamContext
                .opponentId,
            homeAway:
              teamContext.homeAway,

            marketType,
            replacementGuarantee:
              marketType ===
              MARKET_TYPES.REPLACEMENT,

            teamExpectedGoals:
              round(
                teamExpected,
                4
              ),
            teamAverageGoals:
              round(
                teamAverage,
                4
              ),
            opponentConcededAverage:
              round(
                opponentConceded,
                4
              ),

            marketOdd,
            oddSource:
              bestOdd
                ? "API_FOOTBALL"
                : null,
            bookmakerId:
              bestOdd?.bookmakerId ||
              null,
            bookmakerName:
              bestOdd
                ?.bookmakerName ||
              null,
            apiBetId:
              bestOdd?.betId ||
              null,
            apiBetName:
              bestOdd?.betName ||
              null,
            valueEdge,

            scorerStatus: status,
          };

          rows.push(row);

          if (persist) {
            await pool.query(
              `
                INSERT INTO goalscorer_predictions (
                  fixture_id,
                  fixture_date,
                  league_id,
                  season,
                  team_id,
                  opponent_id,
                  home_away,

                  player_id,
                  player_name,
                  position,
                  position_group,

                  market_type,
                  replacement_guarantee,

                  starter_probability,
                  expected_minutes,

                  appearances,
                  starts,
                  minutes,
                  goals,
                  goals_per90,
                  shots,
                  shots_per90,
                  shots_on_target,
                  shots_on_target_per90,
                  penalty_goals,

                  team_expected_goals,
                  team_average_goals,
                  opponent_conceded_average,

                  anytime_probability,
                  guarantee_boost,
                  predicted_probability,
                  fair_odd,

                  market_odd,
                  odd_source,
                  bookmaker_id,
                  bookmaker_name,
                  api_bet_id,
                  api_bet_name,
                  value_edge,

                  data_quality,
                  scorer_status,

                  injured,
                  lineup_state,

                  model_version,
                  model_inputs,
                  raw_player,

                  analyzed_at,
                  updated_at
                )
                VALUES (
                  $1, $2, $3, $4,
                  $5, $6, $7,
                  $8, $9, $10, $11,
                  $12, $13,
                  $14, $15,
                  $16, $17, $18,
                  $19, $20, $21,
                  $22, $23, $24,
                  $25,
                  $26, $27, $28,
                  $29, $30, $31, $32,
                  $33, $34, $35,
                  $36, $37, $38, $39,
                  $40, $41,
                  $42, $43,
                  $44, $45::jsonb,
                  $46::jsonb,
                  NOW(), NOW()
                )
                ON CONFLICT (
                  fixture_id,
                  player_id,
                  market_type
                )
                DO UPDATE SET
                  fixture_date =
                    EXCLUDED.fixture_date,
                  league_id =
                    EXCLUDED.league_id,
                  season =
                    EXCLUDED.season,
                  team_id =
                    EXCLUDED.team_id,
                  opponent_id =
                    EXCLUDED.opponent_id,
                  home_away =
                    EXCLUDED.home_away,

                  player_name =
                    EXCLUDED.player_name,
                  position =
                    EXCLUDED.position,
                  position_group =
                    EXCLUDED.position_group,

                  replacement_guarantee =
                    EXCLUDED.replacement_guarantee,

                  starter_probability =
                    EXCLUDED.starter_probability,
                  expected_minutes =
                    EXCLUDED.expected_minutes,

                  appearances =
                    EXCLUDED.appearances,
                  starts =
                    EXCLUDED.starts,
                  minutes =
                    EXCLUDED.minutes,
                  goals =
                    EXCLUDED.goals,
                  goals_per90 =
                    EXCLUDED.goals_per90,
                  shots =
                    EXCLUDED.shots,
                  shots_per90 =
                    EXCLUDED.shots_per90,
                  shots_on_target =
                    EXCLUDED.shots_on_target,
                  shots_on_target_per90 =
                    EXCLUDED.shots_on_target_per90,
                  penalty_goals =
                    EXCLUDED.penalty_goals,

                  team_expected_goals =
                    EXCLUDED.team_expected_goals,
                  team_average_goals =
                    EXCLUDED.team_average_goals,
                  opponent_conceded_average =
                    EXCLUDED.opponent_conceded_average,

                  anytime_probability =
                    EXCLUDED.anytime_probability,
                  guarantee_boost =
                    EXCLUDED.guarantee_boost,
                  predicted_probability =
                    EXCLUDED.predicted_probability,
                  fair_odd =
                    EXCLUDED.fair_odd,

                  market_odd =
                    COALESCE(
                      EXCLUDED.market_odd,
                      goalscorer_predictions.market_odd
                    ),
                  odd_source =
                    COALESCE(
                      EXCLUDED.odd_source,
                      goalscorer_predictions.odd_source
                    ),
                  bookmaker_id =
                    COALESCE(
                      EXCLUDED.bookmaker_id,
                      goalscorer_predictions.bookmaker_id
                    ),
                  bookmaker_name =
                    COALESCE(
                      EXCLUDED.bookmaker_name,
                      goalscorer_predictions.bookmaker_name
                    ),
                  api_bet_id =
                    COALESCE(
                      EXCLUDED.api_bet_id,
                      goalscorer_predictions.api_bet_id
                    ),
                  api_bet_name =
                    COALESCE(
                      EXCLUDED.api_bet_name,
                      goalscorer_predictions.api_bet_name
                    ),
                  value_edge =
                    CASE
                      WHEN COALESCE(
                        EXCLUDED.market_odd,
                        goalscorer_predictions.market_odd
                      ) > 1
                      THEN
                        EXCLUDED.predicted_probability -
                        (
                          100 /
                          COALESCE(
                            EXCLUDED.market_odd,
                            goalscorer_predictions.market_odd
                          )
                        )
                      ELSE NULL
                    END,

                  data_quality =
                    EXCLUDED.data_quality,
                  scorer_status =
                    EXCLUDED.scorer_status,

                  injured =
                    EXCLUDED.injured,
                  lineup_state =
                    EXCLUDED.lineup_state,

                  model_version =
                    EXCLUDED.model_version,
                  model_inputs =
                    EXCLUDED.model_inputs,
                  raw_player =
                    EXCLUDED.raw_player,

                  analyzed_at = NOW(),
                  updated_at = NOW()

                WHERE
                  goalscorer_predictions.result_status =
                    'PENDING'
              `,
              [
                row.fixtureId,
                row.fixtureDate,
                row.leagueId,
                row.season,
                row.teamId,
                row.opponentId,
                row.homeAway,

                row.playerId,
                row.playerName,
                row.position,
                row.positionGroup,

                row.marketType,
                row.replacementGuarantee,

                row.starterProbability,
                row.expectedMinutes,

                row.appearances,
                row.starts,
                row.minutes,
                row.goals,
                row.goalsPer90,
                row.shots,
                row.shotsPer90,
                row.shotsOnTarget,
                row.shotsOnTargetPer90,
                row.penaltyGoals,

                row.teamExpectedGoals,
                row.teamAverageGoals,
                row.opponentConcededAverage,

                row.anytimeProbability,
                row.guaranteeBoost,
                row.probability,
                row.fairOdd,

                row.marketOdd,
                row.oddSource,
                row.bookmakerId,
                row.bookmakerName,
                row.apiBetId,
                row.apiBetName,
                row.valueEdge,

                row.dataQuality,
                row.scorerStatus,

                row.injured,
                row.lineupState,

                GOALSCORER_VERSION,
                safeJson({
                  replacementPoolProbability:
                    poolProbability,
                  formula:
                    "Poisson goal-rate x minutes x team/opponent adjustment x shots x penalties",
                }),
                safeJson(
                  playerResponse
                ),
              ]
            );
          }
        }
      }
    }

    return {
      ok: true,
      version:
        GOALSCORER_VERSION,
      fixture: context,
      count: rows.length,
      rows: rows.sort(
        (a, b) =>
          b.probability -
          a.probability
      ),
      generatedAt:
        new Date().toISOString(),
    };
  }

  async function getFixturePredictions(
    fixtureId
  ) {
    await ensureTables();

    const result =
      await pool.query(
        `
          SELECT *
          FROM goalscorer_predictions
          WHERE fixture_id = $1
          ORDER BY
            market_type ASC,
            predicted_probability DESC,
            player_name ASC
        `,
        [fixtureId]
      );

    return {
      ok: true,
      version:
        GOALSCORER_VERSION,
      count:
        result.rows.length,
      rows:
        result.rows,
      generatedAt:
        new Date().toISOString(),
    };
  }

  async function settleFixture(
    fixtureId
  ) {
    await ensureTables();

    const context =
      await getFixtureContext(
        fixtureId
      );

    if (
      !FINISHED_STATUSES.has(
        normalizeToken(
          context.status
        )
      ) &&
      !(
        context.homeGoals !== null &&
        context.awayGoals !== null
      )
    ) {
      return {
        ok: true,
        fixtureId,
        skipped: true,
        reason:
          "MATCH_NOT_FINISHED",
      };
    }

    const [
      playersResponse,
      eventsResponse,
    ] = await Promise.all([
      callApiFootball(
        "/fixtures/players",
        {
          fixture: fixtureId,
        }
      ),
      callApiFootball(
        "/fixtures/events",
        {
          fixture: fixtureId,
        }
      ),
    ]);

    const playerGoals =
      new Map();

    for (
      const team of
        playersResponse?.data
          ?.response || []
    ) {
      for (
        const item of
          team?.players || []
      ) {
        const id =
          Number(
            item?.player?.id
          );

        let goals = 0;

        for (
          const stat of
            item?.statistics || []
        ) {
          goals +=
            numberOr(
              stat?.goals?.total
            );
        }

        if (id) {
          playerGoals.set(
            id,
            {
              goals,
              name:
                item?.player
                  ?.name || null,
            }
          );
        }
      }
    }

    const substitutionByOut =
      new Map();

    for (
      const event of
        eventsResponse?.data
          ?.response || []
    ) {
      if (
        normalizeToken(
          event?.type
        ) !== "SUBST"
      ) {
        continue;
      }

      const outId =
        Number(
          event?.player?.id
        );

      const inId =
        Number(
          event?.assist?.id
        );

      if (outId && inId) {
        substitutionByOut.set(
          outId,
          {
            playerId: inId,
            playerName:
              event?.assist
                ?.name || null,
          }
        );
      }
    }

    const pending =
      await pool.query(
        `
          SELECT *
          FROM goalscorer_predictions
          WHERE fixture_id = $1
            AND result_status =
              'PENDING'
        `,
        [fixtureId]
      );

    let settled = 0;
    let review = 0;

    for (
      const row of
        pending.rows
    ) {
      const playerResult =
        playerGoals.get(
          Number(row.player_id)
        );

      const ownGoals =
        numberOr(
          playerResult?.goals
        );

      const scored =
        ownGoals > 0;

      let replacement =
        null;
      let replacementScored =
        false;

      if (
        row.replacement_guarantee
      ) {
        replacement =
          substitutionByOut.get(
            Number(row.player_id)
          ) || null;

        if (replacement) {
          replacementScored =
            numberOr(
              playerGoals.get(
                Number(
                  replacement.playerId
                )
              )?.goals
            ) > 0;
        }
      }

      let resultStatus =
        "SETTLED";

      let settlementNote =
        null;

      if (
        row.replacement_guarantee &&
        !scored &&
        !replacement
      ) {
        /*
         * Le bookmaker peut avoir sa propre règle
         * si le joueur ne commence pas ou n'est jamais
         * remplacé. On refuse d'inventer.
         */
        resultStatus =
          "REVIEW";

        settlementNote =
          "Garantie remplaçant non résolue automatiquement : aucune substitution sortante identifiable pour le joueur.";
      }

      const won =
        scored ||
        replacementScored;

      const odd =
        numberOrNull(
          row.market_odd
        );

      const profit =
        resultStatus ===
          "SETTLED" &&
        odd &&
        odd > 1
          ? won
            ? odd - 1
            : -1
          : null;

      await pool.query(
        `
          UPDATE goalscorer_predictions
          SET
            result_status = $2,
            scored = $3,
            player_goals = $4,
            replacement_player_id = $5,
            replacement_player_name = $6,
            replacement_scored = $7,
            settlement_note = $8,
            profit_units = $9,
            settled_at =
              CASE
                WHEN $2 IN (
                  'SETTLED',
                  'REVIEW'
                )
                THEN NOW()
                ELSE settled_at
              END,
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          row.id,
          resultStatus,
          won,
          ownGoals,
          replacement
            ?.playerId || null,
          replacement
            ?.playerName || null,
          replacementScored,
          settlementNote,
          profit,
        ]
      );

      if (
        resultStatus ===
        "SETTLED"
      ) {
        settled += 1;
      } else {
        review += 1;
      }
    }

    return {
      ok: true,
      fixtureId,
      found:
        pending.rows.length,
      settled,
      review,
      generatedAt:
        new Date().toISOString(),
    };
  }

  async function settleFinished() {
    await ensureTables();

    const result =
      await pool.query(
        `
          SELECT DISTINCT
            g.fixture_id
          FROM goalscorer_predictions g
          JOIN predictions p
            ON p.fixture_id =
              g.fixture_id
          WHERE
            g.result_status =
              'PENDING'
            AND (
              p.result_status =
                'COMPLETED'
              OR (
                p.home_goals IS NOT NULL
                AND
                p.away_goals IS NOT NULL
              )
            )
          ORDER BY
            g.fixture_id ASC
          LIMIT 100
        `
      );

    let settled = 0;
    let review = 0;
    const errors = [];

    for (
      const row of
        result.rows
    ) {
      try {
        const response =
          await settleFixture(
            row.fixture_id
          );

        settled +=
          numberOr(
            response.settled
          );

        review +=
          numberOr(
            response.review
          );
      } catch (error) {
        errors.push({
          fixtureId:
            row.fixture_id,
          error:
            error?.message ||
            String(error),
        });
      }
    }

    return {
      ok:
        errors.length === 0,
      fixtures:
        result.rows.length,
      settled,
      review,
      errors,
      generatedAt:
        new Date().toISOString(),
    };
  }

  async function rebuildLearning() {
    await ensureTables();

    const result =
      await pool.query(
        `
          SELECT
            market_type,
            CASE
              WHEN predicted_probability < 10
                THEN '00_10'
              WHEN predicted_probability < 20
                THEN '10_20'
              WHEN predicted_probability < 30
                THEN '20_30'
              WHEN predicted_probability < 40
                THEN '30_40'
              WHEN predicted_probability < 50
                THEN '40_50'
              ELSE '50_PLUS'
            END AS probability_bucket,

            COALESCE(
              NULLIF(
                position_group,
                ''
              ),
              'UNKNOWN'
            ) AS position_group,

            COUNT(*)::INTEGER
              AS sample_size,

            COUNT(*) FILTER (
              WHERE scored = TRUE
            )::INTEGER
              AS wins,

            COUNT(*) FILTER (
              WHERE scored = FALSE
            )::INTEGER
              AS losses,

            AVG(
              predicted_probability
            )::NUMERIC
              AS average_predicted_probability,

            (
              COUNT(*) FILTER (
                WHERE scored = TRUE
              )::NUMERIC /
              NULLIF(
                COUNT(*),
                0
              )
            ) * 100
              AS actual_score_rate,

            AVG(
              POWER(
                (
                  predicted_probability /
                  100.0
                ) -
                CASE
                  WHEN scored = TRUE
                    THEN 1.0
                  ELSE 0.0
                END,
                2
              )
            )::NUMERIC
              AS brier_score,

            COUNT(*) FILTER (
              WHERE market_odd > 1
                AND profit_units
                  IS NOT NULL
            )::INTEGER
              AS bets_with_odds,

            COALESCE(
              SUM(
                profit_units
              ) FILTER (
                WHERE market_odd > 1
              ),
              0
            )::NUMERIC
              AS profit_units

          FROM goalscorer_predictions
          WHERE result_status =
            'SETTLED'
            AND scored IS NOT NULL

          GROUP BY
            market_type,
            probability_bucket,
            position_group

          ORDER BY
            market_type,
            probability_bucket,
            position_group
        `
      );

    for (
      const row of
        result.rows
    ) {
      const sample =
        numberOr(
          row.sample_size
        );

      const predicted =
        numberOr(
          row
            .average_predicted_probability
        );

      const actual =
        numberOr(
          row.actual_score_rate
        );

      const gap =
        round(
          predicted - actual,
          4
        );

      const bets =
        numberOr(
          row.bets_with_odds
        );

      const profit =
        numberOr(
          row.profit_units
        );

      const roi =
        bets > 0
          ? round(
              (profit / bets) *
                100,
              4
            )
          : null;

      const reliability =
        sample >= 300
          ? "RELIABLE"
          : sample >= 150
            ? "DEVELOPING"
            : sample >= 50
              ? "OBSERVATION"
              : "INSUFFICIENT_DATA";

      await pool.query(
        `
          INSERT INTO goalscorer_learning_stats (
            market_type,
            probability_bucket,
            position_group,

            sample_size,
            wins,
            losses,

            average_predicted_probability,
            actual_score_rate,
            calibration_gap,
            brier_score,

            bets_with_odds,
            profit_units,
            roi_percentage,

            reliability_level,
            learning_version,

            calculated_at,
            updated_at
          )
          VALUES (
            $1, $2, $3,
            $4, $5, $6,
            $7, $8, $9, $10,
            $11, $12, $13,
            $14, $15,
            NOW(), NOW()
          )
          ON CONFLICT (
            market_type,
            probability_bucket,
            position_group
          )
          DO UPDATE SET
            sample_size =
              EXCLUDED.sample_size,
            wins =
              EXCLUDED.wins,
            losses =
              EXCLUDED.losses,
            average_predicted_probability =
              EXCLUDED.average_predicted_probability,
            actual_score_rate =
              EXCLUDED.actual_score_rate,
            calibration_gap =
              EXCLUDED.calibration_gap,
            brier_score =
              EXCLUDED.brier_score,
            bets_with_odds =
              EXCLUDED.bets_with_odds,
            profit_units =
              EXCLUDED.profit_units,
            roi_percentage =
              EXCLUDED.roi_percentage,
            reliability_level =
              EXCLUDED.reliability_level,
            learning_version =
              EXCLUDED.learning_version,
            calculated_at = NOW(),
            updated_at = NOW()
        `,
        [
          row.market_type,
          row.probability_bucket,
          row.position_group,

          sample,
          numberOr(row.wins),
          numberOr(row.losses),

          predicted,
          actual,
          gap,
          numberOrNull(
            row.brier_score
          ),

          bets,
          profit,
          roi,

          reliability,
          GOALSCORER_VERSION,
        ]
      );
    }

    return {
      ok: true,
      groups:
        result.rows.length,
      version:
        GOALSCORER_VERSION,
      generatedAt:
        new Date().toISOString(),
    };
  }

  async function analyzeUpcoming({
    hours = 36,
    limit = 20,
  } = {}) {
    await ensureTables();

    const safeHours =
      clamp(hours, 6, 168);

    const safeLimit =
      Math.floor(
        clamp(limit, 1, 50)
      );

    const result =
      await pool.query(
        `
          SELECT
            p.fixture_id
          FROM predictions p
          WHERE
            p.fixture_date >
              NOW()
            AND
            p.fixture_date <
              NOW() +
              ($1 || ' hours')::interval
            AND p.home_team_id
              IS NOT NULL
            AND p.away_team_id
              IS NOT NULL
            AND (
              NOT EXISTS (
                SELECT 1
                FROM
                  goalscorer_predictions g
                WHERE
                  g.fixture_id =
                    p.fixture_id
              )
              OR EXISTS (
                SELECT 1
                FROM
                  goalscorer_predictions g
                WHERE
                  g.fixture_id =
                    p.fixture_id
                  AND
                  g.result_status =
                    'PENDING'
                  AND
                  g.analyzed_at <
                    NOW() -
                    INTERVAL '6 hours'
              )
            )
          ORDER BY
            p.fixture_date ASC
          LIMIT $2
        `,
        [
          String(safeHours),
          safeLimit,
        ]
      );

    let analyzed = 0;
    const errors = [];

    for (
      const row of
        result.rows
    ) {
      try {
        await analyzeFixture({
          fixtureId:
            Number(
              row.fixture_id
            ),
          persist: true,
        });

        analyzed += 1;
      } catch (error) {
        errors.push({
          fixtureId:
            row.fixture_id,
          error:
            error?.message ||
            String(error),
        });
      }
    }

    return {
      ok:
        errors.length === 0,
      found:
        result.rows.length,
      analyzed,
      errors:
        errors.slice(0, 20),
      generatedAt:
        new Date().toISOString(),
    };
  }

  async function getStatus() {
    await ensureTables();

    const [
      predictions,
      pending,
      settled,
      review,
      learning,
    ] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::INTEGER
          AS count
        FROM goalscorer_predictions
      `),
      pool.query(`
        SELECT COUNT(*)::INTEGER
          AS count
        FROM goalscorer_predictions
        WHERE result_status =
          'PENDING'
      `),
      pool.query(`
        SELECT COUNT(*)::INTEGER
          AS count
        FROM goalscorer_predictions
        WHERE result_status =
          'SETTLED'
      `),
      pool.query(`
        SELECT COUNT(*)::INTEGER
          AS count
        FROM goalscorer_predictions
        WHERE result_status =
          'REVIEW'
      `),
      pool.query(`
        SELECT COUNT(*)::INTEGER
          AS count
        FROM goalscorer_learning_stats
      `),
    ]);

    return {
      ok: true,
      version:
        GOALSCORER_VERSION,
      markets:
        MARKET_TYPES,
      predictions:
        numberOr(
          predictions.rows[0]
            ?.count
        ),
      pending:
        numberOr(
          pending.rows[0]
            ?.count
        ),
      settled:
        numberOr(
          settled.rows[0]
            ?.count
        ),
      review:
        numberOr(
          review.rows[0]
            ?.count
        ),
      learningGroups:
        numberOr(
          learning.rows[0]
            ?.count
        ),
      scheduler:
        Boolean(
          schedulersEnabled
        ),
      generatedAt:
        new Date().toISOString(),
    };
  }

  function registerRoutes() {
    app.get(
      "/internal/goalscorer/status",
      ...guards,
      async (req, res) => {
        try {
          return res.json(
            await getStatus()
          );
        } catch (error) {
          return res
            .status(500)
            .json({
              ok: false,
              error:
                error?.message ||
                String(error),
            });
        }
      }
    );

    app.post(
      "/internal/goalscorer/analyze/:fixtureId",
      ...guards,
      async (req, res) => {
        try {
          const fixtureId =
            Number(
              req.params.fixtureId
            );

          if (
            !Number.isInteger(
              fixtureId
            ) ||
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

          const market =
            normalizeToken(
              req.body?.market
            );

          const marketTypes =
            market ===
            MARKET_TYPES.ANYTIME
              ? [
                  MARKET_TYPES.ANYTIME,
                ]
              : market ===
                  MARKET_TYPES.REPLACEMENT
                ? [
                    MARKET_TYPES.REPLACEMENT,
                  ]
                : [
                    MARKET_TYPES.ANYTIME,
                    MARKET_TYPES.REPLACEMENT,
                  ];

          return res.json(
            await analyzeFixture({
              fixtureId,
              marketTypes,
              persist: true,
            })
          );
        } catch (error) {
          return res
            .status(500)
            .json({
              ok: false,
              error:
                error?.message ||
                String(error),
            });
        }
      }
    );

    app.post(
      "/internal/goalscorer/analyze-upcoming",
      ...guards,
      async (req, res) => {
        try {
          return res.json(
            await analyzeUpcoming({
              hours:
                req.body?.hours ??
                36,
              limit:
                req.body?.limit ??
                20,
            })
          );
        } catch (error) {
          return res
            .status(500)
            .json({
              ok: false,
              error:
                error?.message ||
                String(error),
            });
        }
      }
    );

    app.get(
      "/internal/goalscorer/fixture/:fixtureId",
      ...guards,
      async (req, res) => {
        try {
          return res.json(
            await getFixturePredictions(
              Number(
                req.params
                  .fixtureId
              )
            )
          );
        } catch (error) {
          return res
            .status(500)
            .json({
              ok: false,
              error:
                error?.message ||
                String(error),
            });
        }
      }
    );

    app.patch(
      "/internal/goalscorer/predictions/:id/odd",
      ...guards,
      async (req, res) => {
        try {
          await ensureTables();

          const id =
            Number(
              req.params.id
            );

          const odd =
            numberOrNull(
              req.body?.odd
            );

          if (
            !Number.isInteger(id) ||
            id <= 0 ||
            !odd ||
            odd <= 1
          ) {
            return res
              .status(400)
              .json({
                ok: false,
                error:
                  "id ou cote invalide",
              });
          }

          const result =
            await pool.query(
              `
                UPDATE goalscorer_predictions
                SET
                  market_odd = $2,
                  odd_source = $3,
                  bookmaker_name = $4,
                  value_edge =
                    predicted_probability -
                    (100 / $2),
                  updated_at = NOW()
                WHERE id = $1
                RETURNING *
              `,
              [
                id,
                odd,
                String(
                  req.body?.source ||
                  "MANUAL"
                ),
                req.body
                  ?.bookmakerName ||
                null,
              ]
            );

          if (
            result.rows.length === 0
          ) {
            return res
              .status(404)
              .json({
                ok: false,
                error:
                  "Prédiction buteur introuvable",
              });
          }

          return res.json({
            ok: true,
            prediction:
              result.rows[0],
          });
        } catch (error) {
          return res
            .status(500)
            .json({
              ok: false,
              error:
                error?.message ||
                String(error),
            });
        }
      }
    );

    app.post(
      "/internal/goalscorer/settle",
      ...guards,
      async (req, res) => {
        try {
          return res.json(
            await settleFinished()
          );
        } catch (error) {
          return res
            .status(500)
            .json({
              ok: false,
              error:
                error?.message ||
                String(error),
            });
        }
      }
    );

    app.post(
      "/internal/goalscorer/rebuild-learning",
      ...guards,
      async (req, res) => {
        try {
          return res.json(
            await rebuildLearning()
          );
        } catch (error) {
          return res
            .status(500)
            .json({
              ok: false,
              error:
                error?.message ||
                String(error),
            });
        }
      }
    );

    app.get(
      "/internal/goalscorer/learning",
      ...guards,
      async (req, res) => {
        try {
          await ensureTables();

          const result =
            await pool.query(`
              SELECT *
              FROM goalscorer_learning_stats
              ORDER BY
                market_type,
                probability_bucket,
                position_group
            `);

          return res.json({
            ok: true,
            version:
              GOALSCORER_VERSION,
            count:
              result.rows.length,
            stats:
              result.rows,
            generatedAt:
              new Date()
                .toISOString(),
          });
        } catch (error) {
          return res
            .status(500)
            .json({
              ok: false,
              error:
                error?.message ||
                String(error),
            });
        }
      }
    );

    /*
     * Diagnostic officiel des types de paris réellement
     * proposés par API-Football. Aucun bet-id "buteur"
     * n'est hardcodé.
     */
    app.get(
      "/internal/goalscorer/api-bets",
      ...guards,
      async (req, res) => {
        try {
          const search =
            String(
              req.query.search ||
              "scor"
            )
              .trim()
              .slice(0, 40);

          const response =
            await callApiFootball(
              "/odds/bets",
              {
                search:
                  search.length >= 3
                    ? search
                    : "scor",
              }
            );

          return res.json({
            ok: true,
            search,
            response:
              response?.data
                ?.response || [],
            note:
              "Cette route sert à vérifier la couverture réelle des props buteur de votre compte API-Football avant d'automatiser les cotes.",
          });
        } catch (error) {
          return res
            .status(500)
            .json({
              ok: false,
              error:
                error?.message ||
                String(error),
            });
        }
      }
    );
  }

  async function schedulerTick() {
    if (
      !schedulersEnabled ||
      schedulerRunning
    ) {
      return;
    }

    schedulerRunning = true;

    try {
      await analyzeUpcoming({
        hours: 36,
        limit: 12,
      });

      await settleFinished();

      await rebuildLearning();
    } catch (error) {
      console.error(
        "GOALSCORER SCHEDULER :",
        error?.message ||
          error
      );
    } finally {
      schedulerRunning = false;
    }
  }

  function startScheduler() {
    if (
      !schedulersEnabled ||
      schedulerTimer
    ) {
      return;
    }

    /*
     * Premier passage 3 min après démarrage,
     * puis toutes les 6 heures.
     */
    setTimeout(
      () =>
        schedulerTick(),
      3 * 60 * 1000
    );

    schedulerTimer =
      setInterval(
        schedulerTick,
        6 * 60 * 60 * 1000
      );
  }

  function stopScheduler() {
    if (schedulerTimer) {
      clearInterval(
        schedulerTimer
      );
    }

    schedulerTimer = null;
  }

  return {
    ensureTables,
    registerRoutes,
    startScheduler,
    stopScheduler,
    analyzeFixture,
    analyzeUpcoming,
    settleFinished,
    rebuildLearning,
    getStatus,
    version:
      GOALSCORER_VERSION,
  };
}

module.exports = {
  createGoalscorerEngine,
  GOALSCORER_VERSION,
  MARKET_TYPES,
};
