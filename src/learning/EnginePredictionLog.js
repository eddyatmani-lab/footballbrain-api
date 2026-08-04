"use strict";

const {
  ENGINE_LEARNING_VERSION,
  LEARNING_MODE,
  SUPPORTED_ENGINES,
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

function collectEngineCandidates(snapshot = {}) {
  const brain =
    snapshot?.brain ||
    snapshot?.analysis?.brain ||
    snapshot?.studio?.brain ||
    {};

  const engines = {
    ...(brain?.engines || {}),
    ...(snapshot?.engines || {}),
    ...(snapshot?.studio?.engines || {}),
  };

  const decision =
    brain?.decision ||
    snapshot?.decision ||
    snapshot?.studio?.decision ||
    {};

  const votes =
    decision?.engineVotes ||
    decision?.consensus?.votes ||
    snapshot?.engineVotes ||
    [];

  const voteMap = new Map(
    (Array.isArray(votes) ? votes : [])
      .filter(Boolean)
      .map((vote) => [
        String(vote.engine || vote.engineName || ""),
        normalizeSide(vote.side),
      ])
  );

  const probability =
    brain?.probability ||
    engines?.probability ||
    snapshot?.probability ||
    {};

  const attackDefense =
    brain?.attackDefense ||
    engines?.attackDefense ||
    {};

  const transition =
    brain?.transition ||
    engines?.transition ||
    {};

  const mental =
    brain?.mental ||
    engines?.mental ||
    {};

  const tactical =
    brain?.tacticalProfile ||
    engines?.tacticalProfile ||
    {};

  const fatigue =
    brain?.fatigue ||
    engines?.fatigue ||
    {};

  const xg =
    brain?.xg ||
    snapshot?.xg ||
    {};

  const monteCarlo =
    brain?.monteCarloModel ||
    snapshot?.monteCarloModel ||
    snapshot?.monte_carlo_model ||
    {};

  const candidates = [];

  const push = (engineName, side, predictedProbability, rawOutput, engineScore = null) => {
    const normalizedSide = normalizeSide(side) || "NEUTRAL";

    candidates.push({
      engineName,
      side: normalizedSide,
      marketKey: normalizedSide === "NEUTRAL" ? null : normalizedSide,
      predictedProbability: clamp(predictedProbability),
      engineScore: clamp(engineScore ?? scoreOf(rawOutput)),
      confidence: clamp(
        rawOutput?.confidence ??
          rawOutput?.confidenceScore ??
          rawOutput?.reliability
      ),
      rawOutput: rawOutput || {},
    });
  };

  const probabilitySide =
    voteMap.get("ProbabilityEngine") ||
    sideFromPair(probability.homeProb, probability.awayProb, 1);

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
    voteMap.get("AttackDefenseEngine") ||
      sideFromPair(
        attackDefense.homeAttackVsAwayDefense,
        attackDefense.awayAttackVsHomeDefense,
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
    voteMap.get("TransitionEngine") ||
      sideFromPair(
        transition.homeCounterThreat,
        transition.awayCounterThreat,
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
    voteMap.get("MentalEngine") ||
      sideFromPair(
        mental.homeMentalStrength,
        mental.awayMentalStrength,
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
    voteMap.get("TacticalProfileEngine") ||
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
    voteMap.get("FatigueEngine") ||
      sideFromPair(
        fatigue.awayFatigueImpact,
        fatigue.homeFatigueImpact,
        1
      ),
    null,
    fatigue,
    scoreOf(fatigue)
  );

  push(
    "XGProfile",
    voteMap.get("XGProfile") ||
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
    voteMap.get("MonteCarloEngine") ||
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

  return candidates.filter(
    (candidate) =>
      SUPPORTED_ENGINES.includes(candidate.engineName)
  );
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
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15::jsonb,
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
