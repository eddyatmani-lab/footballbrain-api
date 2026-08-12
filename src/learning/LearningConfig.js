"use strict";

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "oui", "on"].includes(
    String(value).trim().toLowerCase()
  );
}

const ENGINE_WEIGHT_LEARNING_ENABLED =
  parseBoolean(
    process.env.ENGINE_WEIGHT_LEARNING_ENABLED,
    false
  );

const LEARNING_MODE = String(
  process.env.ENGINE_LEARNING_MODE ||
    (
      ENGINE_WEIGHT_LEARNING_ENABLED
        ? "ACTIVE_CONTROLLED"
        : "SHADOW"
    )
)
  .trim()
  .toUpperCase();

const ENGINE_LEARNING_VERSION =
  "engine-learning-v1.6-probability-integrity";

const ENGINE_ROLES = Object.freeze({
  DIRECTIONAL: "DIRECTIONAL",
  PROBABILISTIC: "PROBABILISTIC",
  MARKET: "MARKET",
  CONTEXTUAL: "CONTEXTUAL",
});

const ENGINE_ROLE_BY_NAME = Object.freeze({
  ProbabilityEngine:
    ENGINE_ROLES.PROBABILISTIC,

  MonteCarloEngine:
    ENGINE_ROLES.PROBABILISTIC,

  AttackDefenseEngine:
    ENGINE_ROLES.DIRECTIONAL,

  TransitionEngine:
    ENGINE_ROLES.DIRECTIONAL,

  MentalEngine:
    ENGINE_ROLES.DIRECTIONAL,

  TacticalProfileEngine:
    ENGINE_ROLES.DIRECTIONAL,

  XGProfile:
    ENGINE_ROLES.DIRECTIONAL,

  GoalMarketEngine:
    ENGINE_ROLES.MARKET,

  BTTSProfile:
    ENGINE_ROLES.MARKET,

  FatigueEngine:
    ENGINE_ROLES.CONTEXTUAL,
});

const ENGINE_METRIC_FOCUS = Object.freeze({
  [ENGINE_ROLES.DIRECTIONAL]:
    "ACCURACY",

  [ENGINE_ROLES.PROBABILISTIC]:
    "CALIBRATION",

  [ENGINE_ROLES.MARKET]:
    "MARKET_ACCURACY_CALIBRATION",

  [ENGINE_ROLES.CONTEXTUAL]:
    "CONTEXT_EFFECT",
});

const SUPPORTED_ENGINES = Object.freeze([
  "ProbabilityEngine",
  "AttackDefenseEngine",
  "TransitionEngine",
  "MentalEngine",
  "TacticalProfileEngine",
  "FatigueEngine",
  "XGProfile",
  "MonteCarloEngine",
  "GoalMarketEngine",
  "BTTSProfile",
]);

const PERFORMANCE_THRESHOLDS = Object.freeze({
  minimumSample: 20,
  mediumSample: 50,
  reliableSample: 100,
  excellentBrier: 0.16,
  goodBrier: 0.21,
  warningBrier: 0.26,

  /*
   * Les moteurs contextuels ne modifient jamais
   * automatiquement une probabilité avant d'avoir
   * un échantillon nettement plus important.
   */
  contextualObservationSample: 50,
  contextualLimitedSample: 150,
  contextualReliableSample: 300,

  /*
   * V1.6 : un moteur ne peut agir sur son poids global
   * que si les preuves statistiques sont suffisantes.
   */
  directionalApplicationSample: 200,
  probabilisticApplicationSample: 200,
  probabilisticMinimumProbabilityCoverage: 0.80,
});

const SETTLEMENT_INTERVAL_MINUTES = Math.max(
  15,
  Number(
    process.env
      .ENGINE_LEARNING_SETTLEMENT_INTERVAL_MINUTES
  ) || 60
);

const PERFORMANCE_INTERVAL_MINUTES = Math.max(
  30,
  Number(
    process.env
      .ENGINE_LEARNING_PERFORMANCE_INTERVAL_MINUTES
  ) || 180
);

module.exports = {
  LEARNING_MODE,
  ENGINE_LEARNING_VERSION,
  ENGINE_WEIGHT_LEARNING_ENABLED,
  ENGINE_ROLES,
  ENGINE_ROLE_BY_NAME,
  ENGINE_METRIC_FOCUS,
  SUPPORTED_ENGINES,
  PERFORMANCE_THRESHOLDS,
  SETTLEMENT_INTERVAL_MINUTES,
  PERFORMANCE_INTERVAL_MINUTES,
};
