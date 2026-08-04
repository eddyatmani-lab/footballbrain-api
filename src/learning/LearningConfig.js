"use strict";

const LEARNING_MODE = String(
  process.env.ENGINE_LEARNING_MODE || "SHADOW"
)
  .trim()
  .toUpperCase();

const ENGINE_LEARNING_VERSION = "engine-learning-v1.0.0";

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
});

const SETTLEMENT_INTERVAL_MINUTES = Math.max(
  15,
  Number(
    process.env.ENGINE_LEARNING_SETTLEMENT_INTERVAL_MINUTES
  ) || 60
);

const PERFORMANCE_INTERVAL_MINUTES = Math.max(
  30,
  Number(
    process.env.ENGINE_LEARNING_PERFORMANCE_INTERVAL_MINUTES
  ) || 180
);

module.exports = {
  LEARNING_MODE,
  ENGINE_LEARNING_VERSION,
  SUPPORTED_ENGINES,
  PERFORMANCE_THRESHOLDS,
  SETTLEMENT_INTERVAL_MINUTES,
  PERFORMANCE_INTERVAL_MINUTES,
};
