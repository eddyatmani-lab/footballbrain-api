'use strict';

const DEFAULT_CONFIG = Object.freeze({
  minimumExpectedGoals: 0.15,
  maximumExpectedGoals: 4.5,

  recentFormWeight: 0.45,
  seasonWeight: 0.35,
  venueWeight: 0.20,

  /*
   * Le modèle Poisson peut rester un repère, mais il ne doit plus être
   * recopié plusieurs fois dans les blocs season/venue.
   */
  baselineWeight: 0.30,
  strengthModelWeight: 0.70,

  /*
   * Garde-fou : évite qu'un modèle avancé s'éloigne de façon démesurée
   * du baseline lorsqu'il manque des statistiques réellement indépendantes.
   */
  maximumBaselineDeviationRatio: 0.55,

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
 * Retourne un nombre valide ou null.
 */
function nullableNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue)
    ? numericValue
    : null;
}

/**
 * Calcule une moyenne sécurisée.
 */
function average(values = []) {
  const validValues = values
    .map(nullableNumber)
    .filter((value) => value !== null);

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
 *
 * Important :
 * null, undefined et "" ne doivent jamais être convertis en zéro.
 */
function weightedAverage(entries = [], fallback = 1) {
  const validEntries = entries
    .map(({ value, weight }) => ({
      value: nullableNumber(value),
      weight: nullableNumber(weight),
    }))
    .filter(
      ({ value, weight }) =>
        value !== null &&
        weight !== null &&
        weight > 0
    );

  if (validEntries.length === 0) {
    return fallback;
  }

  const weightedSum = validEntries.reduce(
    (sum, entry) => sum + entry.value * entry.weight,
    0
  );

  const totalWeight = validEntries.reduce(
    (sum, entry) => sum + entry.weight,
    0
  );

  return weightedSum / totalWeight;
}

/**
 * Retourne un facteur compris entre 0.65 et 1.15.
 *
 * Une valeur absente est neutre : facteur 1.
 * Une valeur négative diminue les xG.
 * Une valeur positive augmente les xG.
 */
function scoreToFactor(score, impact = 0.01) {
  const numericScore = nullableNumber(score);

  if (numericScore === null) {
    return 1;
  }

  const normalizedScore = clamp(
    numericScore,
    -35,
    15
  );

  return clamp(
    1 + normalizedScore * impact,
    0.65,
    1.15
  );
}

function hasFiniteValue(value) {
  return nullableNumber(value) !== null;
}

function hasUsableTeamStats(team = {}) {
  return (
    hasFiniteValue(team?.goalsForPerMatch) &&
    hasFiniteValue(team?.goalsAgainstPerMatch)
  );
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
 * Mélange le modèle de forces avec un baseline Poisson sans compter
 * ce dernier plusieurs fois.
 */
function blendWithBaseline({
  strengthExpectedGoals,
  baselineExpectedGoals,
  config,
}) {
  const baseline = nullableNumber(baselineExpectedGoals);

  if (baseline === null || baseline <= 0) {
    return strengthExpectedGoals;
  }

  const lowerBound =
    baseline * (1 - config.maximumBaselineDeviationRatio);

  const upperBound =
    baseline * (1 + config.maximumBaselineDeviationRatio);

  const guardedStrength = clamp(
    strengthExpectedGoals,
    Math.max(config.minimumExpectedGoals, lowerBound),
    Math.min(config.maximumExpectedGoals, upperBound)
  );

  return (
    guardedStrength * config.strengthModelWeight +
    baseline * config.baselineWeight
  );
}

/**
 * Calcule les expected goals du match.
 *
 * Les données attendues doivent déjà être normalisées en moyennes par match.
 *
 * Corrections V2 :
 * - aucune donnée absente n'est convertie en zéro ;
 * - les impacts contextuels absents sont neutres ;
 * - la combinaison attaque/défense utilise une moyenne géométrique amortie ;
 * - le modèle Poisson est utilisé une seule fois comme baseline optionnel ;
 * - les valeurs season/venue doivent provenir de vraies statistiques.
 */
function computeAdvancedXGModel(input = {}, customConfig = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...customConfig,
  };

  const leagueAverageGoals = {
    home: clamp(
      input.leagueAverageGoals?.home ?? 1.4,
      0.5,
      3
    ),
    away: clamp(
      input.leagueAverageGoals?.away ?? 1.1,
      0.3,
      2.5
    ),
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
    seasonGoalsFor:
      input.home?.season?.goalsForPerMatch,
    seasonGoalsAgainst:
      input.home?.season?.goalsAgainstPerMatch,
    venueGoalsFor:
      input.home?.venue?.goalsForPerMatch,
    venueGoalsAgainst:
      input.home?.venue?.goalsAgainstPerMatch,
    config,
  });

  const awayStrength = computeTeamStrength({
    recentGoalsFor: awayRecentGoalsFor,
    recentGoalsAgainst: awayRecentGoalsAgainst,
    seasonGoalsFor:
      input.away?.season?.goalsForPerMatch,
    seasonGoalsAgainst:
      input.away?.season?.goalsAgainstPerMatch,
    venueGoalsFor:
      input.away?.venue?.goalsForPerMatch,
    venueGoalsAgainst:
      input.away?.venue?.goalsAgainstPerMatch,
    config,
  });

  const leagueHomeAverage =
    leagueAverageGoals.home || 1.4;

  const leagueAwayAverage =
    leagueAverageGoals.away || 1.1;

  /*
   * Ratios limités pour éviter qu'une courte série de résultats
   * n'explose le calcul.
   */
  const homeAttackRatio = clamp(
    homeStrength.attackStrength / leagueHomeAverage,
    0.35,
    2.5
  );

  const awayAttackRatio = clamp(
    awayStrength.attackStrength / leagueAwayAverage,
    0.35,
    2.5
  );

  const homeDefenseRatio = clamp(
    homeStrength.defensiveWeakness / leagueAwayAverage,
    0.35,
    2.5
  );

  const awayDefenseRatio = clamp(
    awayStrength.defensiveWeakness / leagueHomeAverage,
    0.35,
    2.5
  );

  /*
   * V1 multipliait directement les ratios attaque et défense, ce qui
   * amplifiait fortement les écarts.
   *
   * La racine carrée produit une moyenne géométrique plus stable.
   */
  const homeStrengthExpectedGoals =
    leagueHomeAverage *
    Math.sqrt(homeAttackRatio * awayDefenseRatio);

  const awayStrengthExpectedGoals =
    leagueAwayAverage *
    Math.sqrt(awayAttackRatio * homeDefenseRatio);

  let homeExpectedGoals = blendWithBaseline({
    strengthExpectedGoals:
      homeStrengthExpectedGoals,
    baselineExpectedGoals:
      input.baselineExpectedGoals?.home,
    config,
  });

  let awayExpectedGoals = blendWithBaseline({
    strengthExpectedGoals:
      awayStrengthExpectedGoals,
    baselineExpectedGoals:
      input.baselineExpectedGoals?.away,
    config,
  });

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

  const hasSeasonStats =
    hasUsableTeamStats(input.home?.season) &&
    hasUsableTeamStats(input.away?.season);

  const hasVenueStats =
    hasUsableTeamStats(input.home?.venue) &&
    hasUsableTeamStats(input.away?.venue);

  const quality = computeXGQuality({
    homeSampleSize,
    awaySampleSize,
    hasLineups:
      Boolean(input.metadata?.hasLineups),
    hasInjuries:
      Boolean(input.metadata?.hasInjuries),
    hasSeasonStats,
    hasVenueStats,
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

    xgSource: 'FOOTBALLBRAIN_ADVANCED_XG_V2',
    xgQuality: quality.score,
    xgWarnings: quality.warnings,

    diagnostics: {
      leagueAverageGoals,

      baselineExpectedGoals: {
        home: nullableNumber(
          input.baselineExpectedGoals?.home
        ),
        away: nullableNumber(
          input.baselineExpectedGoals?.away
        ),
      },

      strengthExpectedGoals: {
        home: Number(
          homeStrengthExpectedGoals.toFixed(3)
        ),
        away: Number(
          awayStrengthExpectedGoals.toFixed(3)
        ),
      },

      home: {
        attackStrength: Number(
          homeStrength.attackStrength.toFixed(3)
        ),
        defensiveWeakness: Number(
          homeStrength.defensiveWeakness.toFixed(3)
        ),
        attackRatio: Number(
          homeAttackRatio.toFixed(3)
        ),
        defenseRatio: Number(
          homeDefenseRatio.toFixed(3)
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
        attackRatio: Number(
          awayAttackRatio.toFixed(3)
        ),
        defenseRatio: Number(
          awayDefenseRatio.toFixed(3)
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

      dataAvailability: {
        hasSeasonStats,
        hasVenueStats,
        homeSampleSize,
        awaySampleSize,
      },
    },
  };
}

module.exports = {
  computeAdvancedXGModel,
  DEFAULT_CONFIG,
};
