'use strict';

const DEFAULT_CONFIG = Object.freeze({
  minimumExpectedGoals: 0.15,
  maximumExpectedGoals: 4.5,

  recentFormWeight: 0.45,
  seasonWeight: 0.35,
  venueWeight: 0.20,

  missingLineupPenalty: 8,
  missingInjuryDataPenalty: 5,
  insufficientSamplePenalty: 15,

  minimumGoodSampleSize: 5,
});

/**
 * Limite une valeur entre un minimum et un maximum.
 */
function clamp(value, min, max) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return min;
  }

  return Math.min(Math.max(numericValue, min), max);
}

/**
 * Convertit une valeur en nombre exploitable.
 */
function toNumber(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

/**
 * Calcule une moyenne sécurisée.
 */
function average(values = []) {
  const validValues = values
    .map((value) => Number(value))
    .filter(Number.isFinite);

  if (validValues.length === 0) {
    return null;
  }

  return (
    validValues.reduce((sum, value) => sum + value, 0) /
    validValues.length
  );
}

/**
 * Calcule une moyenne pondérée.
 */
function weightedAverage(entries = [], fallback = 1) {
  const validEntries = entries.filter(
    ({ value, weight }) =>
      Number.isFinite(Number(value)) &&
      Number.isFinite(Number(weight)) &&
      Number(weight) > 0
  );

  if (validEntries.length === 0) {
    return fallback;
  }

  const weightedSum = validEntries.reduce(
    (sum, entry) =>
      sum + Number(entry.value) * Number(entry.weight),
    0
  );

  const totalWeight = validEntries.reduce(
    (sum, entry) => sum + Number(entry.weight),
    0
  );

  return weightedSum / totalWeight;
}

/**
 * Retourne un facteur compris entre 0.65 et 1.15.
 *
 * Une valeur négative diminue les xG.
 * Une valeur positive augmente les xG.
 */
function scoreToFactor(score, impact = 0.01) {
  const normalizedScore = clamp(score, -35, 15);
  return clamp(1 + normalizedScore * impact, 0.65, 1.15);
}

/**
 * Évalue la qualité des données utilisées pour produire les xG.
 */
function computeXGQuality({
  homeSampleSize,
  awaySampleSize,
  hasLineups,
  hasInjuries,
  hasSeasonStats,
  hasVenueStats,
  config,
}) {
  let quality = 100;
  const warnings = [];

  if (
    homeSampleSize < config.minimumGoodSampleSize ||
    awaySampleSize < config.minimumGoodSampleSize
  ) {
    quality -= config.insufficientSamplePenalty;
    warnings.push('INSUFFICIENT_RECENT_SAMPLE');
  }

  if (!hasLineups) {
    quality -= config.missingLineupPenalty;
    warnings.push('MISSING_LINEUPS');
  }

  if (!hasInjuries) {
    quality -= config.missingInjuryDataPenalty;
    warnings.push('MISSING_INJURIES');
  }

  if (!hasSeasonStats) {
    quality -= 12;
    warnings.push('MISSING_SEASON_STATS');
  }

  if (!hasVenueStats) {
    quality -= 10;
    warnings.push('MISSING_VENUE_STATS');
  }

  return {
    score: Math.round(clamp(quality, 0, 100)),
    warnings,
  };
}

/**
 * Produit les forces offensives et défensives d'une équipe.
 */
function computeTeamStrength({
  recentGoalsFor,
  recentGoalsAgainst,
  seasonGoalsFor,
  seasonGoalsAgainst,
  venueGoalsFor,
  venueGoalsAgainst,
  config,
}) {
  const attackStrength = weightedAverage(
    [
      {
        value: recentGoalsFor,
        weight: config.recentFormWeight,
      },
      {
        value: seasonGoalsFor,
        weight: config.seasonWeight,
      },
      {
        value: venueGoalsFor,
        weight: config.venueWeight,
      },
    ],
    1
  );

  const defensiveWeakness = weightedAverage(
    [
      {
        value: recentGoalsAgainst,
        weight: config.recentFormWeight,
      },
      {
        value: seasonGoalsAgainst,
        weight: config.seasonWeight,
      },
      {
        value: venueGoalsAgainst,
        weight: config.venueWeight,
      },
    ],
    1
  );

  return {
    attackStrength,
    defensiveWeakness,
  };
}

/**
 * Calcule les expected goals du match.
 *
 * Les données attendues doivent déjà être normalisées en moyennes par match.
 */
function computeAdvancedXGModel(input = {}, customConfig = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...customConfig,
  };

  const leagueAverageGoals = {
    home: clamp(input.leagueAverageGoals?.home, 0.5, 3),
    away: clamp(input.leagueAverageGoals?.away, 0.3, 2.5),
  };

  const homeRecentGoalsFor = average(
    input.home?.recent?.goalsFor
  );
  const homeRecentGoalsAgainst = average(
    input.home?.recent?.goalsAgainst
  );
  const awayRecentGoalsFor = average(
    input.away?.recent?.goalsFor
  );
  const awayRecentGoalsAgainst = average(
    input.away?.recent?.goalsAgainst
  );

  const homeStrength = computeTeamStrength({
    recentGoalsFor: homeRecentGoalsFor,
    recentGoalsAgainst: homeRecentGoalsAgainst,
    seasonGoalsFor: input.home?.season?.goalsForPerMatch,
    seasonGoalsAgainst:
      input.home?.season?.goalsAgainstPerMatch,
    venueGoalsFor: input.home?.venue?.goalsForPerMatch,
    venueGoalsAgainst:
      input.home?.venue?.goalsAgainstPerMatch,
    config,
  });

  const awayStrength = computeTeamStrength({
    recentGoalsFor: awayRecentGoalsFor,
    recentGoalsAgainst: awayRecentGoalsAgainst,
    seasonGoalsFor: input.away?.season?.goalsForPerMatch,
    seasonGoalsAgainst:
      input.away?.season?.goalsAgainstPerMatch,
    venueGoalsFor: input.away?.venue?.goalsForPerMatch,
    venueGoalsAgainst:
      input.away?.venue?.goalsAgainstPerMatch,
    config,
  });

  const leagueHomeAverage = leagueAverageGoals.home || 1.4;
  const leagueAwayAverage = leagueAverageGoals.away || 1.1;

  const normalizedHomeAttack =
    homeStrength.attackStrength / leagueHomeAverage;

  const normalizedAwayAttack =
    awayStrength.attackStrength / leagueAwayAverage;

  const normalizedHomeDefensiveWeakness =
    homeStrength.defensiveWeakness / leagueAwayAverage;

  const normalizedAwayDefensiveWeakness =
    awayStrength.defensiveWeakness / leagueHomeAverage;

  let homeExpectedGoals =
    leagueHomeAverage *
    normalizedHomeAttack *
    normalizedAwayDefensiveWeakness;

  let awayExpectedGoals =
    leagueAwayAverage *
    normalizedAwayAttack *
    normalizedHomeDefensiveWeakness;

  /*
   * Ajustements contextuels.
   *
   * injuryImpact et lineupImpact sont des scores :
   *  0  = aucun impact
   * -10 = impact négatif modéré
   * -25 = impact négatif important
   */
  const homeAvailabilityFactor =
    scoreToFactor(input.home?.injuryImpact) *
    scoreToFactor(input.home?.lineupImpact);

  const awayAvailabilityFactor =
    scoreToFactor(input.away?.injuryImpact) *
    scoreToFactor(input.away?.lineupImpact);

  const homeFatigueFactor = scoreToFactor(
    input.home?.fatigueImpact,
    0.008
  );

  const awayFatigueFactor = scoreToFactor(
    input.away?.fatigueImpact,
    0.008
  );

  const homeMotivationFactor = scoreToFactor(
    input.home?.motivationImpact,
    0.006
  );

  const awayMotivationFactor = scoreToFactor(
    input.away?.motivationImpact,
    0.006
  );

  homeExpectedGoals *=
    homeAvailabilityFactor *
    homeFatigueFactor *
    homeMotivationFactor;

  awayExpectedGoals *=
    awayAvailabilityFactor *
    awayFatigueFactor *
    awayMotivationFactor;

  homeExpectedGoals = clamp(
    homeExpectedGoals,
    config.minimumExpectedGoals,
    config.maximumExpectedGoals
  );

  awayExpectedGoals = clamp(
    awayExpectedGoals,
    config.minimumExpectedGoals,
    config.maximumExpectedGoals
  );

  const homeSampleSize =
    input.home?.recent?.goalsFor?.length || 0;

  const awaySampleSize =
    input.away?.recent?.goalsFor?.length || 0;

  const quality = computeXGQuality({
    homeSampleSize,
    awaySampleSize,
    hasLineups: Boolean(input.metadata?.hasLineups),
    hasInjuries: Boolean(input.metadata?.hasInjuries),
    hasSeasonStats: Boolean(
      input.home?.season && input.away?.season
    ),
    hasVenueStats: Boolean(
      input.home?.venue && input.away?.venue
    ),
    config,
  });

  const totalExpectedGoals =
    homeExpectedGoals + awayExpectedGoals;

  return {
    expectedGoals: {
      home: Number(homeExpectedGoals.toFixed(3)),
      away: Number(awayExpectedGoals.toFixed(3)),
      total: Number(totalExpectedGoals.toFixed(3)),
    },

    xgSource: 'FOOTBALLBRAIN_ADVANCED_XG_V1',
    xgQuality: quality.score,
    xgWarnings: quality.warnings,

    diagnostics: {
      leagueAverageGoals,
      home: {
        attackStrength: Number(
          homeStrength.attackStrength.toFixed(3)
        ),
        defensiveWeakness: Number(
          homeStrength.defensiveWeakness.toFixed(3)
        ),
        availabilityFactor: Number(
          homeAvailabilityFactor.toFixed(3)
        ),
        fatigueFactor: Number(
          homeFatigueFactor.toFixed(3)
        ),
        motivationFactor: Number(
          homeMotivationFactor.toFixed(3)
        ),
      },
      away: {
        attackStrength: Number(
          awayStrength.attackStrength.toFixed(3)
        ),
        defensiveWeakness: Number(
          awayStrength.defensiveWeakness.toFixed(3)
        ),
        availabilityFactor: Number(
          awayAvailabilityFactor.toFixed(3)
        ),
        fatigueFactor: Number(
          awayFatigueFactor.toFixed(3)
        ),
        motivationFactor: Number(
          awayMotivationFactor.toFixed(3)
        ),
      },
    },
  };
}

module.exports = {
  computeAdvancedXGModel,
  DEFAULT_CONFIG,
};