"use strict";

const {
  ENGINE_LEARNING_VERSION,
  LEARNING_MODE,
  SUPPORTED_ENGINES,
  ENGINE_ROLES,
  ENGINE_ROLE_BY_NAME,
} = require("./LearningConfig");

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min = 0, max = 100) {
  const parsed = numberOrNull(value);
  if (parsed === null) return null;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeMarketKey(value) {
  const token = normalizeToken(value);

  if (["HOME", "HOME_WIN", "1"].includes(token)) return "HOME";
  if (["DRAW", "MATCH_NUL", "NUL", "X", "N"].includes(token)) return "DRAW";
  if (["AWAY", "AWAY_WIN", "2"].includes(token)) return "AWAY";
  if (["BTTS", "BTTS_YES", "GG"].includes(token)) return "BTTS";
  if (["NO_BTTS", "BTTS_NO", "NG"].includes(token)) return "NO_BTTS";
  if (["OVER25", "OVER_25", "OVER_2_5"].includes(token)) return "OVER25";
  if (["UNDER25", "UNDER_25", "UNDER_2_5"].includes(token)) return "UNDER25";

  return token || null;
}

function normalizeSide(value) {
  const token = normalizeMarketKey(value);

  if (["HOME", "DRAW", "AWAY", "BTTS", "NO_BTTS", "OVER25", "UNDER25"].includes(token)) {
    return token;
  }

  if (["NEUTRAL", "NONE", "UNKNOWN", "NO_BET"].includes(normalizeToken(value))) {
    return "NEUTRAL";
  }

  return null;
}


function firstDefined(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") {
      return value;
    }
  }
  return null;
}

function engineObject(root = {}, ...names) {
  for (const name of names) {
    const value = root?.[name];
    if (value && typeof value === "object") return value;
  }
  return {};
}

function explicitSideFromOutput(raw = {}) {
  return normalizeSide(
    firstDefined(
      raw.predictedSide,
      raw.predicted_side,
      raw.side,
      raw.selection,
      raw.pick,
      raw.outcome,
      raw.recommendation,
      raw.marketKey,
      raw.market_key
    )
  );
}

function pairFromAliases(raw = {}, homeKeys = [], awayKeys = [], threshold = 1) {
  const home = firstDefined(...homeKeys.map((key) => raw?.[key]));
  const away = firstDefined(...awayKeys.map((key) => raw?.[key]));
  return sideFromPair(home, away, threshold);
}

function engineVersionOf(engineName, rawOutput = {}, analysisVersion = null) {
  return String(
    rawOutput?.version ||
      rawOutput?.engineVersion ||
      rawOutput?.modelVersion ||
      analysisVersion ||
      ENGINE_LEARNING_VERSION
  ).slice(0, 100);
}

function sideFromPair(homeValue, awayValue, threshold = 1) {
  const home = numberOrNull(homeValue);
  const away = numberOrNull(awayValue);

  if (home === null || away === null) return "NEUTRAL";
  if (home > away + threshold) return "HOME";
  if (away > home + threshold) return "AWAY";
  return "NEUTRAL";
}

function probabilityForSide(probabilityEngine = {}, side) {
  if (side === "HOME") return clamp(probabilityEngine.homeProb);
  if (side === "DRAW") return clamp(probabilityEngine.drawProb);
  if (side === "AWAY") return clamp(probabilityEngine.awayProb);
  if (side === "BTTS") return clamp(probabilityEngine.btts);
  if (side === "NO_BTTS") {
    const btts = clamp(probabilityEngine.btts);
    return btts === null ? null : 100 - btts;
  }
  if (side === "OVER25") return clamp(probabilityEngine.over25);
  if (side === "UNDER25") return clamp(probabilityEngine.under25);
  return null;
}

function scoreOf(raw = {}) {
  return clamp(
    raw?.score ??
      raw?.rating ??
      raw?.confidence ??
      raw?.strength ??
      raw?.reliability
  );
}


function fatigueContextSignal(raw = {}) {
  const source =
    raw?.raw && typeof raw.raw === "object"
      ? raw.raw
      : raw;

  const inputs =
    source?.inputs && typeof source.inputs === "object"
      ? source.inputs
      : raw?.inputs && typeof raw.inputs === "object"
        ? raw.inputs
        : {};

  const homePenalty = numberOrNull(
    firstDefined(
      inputs.homePenalty,
      source.homePenalty,
      raw.homePenalty
    )
  );

  const awayPenalty = numberOrNull(
    firstDefined(
      inputs.awayPenalty,
      source.awayPenalty,
      raw.awayPenalty
    )
  );

  const homeRestDays = numberOrNull(
    firstDefined(
      inputs.homeRestDays,
      source.homeRestDays,
      raw.homeRestDays
    )
  );

  const awayRestDays = numberOrNull(
    firstDefined(
      inputs.awayRestDays,
      source.awayRestDays,
      raw.awayRestDays
    )
  );

  if (
    homePenalty === null &&
    awayPenalty === null &&
    homeRestDays === null &&
    awayRestDays === null
  ) {
    return null;
  }

  const penaltyDifference =
    homePenalty !== null && awayPenalty !== null
      ? homePenalty - awayPenalty
      : null;

  const restDifference =
    homeRestDays !== null && awayRestDays !== null
      ? homeRestDays - awayRestDays
      : null;

  let bucket = "UNKNOWN";

  if (penaltyDifference !== null) {
    if (penaltyDifference <= -2) bucket = "HOME_FRESHER";
    else if (penaltyDifference === -1) bucket = "SLIGHT_HOME_FRESHER";
    else if (penaltyDifference === 0) bucket = "BALANCED";
    else if (penaltyDifference === 1) bucket = "SLIGHT_AWAY_FRESHER";
    else if (penaltyDifference >= 2) bucket = "AWAY_FRESHER";
  }

  return {
    type: "FATIGUE_DIFFERENTIAL",
    homePenalty,
    awayPenalty,
    penaltyDifference,
    homeRestDays,
    awayRestDays,
    restDifference,
    bucket,
  };
}

function roleForEngine(engineName) {
  return (
    ENGINE_ROLE_BY_NAME?.[engineName] ||
    ENGINE_ROLES?.DIRECTIONAL ||
    "DIRECTIONAL"
  );
}


function collectEngineCandidates(snapshot = {}) {
  const learningRoot =
    snapshot?.engineLearning &&
    typeof snapshot.engineLearning === "object"
      ? snapshot.engineLearning
      : snapshot;

  /*
   * Les anciens snapshots compact-v1 ne contiennent volontairement pas
   * les sorties moteurs. Ne jamais fabriquer 10 prédictions NEUTRAL à
   * partir de ces snapshots : elles ne sont pas des observations réelles.
   */
  if (
    snapshot?.compact === true &&
    snapshot?.snapshotVersion === "compact-v1" &&
    !snapshot?.engineLearning
  ) {
    return [];
  }

  const brain =
    learningRoot?.brain ||
    learningRoot?.analysis?.brain ||
    learningRoot?.studio?.brain ||
    {};

  const engines = {
    ...(brain?.engines || {}),
    ...(learningRoot?.engines || {}),
    ...(learningRoot?.studio?.engines || {}),
  };

  const decision =
    brain?.decision ||
    learningRoot?.decision ||
    learningRoot?.studio?.decision ||
    {};

  const votes =
    decision?.engineVotes ||
    decision?.consensus?.votes ||
    learningRoot?.engineVotes ||
    learningRoot?.votes ||
    [];

  const voteMap = new Map(
    (Array.isArray(votes) ? votes : [])
      .filter(Boolean)
      .map((vote) => [
        normalizeToken(vote.engine || vote.engineName || vote.name),
        normalizeSide(
          vote.side || vote.predictedSide || vote.selection || vote.pick
        ),
      ])
      .filter(([engine, side]) => engine && side)
  );

  const voteFor = (engineName) =>
    voteMap.get(normalizeToken(engineName)) || null;

  const probability =
    brain?.probability ||
    engines?.probability ||
    engines?.ProbabilityEngine ||
    learningRoot?.ProbabilityEngine ||
    learningRoot?.probability ||
    {};

  const attackDefense =
    brain?.attackDefense ||
    engines?.attackDefense ||
    engines?.AttackDefenseEngine ||
    learningRoot?.attackDefense ||
    learningRoot?.AttackDefenseEngine ||
    {};

  const transition =
    brain?.transition ||
    engines?.transition ||
    engines?.TransitionEngine ||
    learningRoot?.transition ||
    learningRoot?.TransitionEngine ||
    {};

  const mental =
    brain?.mental ||
    engines?.mental ||
    engines?.MentalEngine ||
    learningRoot?.mental ||
    learningRoot?.MentalEngine ||
    {};

  const tactical =
    brain?.tacticalProfile ||
    engines?.tacticalProfile ||
    engines?.TacticalProfileEngine ||
    learningRoot?.tacticalProfile ||
    learningRoot?.TacticalProfileEngine ||
    {};

  const fatigue =
    brain?.fatigue ||
    engines?.fatigue ||
    engines?.FatigueEngine ||
    learningRoot?.fatigue ||
    learningRoot?.FatigueEngine ||
    {};

  const xg =
    brain?.xg ||
    learningRoot?.xg ||
    {};

  const monteCarlo =
    brain?.monteCarloModel ||
    learningRoot?.monteCarloModel ||
    learningRoot?.monte_carlo_model ||
    {};

  const candidates = [];

  const push = (
    engineName,
    side,
    predictedProbability,
    rawOutput,
    engineScore = null,
    options = {}
  ) => {
    const normalizedSide = normalizeSide(side) || "NEUTRAL";
    const role =
      options.role ||
      roleForEngine(engineName);

    candidates.push({
      engineName,
      role,
      side: normalizedSide,
      marketKey: normalizedSide === "NEUTRAL" ? null : normalizedSide,
      predictedProbability: clamp(predictedProbability),
      engineScore: clamp(engineScore ?? scoreOf(rawOutput)),
      confidence: clamp(
        rawOutput?.confidence ??
          rawOutput?.confidenceScore ??
          rawOutput?.reliability
      ),
      contextSignal:
        options.contextSignal || null,
      rawOutput: rawOutput || {},
    });
  };

  const probabilitySide =
    voteFor("ProbabilityEngine") ||
    explicitSideFromOutput(probability) ||
    sideFromPair(
      firstDefined(probability.homeProb, probability.home, probability.homeWin),
      firstDefined(probability.awayProb, probability.away, probability.awayWin),
      1
    );

  push(
    "ProbabilityEngine",
    probabilitySide,
    probabilityForSide(probability, probabilitySide),
    probability,
    Math.max(
      numberOrNull(probability.homeProb) || 0,
      numberOrNull(probability.drawProb) || 0,
      numberOrNull(probability.awayProb) || 0
    )
  );

  push(
    "AttackDefenseEngine",
    voteFor("AttackDefenseEngine") ||
      explicitSideFromOutput(attackDefense) ||
      pairFromAliases(
        attackDefense,
        ["homeAttackVsAwayDefense", "homeScore", "homeStrength", "homeImpact", "homeRating"],
        ["awayAttackVsHomeDefense", "awayScore", "awayStrength", "awayImpact", "awayRating"],
        1
      ),
    null,
    attackDefense,
    Math.max(
      Math.abs(numberOrNull(attackDefense.homeAttackVsAwayDefense) || 0),
      Math.abs(numberOrNull(attackDefense.awayAttackVsHomeDefense) || 0)
    )
  );

  push(
    "TransitionEngine",
    voteFor("TransitionEngine") ||
      explicitSideFromOutput(transition) ||
      pairFromAliases(
        transition,
        ["homeCounterThreat", "homeScore", "homeThreat", "homeImpact", "homeRating"],
        ["awayCounterThreat", "awayScore", "awayThreat", "awayImpact", "awayRating"],
        3
      ),
    null,
    transition,
    Math.max(
      numberOrNull(transition.homeCounterThreat) || 0,
      numberOrNull(transition.awayCounterThreat) || 0
    )
  );

  push(
    "MentalEngine",
    voteFor("MentalEngine") ||
      explicitSideFromOutput(mental) ||
      pairFromAliases(
        mental,
        ["homeMentalStrength", "homeScore", "homeStrength", "homeImpact", "homeRating"],
        ["awayMentalStrength", "awayScore", "awayStrength", "awayImpact", "awayRating"],
        3
      ),
    null,
    mental,
    Math.max(
      numberOrNull(mental.homeMentalStrength) || 0,
      numberOrNull(mental.awayMentalStrength) || 0
    )
  );

  push(
    "TacticalProfileEngine",
    voteFor("TacticalProfileEngine") ||
      explicitSideFromOutput(tactical) ||
      sideFromPair(
        tactical.homeScore ??
          tactical.homeTacticalScore ??
          tactical.homeImpact,
        tactical.awayScore ??
          tactical.awayTacticalScore ??
          tactical.awayImpact,
        1
      ),
    null,
    tactical,
    scoreOf(tactical)
  );

  push(
    "FatigueEngine",
    "NEUTRAL",
    null,
    fatigue,
    scoreOf(fatigue),
    {
      role: ENGINE_ROLES.CONTEXTUAL,
      contextSignal:
        fatigueContextSignal(fatigue),
    }
  );

  push(
    "XGProfile",
    voteFor("XGProfile") ||
      explicitSideFromOutput(xg) ||
      sideFromPair(
        xg.home ?? probability.xgHome,
        xg.away ?? probability.xgAway,
        0.08
      ),
    null,
    xg,
    xg?.confidence?.score
  );

  const mcSide =
    voteFor("MonteCarloEngine") ||
    explicitSideFromOutput(monteCarlo) ||
    sideFromPair(monteCarlo.homeWin, monteCarlo.awayWin, 1);

  push(
    "MonteCarloEngine",
    mcSide,
    mcSide === "HOME"
      ? monteCarlo.homeWin
      : mcSide === "AWAY"
        ? monteCarlo.awayWin
        : mcSide === "DRAW"
          ? monteCarlo.draw
          : null,
    monteCarlo,
    Math.max(
      numberOrNull(monteCarlo.homeWin) || 0,
      numberOrNull(monteCarlo.draw) || 0,
      numberOrNull(monteCarlo.awayWin) || 0
    )
  );

  if (probability.over25 != null || probability.under25 != null) {
    const goalSide =
      Number(probability.over25) >= Number(probability.under25)
        ? "OVER25"
        : "UNDER25";

    push(
      "GoalMarketEngine",
      goalSide,
      probabilityForSide(probability, goalSide),
      {
        over25: probability.over25,
        under25: probability.under25,
        xgTotal: probability.xgTotal,
      },
      Math.max(
        numberOrNull(probability.over25) || 0,
        numberOrNull(probability.under25) || 0
      )
    );
  }

  if (probability.btts != null) {
    const bttsSide =
      Number(probability.btts) >= 50
        ? "BTTS"
        : "NO_BTTS";

    push(
      "BTTSProfile",
      bttsSide,
      probabilityForSide(probability, bttsSide),
      {
        btts: probability.btts,
        xgTotal: probability.xgTotal,
      },
      Math.max(
        Number(probability.btts) || 0,
        100 - (Number(probability.btts) || 0)
      )
    );
  }

  /*
   * Ne pas limiter l'affichage aux dix moteurs historiques.
   * Tout moteur présent dans le snapshot Brain Studio est journalisé.
   */
  const alreadyCollected =
    new Set(
      candidates.map(
        (candidate) =>
          candidate.engineName
      )
    );

  for (
    const [
      rawEngineName,
      rawOutput,
    ] of Object.entries(engines)
  ) {
    if (
      !rawEngineName ||
      !rawOutput ||
      typeof rawOutput !== "object" ||
      alreadyCollected.has(
        rawEngineName
      )
    ) {
      continue;
    }

    const explicitSide =
      voteFor(rawEngineName) ||
      rawOutput.predictedSide ||
      rawOutput.side ||
      rawOutput.selection ||
      rawOutput.pick ||
      rawOutput.outcome ||
      "NEUTRAL";

    const probabilityValue =
      rawOutput.predictedProbability ??
      rawOutput.probability ??
      rawOutput.calibratedProbability ??
      rawOutput.confidence ??
      null;

    push(
      rawEngineName,
      explicitSide,
      probabilityValue,
      rawOutput,
      scoreOf(rawOutput)
    );
  }

  return candidates.filter((candidate) => {
    const raw = candidate.rawOutput;
    const hasRawOutput =
      raw && typeof raw === "object" && Object.keys(raw).length > 0;
    const hasUsableSide = candidate.side !== "NEUTRAL";
    const hasProbability = candidate.predictedProbability !== null;
    const hasScore = candidate.engineScore !== null && candidate.engineScore !== 0;

    return hasRawOutput || hasUsableSide || hasProbability || hasScore;
  });
}

function createEnginePredictionLog({ pool }) {
  if (!pool) {
    throw new Error("EnginePredictionLog: pool obligatoire.");
  }

  async function ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS engine_prediction_logs (
        id BIGSERIAL PRIMARY KEY,
        fixture_id BIGINT NOT NULL,
        engine_name TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        learning_mode TEXT NOT NULL DEFAULT 'SHADOW',
        engine_role TEXT NOT NULL DEFAULT 'DIRECTIONAL',
        context_signal JSONB,

        analysis_version TEXT,
        market_key TEXT,
        predicted_side TEXT NOT NULL,
        predicted_probability NUMERIC(8, 4),
        engine_score NUMERIC(8, 4),
        confidence NUMERIC(8, 4),

        primary_market_key TEXT,
        primary_market_probability NUMERIC(8, 4),
        decision_type TEXT,
        decision_grade TEXT,

        raw_output JSONB NOT NULL DEFAULT '{}'::jsonb,
        logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (
          fixture_id,
          engine_name,
          engine_version,
          analysis_version
        )
      );
    `);

    await pool.query(`
      ALTER TABLE engine_prediction_logs
      ADD COLUMN IF NOT EXISTS engine_role TEXT
        NOT NULL DEFAULT 'DIRECTIONAL';
    `);

    await pool.query(`
      ALTER TABLE engine_prediction_logs
      ADD COLUMN IF NOT EXISTS context_signal JSONB;
    `);

    await pool.query(`
      UPDATE engine_prediction_logs
      SET
        engine_role = 'CONTEXTUAL',
        context_signal = jsonb_build_object(
          'type', 'FATIGUE_DIFFERENTIAL',
          'homePenalty',
            CASE
              WHEN raw_output->'inputs'->>'homePenalty' ~ '^-?[0-9]+(\\.[0-9]+)?$'
              THEN (raw_output->'inputs'->>'homePenalty')::numeric
              ELSE NULL
            END,
          'awayPenalty',
            CASE
              WHEN raw_output->'inputs'->>'awayPenalty' ~ '^-?[0-9]+(\\.[0-9]+)?$'
              THEN (raw_output->'inputs'->>'awayPenalty')::numeric
              ELSE NULL
            END,
          'penaltyDifference',
            CASE
              WHEN raw_output->'inputs'->>'homePenalty' ~ '^-?[0-9]+(\\.[0-9]+)?$'
               AND raw_output->'inputs'->>'awayPenalty' ~ '^-?[0-9]+(\\.[0-9]+)?$'
              THEN
                (raw_output->'inputs'->>'homePenalty')::numeric -
                (raw_output->'inputs'->>'awayPenalty')::numeric
              ELSE NULL
            END,
          'homeRestDays',
            CASE
              WHEN raw_output->'inputs'->>'homeRestDays' ~ '^-?[0-9]+(\\.[0-9]+)?$'
              THEN (raw_output->'inputs'->>'homeRestDays')::numeric
              ELSE NULL
            END,
          'awayRestDays',
            CASE
              WHEN raw_output->'inputs'->>'awayRestDays' ~ '^-?[0-9]+(\\.[0-9]+)?$'
              THEN (raw_output->'inputs'->>'awayRestDays')::numeric
              ELSE NULL
            END
        )
      WHERE engine_name = 'FatigueEngine';
    `);

    /*
     * V1.5 : classification persistante de tous les moteurs.
     * Les anciens logs sont reclassés sans toucher à leurs prédictions.
     */
    await pool.query(`
      UPDATE engine_prediction_logs
      SET engine_role =
        CASE engine_name
          WHEN 'ProbabilityEngine'
            THEN 'PROBABILISTIC'
          WHEN 'MonteCarloEngine'
            THEN 'PROBABILISTIC'

          WHEN 'GoalMarketEngine'
            THEN 'MARKET'
          WHEN 'BTTSProfile'
            THEN 'MARKET'

          WHEN 'FatigueEngine'
            THEN 'CONTEXTUAL'

          ELSE 'DIRECTIONAL'
        END
      WHERE engine_name IS NOT NULL;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_engine_prediction_logs_fixture
      ON engine_prediction_logs(fixture_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_engine_prediction_logs_engine
      ON engine_prediction_logs(engine_name, logged_at DESC);
    `);
  }

  async function logFromStudioSnapshot({
    fixtureId,
    snapshot = {},
    analysisVersion = null,
    primaryMarket = null,
  } = {}) {
    const normalizedFixtureId = Number(fixtureId);

    if (
      !Number.isInteger(normalizedFixtureId) ||
      normalizedFixtureId <= 0
    ) {
      return {
        ok: false,
        skipped: true,
        reason: "INVALID_FIXTURE_ID",
        inserted: 0,
      };
    }

    const candidates = collectEngineCandidates(snapshot);

    if (candidates.length === 0) {
      return {
        ok: true,
        skipped: true,
        reason: "NO_ENGINE_OUTPUTS",
        inserted: 0,
      };
    }

    const normalizedAnalysisVersion = String(
      analysisVersion ||
        snapshot?.analysisVersion ||
        snapshot?.version ||
        ENGINE_LEARNING_VERSION
    ).slice(0, 100);

    const selectedPrimary =
      primaryMarket ||
      snapshot?.primaryMarket ||
      snapshot?.bestDecision ||
      snapshot?.studio?.bestDecision ||
      {};

    let inserted = 0;

    for (const candidate of candidates) {
      const engineVersion = engineVersionOf(
        candidate.engineName,
        candidate.rawOutput,
        normalizedAnalysisVersion
      );

      await pool.query(
        `
          INSERT INTO engine_prediction_logs (
            fixture_id,
            engine_name,
            engine_version,
            learning_mode,
            engine_role,
            context_signal,
            analysis_version,
            market_key,
            predicted_side,
            predicted_probability,
            engine_score,
            confidence,
            primary_market_key,
            primary_market_probability,
            decision_type,
            decision_grade,
            raw_output,
            logged_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5,
            $6::jsonb, $7, $8, $9,
            $10, $11, $12, $13,
            $14, $15, $16,
            $17::jsonb,
            NOW(), NOW()
          )
          ON CONFLICT (
            fixture_id,
            engine_name,
            engine_version,
            analysis_version
          )
          DO UPDATE SET
            learning_mode = EXCLUDED.learning_mode,
            engine_role = EXCLUDED.engine_role,
            context_signal = EXCLUDED.context_signal,
            market_key = EXCLUDED.market_key,
            predicted_side = EXCLUDED.predicted_side,
            predicted_probability = EXCLUDED.predicted_probability,
            engine_score = EXCLUDED.engine_score,
            confidence = EXCLUDED.confidence,
            primary_market_key = EXCLUDED.primary_market_key,
            primary_market_probability = EXCLUDED.primary_market_probability,
            decision_type = EXCLUDED.decision_type,
            decision_grade = EXCLUDED.decision_grade,
            raw_output = EXCLUDED.raw_output,
            updated_at = NOW()
        `,
        [
          normalizedFixtureId,
          candidate.engineName,
          engineVersion,
          LEARNING_MODE,
          candidate.role || roleForEngine(candidate.engineName),
          candidate.contextSignal
            ? JSON.stringify(candidate.contextSignal)
            : null,
          normalizedAnalysisVersion,
          candidate.marketKey,
          candidate.side,
          candidate.predictedProbability,
          candidate.engineScore,
          candidate.confidence,
          normalizeMarketKey(selectedPrimary?.key),
          clamp(
            selectedPrimary?.fairOdds?.calibratedProbability ??
              selectedPrimary?.probability
          ),
          normalizeToken(
            selectedPrimary?.decision?.type ||
              snapshot?.decisionType
          ) || null,
          normalizeToken(
            selectedPrimary?.decision?.grade ||
              snapshot?.decisionGrade
          ) || null,
          JSON.stringify(candidate.rawOutput || {}),
        ]
      );

      inserted += 1;
    }

    return {
      ok: true,
      fixtureId: normalizedFixtureId,
      inserted,
      analysisVersion: normalizedAnalysisVersion,
    };
  }

  return {
    ensureTables,
    logFromStudioSnapshot,
    collectEngineCandidates,
  };
}

module.exports = {
  createEnginePredictionLog,
  collectEngineCandidates,
  normalizeMarketKey,
  normalizeSide,
};
