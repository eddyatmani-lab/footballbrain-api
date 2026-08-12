"use strict";

const {
  ENGINE_LEARNING_VERSION,
  LEARNING_MODE,
  ENGINE_ROLES,
  ENGINE_ROLE_BY_NAME,
  ENGINE_METRIC_FOCUS,
} = require("./LearningConfig");

const RECOMMENDATION_VERSION =
  "engine-weight-recommendations-v1.5-role-aware";

/*
 * Poids de référence uniquement destinés aux recommandations.
 * Aucun de ces poids n'est appliqué automatiquement en V1.
 */
const BASELINE_WEIGHTS = Object.freeze({
  ProbabilityEngine: 25,
  AttackDefenseEngine: 15,
  TransitionEngine: 10,
  MentalEngine: 10,
  TacticalProfileEngine: 10,
  XGProfile: 10,
  MonteCarloEngine: 10,
  FatigueEngine: 5,
  GoalMarketEngine: 3,
  BTTSProfile: 2,
});

function numberOr(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(
    minimum,
    Math.min(maximum, numberOr(value))
  );
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(numberOr(value) * factor) / factor;
}


function roleForEngine(engineName) {
  return (
    ENGINE_ROLE_BY_NAME?.[engineName] ||
    ENGINE_ROLES?.DIRECTIONAL ||
    "DIRECTIONAL"
  );
}

function metricFocusForRole(role) {
  return (
    ENGINE_METRIC_FOCUS?.[role] ||
    "ACCURACY"
  );
}

function roleAllowsGlobalWeight(role) {
  return (
    role === ENGINE_ROLES.DIRECTIONAL ||
    role === ENGINE_ROLES.PROBABILISTIC
  );
}

function samplePolicy(sampleSize) {
  const sample = numberOr(sampleSize);

  if (sample < 20) {
    return {
      stage: "BLOCKED",
      maximumChange: 0,
      confidence: "INSUFFICIENT_DATA",
      applicable: false,
      reason:
        "Moins de 20 résultats : aucune recommandation exploitable.",
    };
  }

  if (sample < 50) {
    return {
      stage: "OBSERVATION",
      maximumChange: 0,
      confidence: "EARLY_SAMPLE",
      applicable: false,
      reason:
        "Entre 20 et 49 résultats : observation uniquement.",
    };
  }

  if (sample < 100) {
    return {
      stage: "LIMITED",
      maximumChange: 1,
      confidence: "LOW",
      applicable: true,
      reason:
        "Entre 50 et 99 résultats : variation limitée à 1 point.",
    };
  }

  if (sample < 250) {
    return {
      stage: "CONTROLLED",
      maximumChange: 2,
      confidence: "MEDIUM",
      applicable: true,
      reason:
        "Entre 100 et 249 résultats : variation limitée à 2 points.",
    };
  }

  return {
    stage: "MATURE",
    maximumChange: 3,
    confidence: "HIGH",
    applicable: true,
    reason:
      "250 résultats ou plus : variation limitée à 3 points.",
  };
}

function qualityScore({
  role,
  accuracy,
  brierScore,
  calibrationGap,
  sampleSize,
}) {
  const normalizedAccuracy =
    clamp(accuracy);

  const brierQuality = clamp(
    100 -
      numberOr(
        brierScore,
        0.25
      ) * 300
  );

  const calibrationQuality =
    clamp(
      100 -
        Math.abs(
          numberOr(
            calibrationGap
          )
        ) * 5
    );

  const sampleQuality =
    clamp(
      (
        numberOr(sampleSize) /
        250
      ) * 100
    );

  /*
   * Un moteur probabiliste doit surtout être récompensé
   * pour sa calibration et son Brier, pas pour un simple
   * taux de réussite directionnel.
   */
  if (
    role ===
    ENGINE_ROLES.PROBABILISTIC
  ) {
    return round(
      brierQuality * 0.4 +
        calibrationQuality * 0.35 +
        normalizedAccuracy * 0.15 +
        sampleQuality * 0.1,
      2
    );
  }

  /*
   * Les moteurs directionnels restent principalement
   * évalués sur leur capacité à choisir le bon côté.
   */
  return round(
    normalizedAccuracy * 0.5 +
      brierQuality * 0.2 +
      calibrationQuality * 0.2 +
      sampleQuality * 0.1,
    2
  );
}

function buildRecommendation({
  engineName,
  sampleSize,
  accuracy,
  averageProbability,
  actualFrequency,
  calibrationGap,
  brierScore,
  logLoss,
}) {
  const role =
    roleForEngine(engineName);

  const metricFocus =
    metricFocusForRole(role);

  const currentWeight =
    BASELINE_WEIGHTS[engineName] ?? 5;

  const basePolicy =
    samplePolicy(sampleSize);

  const roleEligible =
    roleAllowsGlobalWeight(role);

  const policy =
    roleEligible
      ? basePolicy
      : {
          ...basePolicy,
          stage:
            "ROLE_BLOCKED",
          maximumChange: 0,
          applicable: false,
          reason:
            role === ENGINE_ROLES.MARKET
              ? "Moteur de marché : il doit être pondéré dans son marché, pas dans le poids global 1X2."
              : role === ENGINE_ROLES.CONTEXTUAL
                ? "Moteur contextuel : son impact doit être appris comme correction conditionnelle, pas comme poids directionnel."
                : "Rôle moteur non éligible au poids global.",
        };

  const quality = qualityScore({
    role,
    accuracy,
    brierScore,
    calibrationGap,
    sampleSize,
  });

  /*
   * 55/100 est considéré comme neutre.
   * Le déplacement théorique est ensuite limité par la taille d'échantillon.
   */
  const directionalStrength = clamp(
    (quality - 55) / 45,
    -1,
    1
  );

  const proposedChange = policy.applicable
    ? round(
        directionalStrength *
          policy.maximumChange,
        2
      )
    : 0;

  const recommendedWeight = round(
    clamp(
      currentWeight + proposedChange,
      1,
      40
    ),
    2
  );

  let direction = "MAINTAIN";
  if (proposedChange > 0.05) direction = "INCREASE";
  if (proposedChange < -0.05) direction = "DECREASE";

  return {
    engineName,
    role,
    metricFocus,
    eligibleForGlobalWeight:
      roleEligible,
    currentWeight,
    recommendedWeight,
    proposedChange,
    direction,
    qualityScore: quality,
    sampleSize: numberOr(sampleSize),
    accuracy:
      accuracy == null ? null : round(accuracy, 2),
    averageProbability:
      averageProbability == null
        ? null
        : round(averageProbability, 2),
    actualFrequency:
      actualFrequency == null
        ? null
        : round(actualFrequency, 2),
    calibrationGap:
      calibrationGap == null
        ? null
        : round(calibrationGap, 2),
    brierScore:
      brierScore == null
        ? null
        : round(brierScore, 6),
    logLoss:
      logLoss == null
        ? null
        : round(logLoss, 6),
    policy,
    applicable: policy.applicable,
    applicationBlocked:
      LEARNING_MODE === "SHADOW" ||
      !roleEligible ||
      !policy.applicable,

    applicationBlockedReason:
      LEARNING_MODE === "SHADOW"
        ? "Mode SHADOW : application automatique désactivée."
        : !roleEligible
          ? policy.reason
          : !policy.applicable
            ? policy.reason
            : null,
  };
}

function createEngineWeightRecommendationService({
  pool,
} = {}) {
  if (!pool) {
    throw new Error(
      "EngineWeightRecommendationService: pool obligatoire."
    );
  }

  async function ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS engine_weight_recommendations (
        id BIGSERIAL PRIMARY KEY,
        engine_name TEXT NOT NULL UNIQUE,
        engine_role TEXT NOT NULL DEFAULT 'DIRECTIONAL',
        metric_focus TEXT,
        eligible_for_global_weight BOOLEAN NOT NULL DEFAULT FALSE,

        current_weight NUMERIC(8, 4) NOT NULL,
        recommended_weight NUMERIC(8, 4) NOT NULL,
        proposed_change NUMERIC(8, 4) NOT NULL,
        direction TEXT NOT NULL,

        quality_score NUMERIC(8, 4) NOT NULL,
        sample_size INTEGER NOT NULL DEFAULT 0,
        accuracy NUMERIC(10, 4),
        average_probability NUMERIC(10, 4),
        actual_frequency NUMERIC(10, 4),
        calibration_gap NUMERIC(10, 4),
        brier_score NUMERIC(12, 8),
        log_loss NUMERIC(12, 8),

        stage TEXT NOT NULL,
        confidence TEXT NOT NULL,
        applicable BOOLEAN NOT NULL DEFAULT FALSE,
        maximum_change NUMERIC(8, 4) NOT NULL DEFAULT 0,
        reason TEXT,
        application_blocked BOOLEAN NOT NULL DEFAULT TRUE,
        application_blocked_reason TEXT,

        learning_mode TEXT NOT NULL,
        recommendation_version TEXT NOT NULL,
        learning_version TEXT NOT NULL,

        calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE engine_weight_recommendations
      ADD COLUMN IF NOT EXISTS
        engine_role TEXT
        NOT NULL DEFAULT 'DIRECTIONAL';
    `);

    await pool.query(`
      ALTER TABLE engine_weight_recommendations
      ADD COLUMN IF NOT EXISTS
        metric_focus TEXT;
    `);

    await pool.query(`
      ALTER TABLE engine_weight_recommendations
      ADD COLUMN IF NOT EXISTS
        eligible_for_global_weight BOOLEAN
        NOT NULL DEFAULT FALSE;
    `);
  }

  async function rebuildRecommendations() {
    await ensureTables();

    const runResult = await pool.query(`
      INSERT INTO engine_learning_runs(run_type)
      VALUES ('WEIGHT_RECOMMENDATION_REBUILD')
      RETURNING id
    `);

    const runId = runResult.rows[0]?.id;
    const startedAt = new Date().toISOString();

    try {
      /*
       * Agrégation pondérée de tous les marchés d'un moteur.
       */
      const result = await pool.query(`
        SELECT
          engine_name,
          SUM(sample_size)::INTEGER AS sample_size,

          CASE
            WHEN SUM(sample_size) > 0
            THEN SUM(
              COALESCE(accuracy, 0) * sample_size
            ) / SUM(sample_size)
            ELSE NULL
          END AS accuracy,

          CASE
            WHEN SUM(sample_size) > 0
            THEN SUM(
              COALESCE(average_probability, 0) *
              sample_size
            ) / SUM(sample_size)
            ELSE NULL
          END AS average_probability,

          CASE
            WHEN SUM(sample_size) > 0
            THEN SUM(
              COALESCE(actual_frequency, 0) *
              sample_size
            ) / SUM(sample_size)
            ELSE NULL
          END AS actual_frequency,

          CASE
            WHEN SUM(sample_size) > 0
            THEN SUM(
              COALESCE(calibration_gap, 0) *
              sample_size
            ) / SUM(sample_size)
            ELSE NULL
          END AS calibration_gap,

          CASE
            WHEN SUM(sample_size) > 0
            THEN SUM(
              COALESCE(brier_score, 0.25) *
              sample_size
            ) / SUM(sample_size)
            ELSE NULL
          END AS brier_score,

          CASE
            WHEN SUM(sample_size) > 0
            THEN SUM(
              COALESCE(log_loss, 0) *
              sample_size
            ) / SUM(sample_size)
            ELSE NULL
          END AS log_loss

        FROM engine_performance_stats
        GROUP BY engine_name
        ORDER BY engine_name
      `);

      const recommendations =
        result.rows.map((row) =>
          buildRecommendation({
            engineName: row.engine_name,
            sampleSize: row.sample_size,
            accuracy: row.accuracy,
            averageProbability:
              row.average_probability,
            actualFrequency:
              row.actual_frequency,
            calibrationGap:
              row.calibration_gap,
            brierScore: row.brier_score,
            logLoss: row.log_loss,
          })
        );

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        /*
         * Les moteurs sans statistique ne sont pas inventés.
         * Leur recommandation apparaîtra lorsqu'ils auront au moins
         * un groupe de performance.
         */
        for (const item of recommendations) {
          await client.query(
            `
              INSERT INTO engine_weight_recommendations (
                engine_name,
                engine_role,
                metric_focus,
                eligible_for_global_weight,
                current_weight,
                recommended_weight,
                proposed_change,
                direction,
                quality_score,
                sample_size,
                accuracy,
                average_probability,
                actual_frequency,
                calibration_gap,
                brier_score,
                log_loss,
                stage,
                confidence,
                applicable,
                maximum_change,
                reason,
                application_blocked,
                application_blocked_reason,
                learning_mode,
                recommendation_version,
                learning_version,
                calculated_at,
                updated_at
              )
              VALUES (
                $1, $2, $3, $4,
                $5, $6, $7, $8,
                $9, $10, $11, $12,
                $13, $14, $15, $16,
                $17, $18, $19, $20,
                $21, $22, $23, $24,
                $25, $26,
                NOW(), NOW()
              )
              ON CONFLICT (engine_name)
              DO UPDATE SET
                engine_role =
                  EXCLUDED.engine_role,
                metric_focus =
                  EXCLUDED.metric_focus,
                eligible_for_global_weight =
                  EXCLUDED.eligible_for_global_weight,
                current_weight =
                  EXCLUDED.current_weight,
                recommended_weight =
                  EXCLUDED.recommended_weight,
                proposed_change =
                  EXCLUDED.proposed_change,
                direction =
                  EXCLUDED.direction,
                quality_score =
                  EXCLUDED.quality_score,
                sample_size =
                  EXCLUDED.sample_size,
                accuracy =
                  EXCLUDED.accuracy,
                average_probability =
                  EXCLUDED.average_probability,
                actual_frequency =
                  EXCLUDED.actual_frequency,
                calibration_gap =
                  EXCLUDED.calibration_gap,
                brier_score =
                  EXCLUDED.brier_score,
                log_loss =
                  EXCLUDED.log_loss,
                stage =
                  EXCLUDED.stage,
                confidence =
                  EXCLUDED.confidence,
                applicable =
                  EXCLUDED.applicable,
                maximum_change =
                  EXCLUDED.maximum_change,
                reason =
                  EXCLUDED.reason,
                application_blocked =
                  EXCLUDED.application_blocked,
                application_blocked_reason =
                  EXCLUDED.application_blocked_reason,
                learning_mode =
                  EXCLUDED.learning_mode,
                recommendation_version =
                  EXCLUDED.recommendation_version,
                learning_version =
                  EXCLUDED.learning_version,
                calculated_at = NOW(),
                updated_at = NOW()
            `,
            [
              item.engineName,
              item.role,
              item.metricFocus,
              item.eligibleForGlobalWeight,
              item.currentWeight,
              item.recommendedWeight,
              item.proposedChange,
              item.direction,
              item.qualityScore,
              item.sampleSize,
              item.accuracy,
              item.averageProbability,
              item.actualFrequency,
              item.calibrationGap,
              item.brierScore,
              item.logLoss,
              item.policy.stage,
              item.policy.confidence,
              item.applicable,
              item.policy.maximumChange,
              item.policy.reason,
              item.applicationBlocked,
              item.applicationBlockedReason,
              LEARNING_MODE,
              RECOMMENDATION_VERSION,
              ENGINE_LEARNING_VERSION,
            ]
          );
        }

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const summary = {
        ok: true,
        mode: LEARNING_MODE,
        recommendationVersion:
          RECOMMENDATION_VERSION,
        enginesFound: recommendations.length,
        applicableRecommendations:
          recommendations.filter(
            (item) => item.applicable
          ).length,
        blockedRecommendations:
          recommendations.filter(
            (item) =>
              item.applicationBlocked
          ).length,
        startedAt,
        finishedAt:
          new Date().toISOString(),
      };

      await pool.query(
        `
          UPDATE engine_learning_runs
          SET
            status = 'COMPLETED',
            rows_processed = $2,
            summary = $3::jsonb,
            finished_at = NOW()
          WHERE id = $1
        `,
        [
          runId,
          recommendations.length,
          JSON.stringify(summary),
        ]
      );

      return {
        ...summary,
        recommendations,
      };
    } catch (error) {
      await pool.query(
        `
          UPDATE engine_learning_runs
          SET
            status = 'FAILED',
            error_message = $2,
            finished_at = NOW()
          WHERE id = $1
        `,
        [
          runId,
          String(error?.message || error)
            .slice(0, 2000),
        ]
      );

      throw error;
    }
  }

  async function getRecommendations() {
    await ensureTables();

    const result = await pool.query(`
      SELECT *
      FROM engine_weight_recommendations
      ORDER BY
        applicable DESC,
        quality_score DESC,
        sample_size DESC,
        engine_name ASC
    `);

    return {
      ok: true,
      mode: LEARNING_MODE,
      recommendationVersion:
        RECOMMENDATION_VERSION,
      applicationEnabled: false,
      count: result.rows.length,
      recommendations:
        result.rows,
      generatedAt:
        new Date().toISOString(),
    };
  }

  return {
    ensureTables,
    rebuildRecommendations,
    getRecommendations,
  };
}

module.exports = {
  createEngineWeightRecommendationService,
  buildRecommendation,
  samplePolicy,
  qualityScore,
  BASELINE_WEIGHTS,
  RECOMMENDATION_VERSION,
};
