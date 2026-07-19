const DEFAULT_SIMULATION_COUNT = 10000;
const MAX_GOALS = 10;

function isFiniteNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function clamp(value, minimum, maximum) {
  return Math.min(
    Math.max(value, minimum),
    maximum,
  );
}

function normalizeXg(value, fallback) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return clamp(numericValue, 0.05, 6);
}

function normalizeSimulationCount(value) {
  if (!isFiniteNumber(value)) {
    return DEFAULT_SIMULATION_COUNT;
  }

  return clamp(
    Math.round(value),
    1000,
    250000,
  );
}

/**
 * Générateur pseudo-aléatoire reproductible.
 *
 * Une même seed produit exactement les mêmes résultats.
 * Cela facilite les tests, les audits et les comparaisons.
 */
function createSeededRandom(seed = 123456789) {
  let state =
    Math.abs(Math.trunc(seed)) ||
    123456789;

  return function random() {
    state =
      (state * 1664525 +
        1013904223) %
      4294967296;

    return state / 4294967296;
  };
}

/**
 * Échantillonnage d’une loi de Poisson
 * avec l’algorithme de Knuth.
 */
function samplePoisson(lambda, random) {
  if (
    !isFiniteNumber(lambda) ||
    lambda <= 0
  ) {
    return 0;
  }

  const threshold =
    Math.exp(-lambda);

  let product = 1;
  let count = 0;

  do {
    count += 1;
    product *= random();
  } while (
    product > threshold &&
    count <= MAX_GOALS + 1
  );

  return clamp(
    count - 1,
    0,
    MAX_GOALS,
  );
}

function percentage(count, total) {
  if (!total) {
    return 0;
  }

  return (
    Math.round(
      (count / total) *
        1000,
    ) / 10
  );
}

function buildTopScores(
  scoreCounts,
  simulations,
  limit = 5,
) {
  return Array.from(
    scoreCounts.entries(),
  )
    .map(([score, count]) => ({
      score,
      count,
      probability:
        percentage(
          count,
          simulations,
        ),
    }))
    .sort(
      (first, second) =>
        second.count -
        first.count,
    )
    .slice(0, limit);
}

function calculateVariance(values) {
  if (!values.length) {
    return null;
  }

  const mean =
    values.reduce(
      (sum, value) =>
        sum + value,
      0,
    ) / values.length;

  const variance =
    values.reduce(
      (sum, value) =>
        sum +
        Math.pow(
          value - mean,
          2,
        ),
      0,
    ) / values.length;

  return (
    Math.round(
      variance * 1000,
    ) / 1000
  );
}

/**
 * Football Monte Carlo™
 *
 * Effectue de véritables simulations de scores
 * à partir de deux distributions de Poisson.
 *
 * Les probabilités calibrées de l’engine restent
 * disponibles dans `engineProbabilities` afin de
 * comparer le modèle probabiliste et la simulation.
 */
function FootballMonteCarlo(
  match = {},
  engine = {},
  simulations = DEFAULT_SIMULATION_COUNT,
  options = {},
) {
  const simulationCount =
    normalizeSimulationCount(
      simulations,
    );

  const seed =
    options.seed ??
    engine?.match?.id ??
    match?.id ??
    123456789;

  const numericSeed =
    typeof seed === "number"
      ? seed
      : Array.from(String(seed)).reduce(
          (total, character) =>
            total +
            character.charCodeAt(0),
          0,
        );

  const random =
    createSeededRandom(
      numericSeed,
    );

  const xgHome = normalizeXg(
    engine?.match?.xgHome ??
      match.xg_home,
    1.3,
  );

  const xgAway = normalizeXg(
    engine?.match?.xgAway ??
      match.xg_away,
    1.1,
  );

  const scoreCounts =
    new Map();

  const totalGoalsSamples = [];

  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let bttsCount = 0;
  let over25Count = 0;

  for (
    let index = 0;
    index < simulationCount;
    index += 1
  ) {
    const homeGoals =
      samplePoisson(
        xgHome,
        random,
      );

    const awayGoals =
      samplePoisson(
        xgAway,
        random,
      );

    const totalGoals =
      homeGoals + awayGoals;

    const score =
      `${homeGoals}-${awayGoals}`;

    scoreCounts.set(
      score,
      (scoreCounts.get(score) ??
        0) + 1,
    );

    totalGoalsSamples.push(
      totalGoals,
    );

    if (homeGoals > awayGoals) {
      homeWins += 1;
    } else if (
      homeGoals === awayGoals
    ) {
      draws += 1;
    } else {
      awayWins += 1;
    }

    if (
      homeGoals > 0 &&
      awayGoals > 0
    ) {
      bttsCount += 1;
    }

    if (totalGoals >= 3) {
      over25Count += 1;
    }
  }

  const homeWin =
    percentage(
      homeWins,
      simulationCount,
    );

  const draw =
    percentage(
      draws,
      simulationCount,
    );

  const awayWin =
    percentage(
      awayWins,
      simulationCount,
    );

  const btts =
    percentage(
      bttsCount,
      simulationCount,
    );

  const over25 =
    percentage(
      over25Count,
      simulationCount,
    );

  const topScores =
    buildTopScores(
      scoreCounts,
      simulationCount,
    );

  const expectedTotal =
    Number(
      (
        xgHome + xgAway
      ).toFixed(2),
    );

  const expectedDiff =
    Number(
      Math.abs(
        xgHome - xgAway,
      ).toFixed(2),
    );

  const strongestOutcome = [
    {
      key: "home",
      label:
        "Victoire domicile",
      probability: homeWin,
    },
    {
      key: "draw",
      label: "Match nul",
      probability: draw,
    },
    {
      key: "away",
      label:
        "Victoire extérieur",
      probability: awayWin,
    },
  ].sort(
    (first, second) =>
      second.probability -
      first.probability,
  )[0];
const totalGoalsVariance =
  calculateVariance(
    totalGoalsSamples,
  );

return {
  version: "2.0.0",

  method:
    "poisson-monte-carlo",

  simulations:
    simulationCount,

  seed: numericSeed,

  inputs: {
    xgHome,
    xgAway,
  },

  homeWin,
  draw,
  awayWin,

  outcomes: [
    {
      key: "home",
      label: "Victoire domicile",
      probability: homeWin,
      count: homeWins,
    },
    {
      key: "draw",
      label: "Match nul",
      probability: draw,
      count: draws,
    },
    {
      key: "away",
      label: "Victoire extérieur",
      probability: awayWin,
      count: awayWins,
    },
  ],

  strongestOutcome,
  topScores,

  btts,
  over25,

  expectedTotal,
  expectedDiff,

  totalGoalsVariance,

  engineProbabilities: {
    home:
      engine?.prediction
        ?.homeProb ?? null,

    draw:
      engine?.prediction
        ?.drawProb ?? null,

    away:
      engine?.prediction
        ?.awayProb ?? null,

    btts:
      engine?.match?.btts ??
      null,

    over25:
      engine?.match?.over25 ??
      null,
  },

  isAvailable: true,
};
}
module.exports = {
  FootballMonteCarlo,
};