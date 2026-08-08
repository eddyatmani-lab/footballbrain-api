const KELLY_SERVICE_VERSION =
  "KELLY-BET-SERVICE-V1";

const DEFAULT_CONFIG =
  Object.freeze({
    fractionalKelly:
      0.20,

    minimumDecisionScore:
      65,

    minimumProbability:
      50,

    minimumOdd:
      1.20,

    maximumOdd:
      6.00,

    minimumValuePercent:
      0,

    maximumStakePercent:
      3,

    maximumBets:
      20,
  });

function numberOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function round(
  value,
  decimals = 2
) {
  const factor =
    10 ** decimals;

  return (
    Math.round(
      (Number(value) +
        Number.EPSILON) *
        factor
    ) / factor
  );
}

function normalizeProbability(
  value
) {
  const number =
    numberOrNull(value);

  if (number === null) {
    return null;
  }

  /*
   * Brain Studio utilise normalement
   * une probabilité en pourcentage.
   *
   * On accepte aussi exceptionnellement
   * une valeur 0-1.
   */
  if (
    number > 0 &&
    number <= 1
  ) {
    return number * 100;
  }

  if (
    number < 0 ||
    number > 100
  ) {
    return null;
  }

  return number;
}

function normalizeMarketKey(
  value = ""
) {
  const compact =
    String(value || "")
      .trim()
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );

  if (
    [
      "HOME",
      "HOMEWIN",
      "1",
    ].includes(compact)
  ) {
    return "HOME";
  }

  if (
    [
      "DRAW",
      "X",
      "N",
    ].includes(compact)
  ) {
    return "DRAW";
  }

  if (
    [
      "AWAY",
      "AWAYWIN",
      "2",
    ].includes(compact)
  ) {
    return "AWAY";
  }

  if (
    [
      "OVER25",
      "OVER250",
      "PLUS25",
    ].includes(compact)
  ) {
    return "OVER25";
  }

  if (
    [
      "UNDER25",
      "UNDER250",
      "MOINS25",
    ].includes(compact)
  ) {
    return "UNDER25";
  }

  if (
    [
      "BTTS",
      "BTTSYES",
      "GG",
    ].includes(compact)
  ) {
    return "BTTS_YES";
  }

  if (
    [
      "NOBTTS",
      "BTTSNO",
      "NG",
    ].includes(compact)
  ) {
    return "BTTS_NO";
  }

  return compact || null;
}

function calculateKelly({
  probability,
  odd,
} = {}) {
  const probabilityPercent =
    normalizeProbability(
      probability
    );

  const decimalOdd =
    numberOrNull(odd);

  if (
    probabilityPercent === null ||
    decimalOdd === null ||
    decimalOdd <= 1
  ) {
    return {
      valid: false,
      kellyFull:
        null,
      kellyFullPercent:
        null,
    };
  }

  const p =
    probabilityPercent / 100;

  const q =
    1 - p;

  const b =
    decimalOdd - 1;

  const kellyFull =
    (
      b * p -
      q
    ) / b;

  return {
    valid: true,

    kellyFull,

    kellyFullPercent:
      round(
        kellyFull * 100,
        2
      ),
  };
}

function calculateValuePercent({
  probability,
  odd,
} = {}) {
  const probabilityPercent =
    normalizeProbability(
      probability
    );

  const decimalOdd =
    numberOrNull(odd);

  if (
    probabilityPercent === null ||
    decimalOdd === null ||
    decimalOdd <= 1
  ) {
    return null;
  }

  return round(
    (
      (
        probabilityPercent /
        100
      ) *
        decimalOdd -
      1
    ) *
      100,
    2
  );
}

function calculateImpliedProbability(
  odd
) {
  const decimalOdd =
    numberOrNull(odd);

  if (
    decimalOdd === null ||
    decimalOdd <= 1
  ) {
    return null;
  }

  return round(
    100 / decimalOdd,
    2
  );
}

function calculateFractionalKelly({
  kellyFull,
  fraction =
    DEFAULT_CONFIG
      .fractionalKelly,
  maximumStakePercent =
    DEFAULT_CONFIG
      .maximumStakePercent,
} = {}) {
  const full =
    numberOrNull(
      kellyFull
    );

  const normalizedFraction =
    Math.max(
      0,
      Number(fraction) || 0
    );

  if (
    full === null ||
    full <= 0
  ) {
    return {
      fractionalKelly:
        0,

      fractionalKellyPercent:
        0,

      cappedKellyPercent:
        0,
    };
  }

  const fractionalKelly =
    full *
    normalizedFraction;

  const fractionalKellyPercent =
    fractionalKelly * 100;

  const cappedKellyPercent =
    Math.min(
      fractionalKellyPercent,
      Math.max(
        0,
        Number(
          maximumStakePercent
        ) || 0
      )
    );

  return {
    fractionalKelly,

    fractionalKellyPercent:
      round(
        fractionalKellyPercent,
        2
      ),

    cappedKellyPercent:
      round(
        cappedKellyPercent,
        2
      ),
  };
}

function calculateStake({
  bankroll,
  stakePercent,
} = {}) {
  const normalizedBankroll =
    numberOrNull(
      bankroll
    );

  const normalizedPercent =
    numberOrNull(
      stakePercent
    );

  if (
    normalizedBankroll === null ||
    normalizedBankroll <= 0 ||
    normalizedPercent === null ||
    normalizedPercent <= 0
  ) {
    return null;
  }

  return round(
    normalizedBankroll *
      (
        normalizedPercent /
        100
      ),
    2
  );
}

function evaluateKellyEligibility(
  bet = {},
  config = {}
) {
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  const probability =
    normalizeProbability(
      bet.probability
    );

  const odd =
    numberOrNull(
      bet.bookmakerOdd ??
        bet.odd
    );

  const decisionScore =
    numberOrNull(
      bet.decisionScore
    );

  const valuePercent =
    numberOrNull(
      bet.valuePercent
    );

  const reasons = [];

  const blockingReasons = [];

  if (
    probability === null
  ) {
    blockingReasons.push(
      "PROBABILITY_UNAVAILABLE"
    );
  }

  if (
    odd === null ||
    odd <= 1
  ) {
    blockingReasons.push(
      "ODD_UNAVAILABLE"
    );
  }

  if (
    decisionScore === null
  ) {
    blockingReasons.push(
      "DECISION_SCORE_UNAVAILABLE"
    );
  }

  if (
    probability !== null &&
    probability <
      mergedConfig
        .minimumProbability
  ) {
    blockingReasons.push(
      "PROBABILITY_TOO_LOW"
    );
  }

  if (
    decisionScore !== null &&
    decisionScore <
      mergedConfig
        .minimumDecisionScore
  ) {
    blockingReasons.push(
      "DECISION_SCORE_TOO_LOW"
    );
  }

  if (
    odd !== null &&
    odd <
      mergedConfig.minimumOdd
  ) {
    blockingReasons.push(
      "ODD_TOO_LOW"
    );
  }

  if (
    odd !== null &&
    odd >
      mergedConfig.maximumOdd
  ) {
    blockingReasons.push(
      "ODD_TOO_HIGH"
    );
  }

  if (
    valuePercent !== null &&
    valuePercent <
      mergedConfig
        .minimumValuePercent
  ) {
    blockingReasons.push(
      "VALUE_NEGATIVE"
    );
  }

  const kelly =
    calculateKelly({
      probability,
      odd,
    });

  if (
    !kelly.valid ||
    kelly.kellyFull ===
      null ||
    kelly.kellyFull <= 0
  ) {
    blockingReasons.push(
      "KELLY_NOT_POSITIVE"
    );
  }

  if (
    blockingReasons
      .length === 0
  ) {
    reasons.push(
      "POSITIVE_KELLY"
    );

    reasons.push(
      "DECISION_SCORE_OK"
    );

    reasons.push(
      "ODD_OK"
    );

    reasons.push(
      "PROBABILITY_OK"
    );
  }

  return {
    eligible:
      blockingReasons
        .length === 0,

    reasons,

    blockingReasons,

    kellyFull:
      kelly.kellyFull,

    kellyFullPercent:
      kelly
        .kellyFullPercent,
  };
}

function buildKellyBet(
  input = {},
  {
    bankroll =
      null,
    config = {},
  } = {}
) {
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  const probability =
    normalizeProbability(
      input.probability
    );

  const bookmakerOdd =
    numberOrNull(
      input.bookmakerOdd ??
        input.odd
    );

  const decisionScore =
    numberOrNull(
      input.decisionScore
    );

  const valuePercent =
    calculateValuePercent({
      probability,
      odd:
        bookmakerOdd,
    });

  const eligibility =
    evaluateKellyEligibility(
      {
        probability,
        bookmakerOdd,
        decisionScore,
        valuePercent,
      },
      mergedConfig
    );

  const fractional =
    calculateFractionalKelly({
      kellyFull:
        eligibility
          .kellyFull,

      fraction:
        mergedConfig
          .fractionalKelly,

      maximumStakePercent:
        mergedConfig
          .maximumStakePercent,
    });

  const suggestedStake =
    calculateStake({
      bankroll,

      stakePercent:
        fractional
          .cappedKellyPercent,
    });

  return {
    fixtureId:
      Number(
        input.fixtureId
      ),

    kickoff:
      input.kickoff ||
      null,

    leagueId:
      input.leagueId ??
      null,

    leagueName:
      input.leagueName ||
      input.competition ||
      null,

    homeTeam:
      input.homeTeam ||
      null,

    awayTeam:
      input.awayTeam ||
      null,

    marketKey:
      normalizeMarketKey(
        input.marketKey
      ),

    marketLabel:
      input.marketLabel ||
      null,

    probability:
      probability !== null
        ? round(
            probability,
            1
          )
        : null,

    impliedProbability:
      calculateImpliedProbability(
        bookmakerOdd
      ),

    decisionScore:
      decisionScore !== null
        ? round(
            decisionScore,
            1
          )
        : null,

    bookmakerOdd:
      bookmakerOdd !== null
        ? round(
            bookmakerOdd,
            2
          )
        : null,

    bookmaker:
      input.bookmaker ||
      null,

    bookmakerSource:
      input.bookmakerSource ||
      null,

    valuePercent,

    kelly: {
      fullPercent:
        eligibility
          .kellyFullPercent,

      fraction:
        mergedConfig
          .fractionalKelly,

      fractionalPercent:
        fractional
          .fractionalKellyPercent,

      cappedPercent:
        fractional
          .cappedKellyPercent,

      suggestedStake,
    },

    eligible:
      eligibility.eligible,

    reasons:
      eligibility.reasons,

    blockingReasons:
      eligibility
        .blockingReasons,

    serviceVersion:
      KELLY_SERVICE_VERSION,
  };
}

function buildDailyKellyBets(
  rows = [],
  {
    bankroll = null,
    includeRejected =
      false,
    config = {},
  } = {}
) {
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  const bets =
    (Array.isArray(rows)
      ? rows
      : []
    )
      .map((row) =>
        buildKellyBet(
          row,
          {
            bankroll,
            config:
              mergedConfig,
          }
        )
      )
      .filter(
        (bet) =>
          includeRejected ||
          bet.eligible
      )
      .sort(
        (
          first,
          second
        ) =>
          Number(
            second
              .kelly
              .cappedPercent ||
              0
          ) -
            Number(
              first
                .kelly
                .cappedPercent ||
                0
            ) ||
          Number(
            second
              .decisionScore ||
              0
          ) -
            Number(
              first
                .decisionScore ||
                0
            ) ||
          Number(
            second
              .valuePercent ||
              0
          ) -
            Number(
              first
                .valuePercent ||
                0
            )
      )
      .slice(
        0,
        mergedConfig
          .maximumBets
      );

  return {
    version:
      KELLY_SERVICE_VERSION,

    config:
      mergedConfig,

    count:
      bets.length,

    bets,
  };
}

module.exports = {
  KELLY_SERVICE_VERSION,
  DEFAULT_CONFIG,

  calculateKelly,
  calculateValuePercent,
  calculateImpliedProbability,
  calculateFractionalKelly,
  calculateStake,
  evaluateKellyEligibility,
  buildKellyBet,
  buildDailyKellyBets,
};