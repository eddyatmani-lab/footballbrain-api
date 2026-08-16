const LOTOFOOT_VERSION =
  "lotofoot-engine-v1.7.2-settlement-engine";

const LOTOFOOT_MODE =
  "ACTIVE_CONTROLLED";

const SUPPORTED_GRID_TYPES =
  new Set([
    "LF7",
    "LF8",
    "LF12",
    "LF15",
  ]);

function numberOr(
  value,
  fallback = 0
) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function normalizeGridType(
  value
) {
  const normalized =
    String(value || "")
      .trim()
      .toUpperCase()
      .replace(
        /^LOTO[\s_-]*FOOT[\s_-]*/,
        "LF"
      )
      .replace(
        /^LF[\s_-]*/,
        "LF"
      );

  return SUPPORTED_GRID_TYPES.has(
    normalized
  )
    ? normalized
    : null;
}

function normalizePick(
  value
) {
  const normalized =
    String(value || "")
      .trim()
      .toUpperCase();

  if (
    normalized === "1" ||
    normalized === "N" ||
    normalized === "2"
  ) {
    return normalized;
  }

  return null;
}

function clamp(
  value,
  minimum = 0,
  maximum = 100
) {
  return Math.max(
    minimum,
    Math.min(
      maximum,
      numberOr(value)
    )
  );
}

function normalizeProbabilityTriple({
  home,
  draw,
  away,
}) {
  const values = {
    home: Math.max(
      0,
      numberOr(home)
    ),
    draw: Math.max(
      0,
      numberOr(draw)
    ),
    away: Math.max(
      0,
      numberOr(away)
    ),
  };

  const total =
    values.home +
    values.draw +
    values.away;

  if (total <= 0) {
    return {
      home: 0,
      draw: 0,
      away: 0,
    };
  }

  return {
    home: Number(
      (
        values.home /
        total *
        100
      ).toFixed(2)
    ),

    draw: Number(
      (
        values.draw /
        total *
        100
      ).toFixed(2)
    ),

    away: Number(
      (
        values.away /
        total *
        100
      ).toFixed(2)
    ),
  };
}


const GRID_LINE_RULES = {
  LF7: {
    standard: 7,
    allowed: [6, 7],
  },
  LF8: {
    standard: 8,
    allowed: [7, 8],
  },
  LF12: {
    standard: 12,
    allowed: [9, 10, 11, 12],
  },
  LF15: {
    standard: 15,
    allowed: [12, 13, 14, 15],
  },
};

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function nullablePercent(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  if (
    !Number.isFinite(number) ||
    number < 0 ||
    number > 100
  ) {
    return NaN;
  }

  return Number(number.toFixed(2));
}

function validateManualGridPayload(payload) {
  const gridType =
    normalizeGridType(
      payload?.gridType
    );

  if (!gridType) {
    throw new Error(
      "gridType invalide. Valeurs acceptées : LF7, LF8, LF12, LF15."
    );
  }

  const matches =
    Array.isArray(payload?.matches)
      ? payload.matches
      : [];

  const rule =
    GRID_LINE_RULES[gridType];

  if (
    !rule.allowed.includes(
      matches.length
    )
  ) {
    throw new Error(
      `${gridType} : ${matches.length} lignes reçues. Nombre autorisé : ${rule.allowed.join(", ")}.`
    );
  }

  const seen =
    new Set();

  const normalizedMatches =
    matches.map(
      (match, index) => {
        const lineNumber =
          Number(
            match?.lineNumber ??
            index + 1
          );

        if (
          !Number.isInteger(
            lineNumber
          ) ||
          lineNumber <= 0
        ) {
          throw new Error(
            `Ligne ${index + 1} : lineNumber invalide.`
          );
        }

        if (
          seen.has(lineNumber)
        ) {
          throw new Error(
            `lineNumber ${lineNumber} présent plusieurs fois.`
          );
        }

        seen.add(lineNumber);

        const homeTeam =
          normalizeText(
            match?.homeTeam
          );

        const awayTeam =
          normalizeText(
            match?.awayTeam
          );

        if (
          !homeTeam ||
          !awayTeam
        ) {
          throw new Error(
            `Ligne ${lineNumber} : les deux équipes sont obligatoires.`
          );
        }

        const publicData =
          match?.public || {};

        const homePercent =
          nullablePercent(
            publicData["1"] ??
            match?.publicHomePercent
          );

        const drawPercent =
          nullablePercent(
            publicData["N"] ??
            publicData["n"] ??
            match?.publicDrawPercent
          );

        const awayPercent =
          nullablePercent(
            publicData["2"] ??
            match?.publicAwayPercent
          );

        if (
          Number.isNaN(homePercent) ||
          Number.isNaN(drawPercent) ||
          Number.isNaN(awayPercent)
        ) {
          throw new Error(
            `Ligne ${lineNumber} : pourcentage public invalide (0 à 100 attendu).`
          );
        }

        const percentages =
          [
            homePercent,
            drawPercent,
            awayPercent,
          ];

        const provided =
          percentages.filter(
            (value) =>
              value !== null
          );

        if (
          provided.length !== 0 &&
          provided.length !== 3
        ) {
          throw new Error(
            `Ligne ${lineNumber} : renseigne les 3 pourcentages publics 1/N/2 ou aucun.`
          );
        }

        if (
          provided.length === 3
        ) {
          const sum =
            provided.reduce(
              (total, value) =>
                total + value,
              0
            );

          if (
            Math.abs(
              sum - 100
            ) > 2
          ) {
            throw new Error(
              `Ligne ${lineNumber} : les pourcentages publics totalisent ${sum.toFixed(2)} %, attendu environ 100 %.`
            );
          }
        }

        return {
          lineNumber,
          homeTeam,
          awayTeam,
          fixtureId:
            match?.fixtureId
              ? Number(
                  match.fixtureId
                )
              : null,
          fixtureDate:
            match?.fixtureDate ||
            null,
          leagueId:
            match?.leagueId
              ? Number(
                  match.leagueId
                )
              : null,
          leagueName:
            normalizeText(
              match?.leagueName
            ) || null,
          publicHomePercent:
            homePercent,
          publicDrawPercent:
            drawPercent,
          publicAwayPercent:
            awayPercent,
          metadata:
            match?.metadata &&
            typeof match.metadata ===
              "object"
              ? match.metadata
              : {},
        };
      }
    );

  normalizedMatches.sort(
    (a, b) =>
      a.lineNumber -
      b.lineNumber
  );

  return {
    gridType,
    officialGridNumber:
      normalizeText(
        payload?.officialGridNumber
      ) || null,
    title:
      normalizeText(
        payload?.title
      ) || null,
    deadlineAt:
      payload?.deadlineAt ||
      null,
    unitStake:
      Number.isFinite(
        Number(
          payload?.unitStake
        )
      )
        ? Number(
            payload.unitStake
          )
        : 1,
    metadata:
      payload?.metadata &&
      typeof payload.metadata ===
        "object"
        ? payload.metadata
        : {},
    matches:
      normalizedMatches,
  };
}


function normalizeTeamNameForMatch(
  value
) {
  return String(value || "")
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .replace(
      /\b(fc|afc|sc|ac|as|rc|cf|club|football|foot)\b/g,
      " "
    )
    .replace(
      /[^a-z0-9]+/g,
      " "
    )
    .trim()
    .replace(/\s+/g, " ");
}

function teamNameSimilarity(
  expected,
  candidate
) {
  const a =
    normalizeTeamNameForMatch(
      expected
    );

  const b =
    normalizeTeamNameForMatch(
      candidate
    );

  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 100;
  }

  if (
    a.includes(b) ||
    b.includes(a)
  ) {
    const shortest =
      Math.min(
        a.length,
        b.length
      );

    const longest =
      Math.max(
        a.length,
        b.length
      );

    return Math.max(
      82,
      Math.round(
        shortest /
        Math.max(1, longest) *
        100
      )
    );
  }

  const tokensA =
    new Set(
      a.split(" ")
        .filter(Boolean)
    );

  const tokensB =
    new Set(
      b.split(" ")
        .filter(Boolean)
    );

  const union =
    new Set([
      ...tokensA,
      ...tokensB,
    ]);

  let intersection = 0;

  for (
    const token of tokensA
  ) {
    if (
      tokensB.has(token)
    ) {
      intersection += 1;
    }
  }

  if (union.size === 0) {
    return 0;
  }

  const jaccard =
    intersection /
    union.size *
    100;

  return Math.round(
    jaccard
  );
}

function fixtureMatchScore(
  lotoMatch,
  fixture
) {
  const homeScore =
    teamNameSimilarity(
      lotoMatch?.home_team_name,
      fixture?.teams?.home?.name
    );

  const awayScore =
    teamNameSimilarity(
      lotoMatch?.away_team_name,
      fixture?.teams?.away?.name
    );

  const direct =
    homeScore * 0.5 +
    awayScore * 0.5;

  const reverseHome =
    teamNameSimilarity(
      lotoMatch?.home_team_name,
      fixture?.teams?.away?.name
    );

  const reverseAway =
    teamNameSimilarity(
      lotoMatch?.away_team_name,
      fixture?.teams?.home?.name
    );

  const reversed =
    reverseHome * 0.5 +
    reverseAway * 0.5;

  return {
    score:
      Math.round(
        Math.max(
          direct,
          reversed * 0.9
        )
      ),

    orientation:
      direct >= reversed
        ? "DIRECT"
        : "REVERSED",

    homeScore:
      Math.round(homeScore),

    awayScore:
      Math.round(awayScore),
  };
}

function formatParisDate(
  value
) {
  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  const formatter =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          "Europe/Paris",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    );

  return formatter.format(date);
}

function addCalendarDays(
  dateString,
  days
) {
  const date =
    new Date(
      `${dateString}T12:00:00Z`
    );

  date.setUTCDate(
    date.getUTCDate() +
    days
  );

  return date
    .toISOString()
    .slice(0, 10);
}


function roundScore(
  value
) {
  return Number(
    clamp(
      value,
      0,
      100
    ).toFixed(2)
  );
}

function probabilityMapFromRow(
  row = {}
) {
  return normalizeProbabilityTriple({
    home:
      row.home_probability,
    draw:
      row.draw_probability,
    away:
      row.away_probability,
  });
}

function rankedOutcomes(
  probabilities
) {
  return [
    {
      pick: "1",
      probability:
        numberOr(
          probabilities?.home
        ),
    },
    {
      pick: "N",
      probability:
        numberOr(
          probabilities?.draw
        ),
    },
    {
      pick: "2",
      probability:
        numberOr(
          probabilities?.away
        ),
    },
  ].sort(
    (a, b) =>
      b.probability -
      a.probability
  );
}

function buildDoubleSelection(
  ranking
) {
  if (
    !Array.isArray(ranking) ||
    ranking.length < 2
  ) {
    return null;
  }

  const picks =
    [
      ranking[0]?.pick,
      ranking[1]?.pick,
    ].filter(Boolean);

  const order = {
    "1": 1,
    "N": 2,
    "2": 3,
  };

  picks.sort(
    (a, b) =>
      order[a] -
      order[b]
  );

  return picks.join("");
}

function computeLotoFootScores({
  probabilities,
  confidence = null,
  risk = null,
} = {}) {
  const normalized =
    normalizeProbabilityTriple(
      probabilities || {}
    );

  const ranking =
    rankedOutcomes(
      normalized
    );

  const favorite =
    ranking[0];

  const second =
    ranking[1];

  const third =
    ranking[2];

  const favoriteProbability =
    numberOr(
      favorite?.probability
    );

  const secondProbability =
    numberOr(
      second?.probability
    );

  const margin =
    Math.max(
      0,
      favoriteProbability -
      secondProbability
    );

  const drawProbability =
    numberOr(
      normalized.draw
    );

  const secondaryMass =
    Math.max(
      0,
      100 -
      favoriteProbability
    );

  const normalizedConfidence =
    Number.isFinite(
      Number(confidence)
    )
      ? clamp(
          Number(confidence),
          0,
          100
        )
      : 50;

  const normalizedRiskText =
    String(risk || "")
      .trim()
      .toLowerCase();

  let riskPenalty = 0;

  if (
    normalizedRiskText.includes(
      "élev"
    ) ||
    normalizedRiskText.includes(
      "elev"
    )
  ) {
    riskPenalty = 12;
  } else if (
    normalizedRiskText.includes(
      "mod"
    )
  ) {
    riskPenalty = 6;
  } else if (
    normalizedRiskText.includes(
      "faible"
    )
  ) {
    riskPenalty = 0;
  }

  /*
   * BASE SCORE
   *
   * Favorise :
   * - une probabilité du choix principal élevée ;
   * - un écart clair avec la deuxième issue ;
   * - une confiance FootballBrain élevée.
   *
   * Le risque global retire quelques points.
   */
  const baseScore =
    roundScore(
      favoriteProbability * 0.58 +
      margin * 0.82 +
      normalizedConfidence * 0.18 -
      riskPenalty
    );

  /*
   * TRAP SCORE
   *
   * Plus le match est équilibré, plus le piège augmente.
   * Le nul élevé est explicitement valorisé car il casse souvent
   * les grilles construites uniquement autour des favoris.
   */
  const closeness =
    100 -
    clamp(
      margin * 3.2,
      0,
      100
    );

  const trapScore =
    roundScore(
      closeness * 0.52 +
      drawProbability * 0.78 +
      secondaryMass * 0.34 +
      riskPenalty * 1.4
    );

  /*
   * COVER SCORE
   *
   * Mesure l'intérêt d'investir une protection sur cette ligne.
   * Le score dépend du Trap Score, de la masse des issues secondaires
   * et de la faiblesse du choix principal.
   */
  const coverScore =
    roundScore(
      trapScore * 0.58 +
      secondaryMass * 0.44 +
      (
        100 -
        favoriteProbability
      ) * 0.24
    );

  /*
   * SURPRISE SCORE
   *
   * Probabilité qu'une issue autre que le choix principal sorte,
   * légèrement renforcée quand le troisième scénario reste crédible.
   */
  const surpriseScore =
    roundScore(
      secondaryMass * 0.82 +
      numberOr(
        third?.probability
      ) * 0.28
    );

  let recommendedCover =
    "SIMPLE";

  if (
    coverScore >= 78 ||
    favoriteProbability < 40
  ) {
    recommendedCover =
      "TRIPLE";
  } else if (
    coverScore >= 55 ||
    favoriteProbability < 50
  ) {
    recommendedCover =
      "DOUBLE";
  }

  let recommendedSelection =
    favorite?.pick ||
    null;

  if (
    recommendedCover ===
    "DOUBLE"
  ) {
    recommendedSelection =
      buildDoubleSelection(
        ranking
      );
  } else if (
    recommendedCover ===
    "TRIPLE"
  ) {
    recommendedSelection =
      "1N2";
  }

  return {
    probabilities:
      normalized,

    ranking,

    aiPick:
      favorite?.pick ||
      null,

    favoriteProbability:
      Number(
        favoriteProbability
          .toFixed(2)
      ),

    margin:
      Number(
        margin.toFixed(2)
      ),

    baseScore,
    trapScore,
    coverScore,
    surpriseScore,

    recommendedCover,
    recommendedSelection,
  };
}


function selectionProbability(
  row,
  selection
) {
  const probabilities = {
    "1": numberOr(
      row?.footballbrain_home_probability
    ),
    "N": numberOr(
      row?.footballbrain_draw_probability
    ),
    "2": numberOr(
      row?.footballbrain_away_probability
    ),
  };

  const normalized =
    String(selection || "")
      .toUpperCase();

  let total = 0;

  for (const pick of ["1", "N", "2"]) {
    if (normalized.includes(pick)) {
      total += probabilities[pick];
    }
  }

  return Math.max(
    0,
    Math.min(
      100,
      total
    )
  );
}

function normalizeSelection(
  value
) {
  const normalized =
    String(value || "")
      .trim()
      .toUpperCase();

  const allowed = new Set([
    "1",
    "N",
    "2",
    "1N",
    "12",
    "N2",
    "1N2",
  ]);

  return allowed.has(normalized)
    ? normalized
    : null;
}

function selectionCombinationFactor(
  selection
) {
  const normalized =
    normalizeSelection(
      selection
    );

  if (!normalized) {
    return 1;
  }

  if (normalized === "1N2") {
    return 3;
  }

  if (
    normalized === "1N" ||
    normalized === "12" ||
    normalized === "N2"
  ) {
    return 2;
  }

  return 1;
}

function buildSelectionCandidates(
  prediction
) {
  const probabilities = {
    "1": numberOr(
      prediction
        ?.footballbrain_home_probability
    ),
    "N": numberOr(
      prediction
        ?.footballbrain_draw_probability
    ),
    "2": numberOr(
      prediction
        ?.footballbrain_away_probability
    ),
  };

  const ranking = [
    {
      pick: "1",
      probability:
        probabilities["1"],
    },
    {
      pick: "N",
      probability:
        probabilities["N"],
    },
    {
      pick: "2",
      probability:
        probabilities["2"],
    },
  ].sort(
    (a, b) =>
      b.probability -
      a.probability
  );

  const first =
    ranking[0]?.pick;

  const second =
    ranking[1]?.pick;

  const order = {
    "1": 1,
    "N": 2,
    "2": 3,
  };

  const double =
    [first, second]
      .filter(Boolean)
      .sort(
        (a, b) =>
          order[a] -
          order[b]
      )
      .join("");

  const candidates = [
    first,
    double,
    "1N2",
  ]
    .map(
      normalizeSelection
    )
    .filter(Boolean);

  const unique =
    [...new Set(candidates)];

  return unique.map(
    (selection) => ({
      selection,

      factor:
        selectionCombinationFactor(
          selection
        ),

      coverageProbability:
        Number(
          selectionProbability(
            prediction,
            selection
          ).toFixed(4)
        ),
    })
  );
}

function gridProbabilityScore(
  coverageProbabilities
) {
  /*
   * Probabilité théorique d'une couverture parfaite si l'on suppose
   * les lignes indépendantes.
   *
   * On travaille en log pour éviter les sous-flux numériques.
   */
  let logProbability = 0;

  for (
    const probability of
    coverageProbabilities
  ) {
    const p =
      Math.max(
        0.000001,
        Math.min(
          0.999999,
          numberOr(probability) /
          100
        )
      );

    logProbability +=
      Math.log(p);
  }

  return Math.exp(
    logProbability
  );
}

function optimizeGridSelections({
  predictions,
  maxCombinations,
} = {}) {
  const rows =
    Array.isArray(predictions)
      ? predictions
      : [];

  const budget =
    Math.max(
      1,
      Math.floor(
        numberOr(
          maxCombinations,
          1
        )
      )
    );

  if (
    rows.length === 0
  ) {
    return {
      combinations: 0,
      theoreticalHitProbability: 0,
      lines: [],
    };
  }

  const candidateSets =
    rows.map(
      (row) => ({
        row,
        candidates:
          buildSelectionCandidates(
            row
          ),
      })
    );

  /*
   * Dynamic Programming.
   *
   * État :
   * - nombre de combinaisons déjà utilisées
   * - meilleur log-probability obtenu
   *
   * On garde un seul meilleur chemin pour chaque coût exact.
   */
  let states =
    new Map();

  states.set(
    1,
    {
      combinations: 1,
      logProbability: 0,
      selections: [],
    }
  );

  for (
    const entry of
    candidateSets
  ) {
    const next =
      new Map();

    for (
      const state of
      states.values()
    ) {
      for (
        const candidate of
        entry.candidates
      ) {
        const newCombinations =
          state.combinations *
          candidate.factor;

        if (
          newCombinations >
          budget
        ) {
          continue;
        }

        const p =
          Math.max(
            0.000001,
            Math.min(
              0.999999,
              candidate
                .coverageProbability /
              100
            )
          );

        const newState = {
          combinations:
            newCombinations,

          logProbability:
            state.logProbability +
            Math.log(p),

          selections: [
            ...state.selections,
            {
              prediction:
                entry.row,

              selection:
                candidate.selection,

              factor:
                candidate.factor,

              coverageProbability:
                candidate
                  .coverageProbability,
            },
          ],
        };

        const existing =
          next.get(
            newCombinations
          );

        if (
          !existing ||
          newState.logProbability >
            existing.logProbability
        ) {
          next.set(
            newCombinations,
            newState
          );
        }
      }
    }

    states = next;
  }

  if (
    states.size === 0
  ) {
    return {
      combinations: 0,
      theoreticalHitProbability: 0,
      lines: [],
    };
  }

  const best =
    [...states.values()]
      .sort(
        (a, b) => {
          const probabilityDiff =
            b.logProbability -
            a.logProbability;

          if (
            Math.abs(
              probabilityDiff
            ) >
            1e-12
          ) {
            return probabilityDiff;
          }

          /*
           * À probabilité identique, on préfère la grille la moins chère.
           */
          return (
            a.combinations -
            b.combinations
          );
        }
      )[0];

  return {
    combinations:
      best.combinations,

    theoreticalHitProbability:
      Number(
        (
          Math.exp(
            best.logProbability
          ) *
          100
        ).toFixed(6)
      ),

    lines:
      best.selections.map(
        (item) => ({
          lineNumber:
            Number(
              item.prediction
                ?.line_number
            ),

          fixtureId:
            Number(
              item.prediction
                ?.fixture_id
            ),

          homeTeam:
            item.prediction
              ?.home_team_name,

          awayTeam:
            item.prediction
              ?.away_team_name,

          aiPick:
            item.prediction
              ?.ai_pick,

          selection:
            item.selection,

          factor:
            item.factor,

          coveredProbability:
            item.coverageProbability,

          baseScore:
            numberOr(
              item.prediction
                ?.base_score
            ),

          trapScore:
            numberOr(
              item.prediction
                ?.trap_score
            ),

          coverScore:
            numberOr(
              item.prediction
                ?.cover_score
            ),

          surpriseScore:
            numberOr(
              item.prediction
                ?.surprise_score
            ),
        })
      ),
  };
}


const LOTOFOOT_STRATEGIES = {
  PRUDENT: {
    label: "PRUDENTE",
    objective:
      "MAX_HIT_PROBABILITY",
    budgetShare: 1,
    description:
      "Utilise jusqu'à 100 % du budget pour maximiser la probabilité théorique de couvrir toute la grille.",
  },

  BALANCED: {
    label: "ÉQUILIBRÉE",
    objective:
      "BALANCED_COVERAGE_COST",
    budgetShare: 0.75,
    description:
      "Utilise environ 75 % du budget et privilégie la dispersion des protections : les doubles prioritaires passent avant un triple, sauf si celui-ci concerne une ligne de toute première priorité.",
  },

  OFFENSIVE: {
    label: "OFFENSIVE",
    objective:
      "SELECTIVE_PROTECTION",
    budgetShare: 0.5,
    description:
      "N'utilise qu'environ 50 % du budget maximum : davantage de bases sont assumées et seules les protections les plus rentables sont conservées.",
  },
};

function normalizeStrategy(
  value
) {
  const normalized =
    String(
      value || "PRUDENT"
    )
      .trim()
      .toUpperCase()
      .replace(
        /É/g,
        "E"
      );

  if (
    normalized === "PRUDENT" ||
    normalized === "PRUDENTE"
  ) {
    return "PRUDENT";
  }

  if (
    normalized === "BALANCED" ||
    normalized === "EQUILIBRE" ||
    normalized === "EQUILIBREE"
  ) {
    return "BALANCED";
  }

  if (
    normalized === "OFFENSIVE" ||
    normalized === "OFFENSIF"
  ) {
    return "OFFENSIVE";
  }

  return "PRUDENT";
}

function strategyCandidateUtility({
  coverageProbability,
  factor = 1,
  strategy = "PRUDENT",
  prediction = {},
}) {
  const p = Math.max(
    0.000001,
    Math.min(0.999999, numberOr(coverageProbability) / 100)
  );

  const normalizedStrategy = normalizeStrategy(strategy);
  const costPenalty = Math.log(Math.max(1, numberOr(factor, 1)));
  const trap = clampScore(prediction?.trap_score) / 100;
  const cover = clampScore(prediction?.cover_score) / 100;
  const surprise = clampScore(prediction?.surprise_score) / 100;

  if (normalizedStrategy === "BALANCED") {
    // Couverture forte, mais pénalise explicitement la complexité/coût.
    return Math.log(p) - costPenalty * 0.12 + (trap + cover) * 0.015;
  }

  if (normalizedStrategy === "OFFENSIVE") {
    // Assume davantage les bases : une protection doit apporter une vraie valeur
    // sur une ligne piégeuse pour justifier son coût combinatoire.
    return Math.log(p) - costPenalty * 0.28 +
      (trap * 0.018 + cover * 0.012 + surprise * 0.01) *
      Math.max(0, numberOr(factor, 1) - 1);
  }

  // PRUDENT : objectif pur de probabilité de grille parfaite.
  return Math.log(p);
}

function computeCoverageDistribution(
  lines = []
) {
  /*
   * Distribution Poisson-binomiale des lignes couvertes.
   * Hypothèse : indépendance entre les matchs.
   *
   * distribution[k] = probabilité d'obtenir exactement k lignes correctes.
   */
  let distribution = [1];

  for (const line of lines) {
    const p =
      Math.max(
        0,
        Math.min(
          1,
          numberOr(
            line?.coveredProbability
          ) / 100
        )
      );

    const next =
      new Array(
        distribution.length + 1
      ).fill(0);

    for (
      let k = 0;
      k < distribution.length;
      k += 1
    ) {
      next[k] +=
        distribution[k] *
        (1 - p);

      next[k + 1] +=
        distribution[k] *
        p;
    }

    distribution = next;
  }

  const totalLines =
    lines.length;

  function exact(k) {
    return Number(
      (
        numberOr(
          distribution[k]
        ) *
        100
      ).toFixed(6)
    );
  }

  function atLeast(k) {
    let total = 0;

    for (
      let index = k;
      index <= totalLines;
      index += 1
    ) {
      total +=
        numberOr(
          distribution[index]
        );
    }

    return Number(
      (
        total * 100
      ).toFixed(6)
    );
  }

  return {
    totalLines,

    exact: {
      perfect:
        exact(totalLines),

      minusOne:
        totalLines >= 1
          ? exact(
              totalLines - 1
            )
          : null,

      minusTwo:
        totalLines >= 2
          ? exact(
              totalLines - 2
            )
          : null,
    },

    atLeast: {
      perfect:
        atLeast(totalLines),

      minusOne:
        totalLines >= 1
          ? atLeast(
              totalLines - 1
            )
          : null,

      minusTwo:
        totalLines >= 2
          ? atLeast(
              totalLines - 2
            )
          : null,
    },
  };
}

function optimizeGridSelectionsByStrategy({
  predictions,
  maxCombinations,
  strategy = "PRUDENT",
} = {}) {
  const normalizedStrategy =
    normalizeStrategy(
      strategy
    );

  const rows =
    Array.isArray(predictions)
      ? predictions
      : [];

  const budget =
    Math.max(
      1,
      Math.floor(
        numberOr(
          maxCombinations,
          1
        )
      )
    );

  if (
    rows.length === 0
  ) {
    return {
      strategy:
        normalizedStrategy,
      combinations: 0,
      theoreticalHitProbability: 0,
      utilityScore: null,
      lines: [],
    };
  }

  /*
   * V1.7.1 — diversification BALANCED
   *
   * Un budget comme 12 combinaisons oblige mathématiquement à utiliser
   * au moins un facteur 3 pour consommer tout le plafond. La V1.7.0 pouvait
   * donc tripler une ligne classée plus bas tout en laissant une priorité
   * supérieure en simple.
   *
   * En BALANCED, les triples sont désormais réservés aux 3 meilleures
   * priorités de protection. Cela conserve la possibilité d'un 3×2×2 = 12
   * tout en garantissant que le triple ne contourne pas les protections
   * les plus importantes. PRUDENT et OFFENSIVE restent inchangés.
   */
  let balancedTripleEligibleLines = null;

  if (normalizedStrategy === "BALANCED") {
    balancedTripleEligibleLines = new Set(
      rows
        .map((row) => buildProtectionPriority(row))
        .sort((a, b) =>
          numberOr(b?.priorityScore) -
          numberOr(a?.priorityScore)
        )
        .slice(0, Math.min(3, rows.length))
        .map((item) => Number(item?.lineNumber))
    );
  }

  const candidateSets =
    rows.map(
      (row) => {
        let candidates =
          buildSelectionCandidates(
            row
          );

        if (
          normalizedStrategy === "BALANCED" &&
          balancedTripleEligibleLines &&
          !balancedTripleEligibleLines.has(
            Number(row?.line_number)
          )
        ) {
          candidates = candidates.filter(
            (candidate) =>
              candidate.factor !== 3
          );
        }

        return {
          row,
          candidates,
        };
      }
    );

  let states =
    new Map();

  states.set(
    1,
    {
      combinations: 1,
      utility: 0,
      logHitProbability: 0,
      selections: [],
    }
  );

  for (
    const entry of
    candidateSets
  ) {
    const next =
      new Map();

    for (
      const state of
      states.values()
    ) {
      for (
        const candidate of
        entry.candidates
      ) {
        const newCombinations =
          state.combinations *
          candidate.factor;

        if (
          newCombinations >
          budget
        ) {
          continue;
        }

        const p =
          Math.max(
            0.000001,
            Math.min(
              0.999999,
              candidate
                .coverageProbability /
              100
            )
          );

        const candidateUtility =
          strategyCandidateUtility({
            coverageProbability:
              candidate
                .coverageProbability,
            factor:
              candidate.factor,
            strategy:
              normalizedStrategy,
            prediction:
              entry.row,
          });

        const newState = {
          combinations:
            newCombinations,

          utility:
            state.utility +
            candidateUtility,

          logHitProbability:
            state.logHitProbability +
            Math.log(p),

          selections: [
            ...state.selections,
            {
              prediction:
                entry.row,

              selection:
                candidate.selection,

              factor:
                candidate.factor,

              coverageProbability:
                candidate
                  .coverageProbability,
            },
          ],
        };

        const existing =
          next.get(
            newCombinations
          );

        if (
          !existing ||
          newState.utility >
            existing.utility
        ) {
          next.set(
            newCombinations,
            newState
          );
        }
      }
    }

    states = next;
  }

  if (
    states.size === 0
  ) {
    return {
      strategy:
        normalizedStrategy,
      combinations: 0,
      theoreticalHitProbability: 0,
      utilityScore: null,
      lines: [],
    };
  }

  const best =
    [...states.values()]
      .sort(
        (a, b) => {
          const utilityDiff =
            b.utility -
            a.utility;

          if (
            Math.abs(
              utilityDiff
            ) >
            1e-12
          ) {
            return utilityDiff;
          }

          const hitDiff =
            b.logHitProbability -
            a.logHitProbability;

          if (
            Math.abs(
              hitDiff
            ) >
            1e-12
          ) {
            return hitDiff;
          }

          return (
            a.combinations -
            b.combinations
          );
        }
      )[0];

  return {
    strategy:
      normalizedStrategy,

    strategyLabel:
      LOTOFOOT_STRATEGIES[
        normalizedStrategy
      ]?.label ||
      normalizedStrategy,

    objective:
      LOTOFOOT_STRATEGIES[
        normalizedStrategy
      ]?.objective ||
      null,

    combinations:
      best.combinations,

    theoreticalHitProbability:
      Number(
        (
          Math.exp(
            best.logHitProbability
          ) *
          100
        ).toFixed(6)
      ),

    utilityScore:
      Number(
        best.utility
          .toFixed(8)
      ),

    lines:
      best.selections.map(
        (item) => ({
          lineNumber:
            Number(
              item.prediction
                ?.line_number
            ),

          fixtureId:
            Number(
              item.prediction
                ?.fixture_id
            ),

          homeTeam:
            item.prediction
              ?.home_team_name,

          awayTeam:
            item.prediction
              ?.away_team_name,

          aiPick:
            item.prediction
              ?.ai_pick,

          selection:
            item.selection,

          factor:
            item.factor,

          coveredProbability:
            item.coverageProbability,

          baseScore:
            numberOr(
              item.prediction
                ?.base_score
            ),

          trapScore:
            numberOr(
              item.prediction
                ?.trap_score
            ),

          coverScore:
            numberOr(
              item.prediction
                ?.cover_score
            ),

          surpriseScore:
            numberOr(
              item.prediction
                ?.surprise_score
            ),
        })
      ),
  };
}

function buildProtectionPriority(
  prediction
) {
  const candidates =
    buildSelectionCandidates(
      prediction
    );

  const simple = candidates.find((item) => item.factor === 1);
  const double = candidates.find((item) => item.factor === 2);
  const triple = candidates.find((item) => item.factor === 3);

  const simpleProbability = numberOr(simple?.coverageProbability);
  const doubleProbability = numberOr(double?.coverageProbability, simpleProbability);
  const tripleProbability = numberOr(triple?.coverageProbability, 100);

  const doubleGain = Math.max(0, doubleProbability - simpleProbability);
  const tripleGainFromDouble = Math.max(0, tripleProbability - doubleProbability);

  // Le classement suit désormais le gain marginal multiplicatif réellement
  // utilisé par l'optimiseur : log(Pnouvelle / Pancienne), rapporté au coût.
  const safeSimple = Math.max(0.000001, simpleProbability / 100);
  const safeDouble = Math.max(safeSimple, doubleProbability / 100);
  const safeTriple = Math.max(safeDouble, tripleProbability / 100);

  const doubleLogGain = Math.max(0, Math.log(safeDouble / safeSimple));
  const tripleLogGain = Math.max(0, Math.log(safeTriple / safeDouble));
  const doubleCostLog = Math.log(2);
  const tripleIncrementalCostLog = Math.log(3 / 2);

  const doubleEfficiency = doubleCostLog > 0
    ? doubleLogGain / doubleCostLog
    : 0;
  const tripleEfficiency = tripleIncrementalCostLog > 0
    ? tripleLogGain / tripleIncrementalCostLog
    : 0;

  // 100 signifie qu'un double augmente la couverture aussi vite que son coût
  // combinatoire (ratio idéal proche de x2 pour un coût x2). Pas de saturation
  // heuristique liée aux anciens Trap/Cover scores.
  const priorityScore = Number((doubleEfficiency * 100).toFixed(4));

  let stars = 1;
  if (priorityScore >= 95) stars = 5;
  else if (priorityScore >= 85) stars = 4;
  else if (priorityScore >= 70) stars = 3;
  else if (priorityScore >= 50) stars = 2;

  return {
    lineNumber: Number(prediction?.line_number),
    fixtureId: Number(prediction?.fixture_id),
    homeTeam: prediction?.home_team_name,
    awayTeam: prediction?.away_team_name,
    aiPick: prediction?.ai_pick,
    baseSelection: simple?.selection || prediction?.ai_pick || null,
    bestDouble: double?.selection || null,
    simpleProbability: Number(simpleProbability.toFixed(2)),
    doubleProbability: Number(doubleProbability.toFixed(2)),
    tripleProbability: Number(tripleProbability.toFixed(2)),
    doubleGain: Number(doubleGain.toFixed(2)),
    tripleGainFromDouble: Number(tripleGainFromDouble.toFixed(2)),
    relativeDoubleGain: Number(
      (simpleProbability > 0 ? doubleGain / simpleProbability * 100 : 0).toFixed(2)
    ),
    marginalMultiplier: Number(
      (simpleProbability > 0 ? doubleProbability / simpleProbability : 0).toFixed(4)
    ),
    doubleEfficiency: Number(doubleEfficiency.toFixed(6)),
    tripleEfficiency: Number(tripleEfficiency.toFixed(6)),
    priorityScore,
    stars,
    trapScore: numberOr(prediction?.trap_score),
    coverScore: numberOr(prediction?.cover_score),
  };
}

function clampScore(
  value
) {
  return Math.max(
    0,
    Math.min(
      100,
      numberOr(value)
    )
  );
}

function classifyGridLine(
  prediction
) {
  /*
   * favoriteProbability et margin ne sont pas des colonnes SQL dédiées
   * de lotofoot_predictions : ils sont conservés dans
   * prediction_payload.scoring depuis la V1.3.
   *
   * V1.6 lisait par erreur prediction.favorite_probability / prediction.margin,
   * donc 0/0 pour toutes les lignes et classait toute la grille MAJOR_TRAP.
   */
  const scoringPayload =
    prediction
      ?.prediction_payload
      ?.scoring ||
    {};

  const probabilities = {
    home:
      numberOr(
        prediction
          ?.footballbrain_home_probability
      ),

    draw:
      numberOr(
        prediction
          ?.footballbrain_draw_probability
      ),

    away:
      numberOr(
        prediction
          ?.footballbrain_away_probability
      ),
  };

  const ranking =
    rankedOutcomes(
      probabilities
    );

  const fallbackFavorite =
    numberOr(
      ranking?.[0]
        ?.probability
    );

  const fallbackMargin =
    Math.max(
      0,
      numberOr(
        ranking?.[0]
          ?.probability
      ) -
      numberOr(
        ranking?.[1]
          ?.probability
      )
    );

  const favoriteProbability =
    numberOr(
      scoringPayload
        ?.favoriteProbability,
      fallbackFavorite
    );

  const margin =
    numberOr(
      scoringPayload
        ?.margin,
      fallbackMargin
    );

  const trapScore =
    numberOr(
      prediction
        ?.trap_score
    );

  const coverScore =
    numberOr(
      prediction
        ?.cover_score
    );

  let category =
    "OPEN_MATCH";

  if (
    favoriteProbability >= 52 &&
    margin >= 18 &&
    trapScore < 60
  ) {
    category =
      "STRONG_BASE";
  } else if (
    trapScore >= 80 ||
    coverScore >= 85 ||
    margin <= 8
  ) {
    category =
      "MAJOR_TRAP";
  }

  return {
    lineNumber:
      Number(
        prediction
          ?.line_number
      ),

    fixtureId:
      Number(
        prediction
          ?.fixture_id
      ),

    homeTeam:
      prediction
        ?.home_team_name,

    awayTeam:
      prediction
        ?.away_team_name,

    aiPick:
      prediction
        ?.ai_pick,

    category,

    favoriteProbability:
      roundScore(
        favoriteProbability
      ),

    margin:
      roundScore(
        margin
      ),

    baseScore:
      numberOr(
        prediction
          ?.base_score
      ),

    trapScore,

    coverScore,
  };
}

function buildGridDifficulty(
  predictions
) {
  const rows =
    Array.isArray(predictions)
      ? predictions
      : [];

  if (!rows.length) {
    return {
      score: 0,
      label: "UNKNOWN",
      strongBases: 0,
      openMatches: 0,
      majorTraps: 0,
      lines: [],
    };
  }

  const lines =
    rows.map(
      classifyGridLine
    );

  const averageTrap =
    lines.reduce(
      (sum, line) =>
        sum +
        numberOr(
          line.trapScore
        ),
      0
    ) /
    lines.length;

  const averageCover =
    lines.reduce(
      (sum, line) =>
        sum +
        numberOr(
          line.coverScore
        ),
      0
    ) /
    lines.length;

  const averageUncertainty =
    lines.reduce(
      (sum, line) =>
        sum +
        (
          100 -
          clampScore(
            line
              .favoriteProbability
          )
        ),
      0
    ) /
    lines.length;

  const majorTraps =
    lines.filter(
      (line) =>
        line.category ===
        "MAJOR_TRAP"
    ).length;

  const strongBases =
    lines.filter(
      (line) =>
        line.category ===
        "STRONG_BASE"
    ).length;

  const openMatches =
    lines.length -
    majorTraps -
    strongBases;

  const trapDensity =
    majorTraps /
    lines.length *
    100;

  const score =
    roundScore(
      averageTrap *
        0.32 +
      averageCover *
        0.28 +
      averageUncertainty *
        0.22 +
      trapDensity *
        0.18
    );

  let label =
    "MEDIUM";

  if (score >= 75) {
    label = "VERY_HARD";
  } else if (score >= 60) {
    label = "HARD";
  } else if (score < 40) {
    label = "EASY";
  }

  return {
    score,
    label,
    strongBases,
    openMatches,
    majorTraps,
    averageTrap:
      roundScore(
        averageTrap
      ),
    averageCover:
      roundScore(
        averageCover
      ),
    lines,
  };
}

function buildBudgetEfficiencyCurve({
  predictions,
  unitStake = 1,
  budgets = [],
} = {}) {
  const stake =
    Math.max(
      0.01,
      numberOr(
        unitStake,
        1
      )
    );

  const safeBudgets =
    [...new Set(
      budgets
        .map(
          (value) =>
            Math.max(
              stake,
              numberOr(
                value,
                stake
              )
            )
        )
        .sort(
          (a, b) =>
            a - b
        )
    )];

  const points = [];

  for (
    const budget of
    safeBudgets
  ) {
    const maxCombinations =
      Math.max(
        1,
        Math.floor(
          budget /
          stake
        )
      );

    const result =
      optimizeGridSelections({
        predictions,
        maxCombinations,
      });

    const usedBudget =
      Number(
        (
          result.combinations *
          stake
        ).toFixed(2)
      );

    points.push({
      requestedBudget:
        Number(
          budget.toFixed(2)
        ),

      usedBudget,

      combinations:
        result.combinations,

      theoreticalHitProbability:
        result
          .theoreticalHitProbability,
    });
  }

  return points.map(
    (
      point,
      index
    ) => {
      const previous =
        index > 0
          ? points[index - 1]
          : null;

      const probabilityGain =
        previous
          ? Number(
              (
                point
                  .theoreticalHitProbability -
                previous
                  .theoreticalHitProbability
              ).toFixed(6)
            )
          : null;

      const extraCost =
        previous
          ? Number(
              (
                point.usedBudget -
                previous.usedBudget
              ).toFixed(2)
            )
          : null;

      const gainPerEuro =
        previous &&
        extraCost > 0
          ? Number(
              (
                probabilityGain /
                extraCost
              ).toFixed(6)
            )
          : null;

      return {
        ...point,
        probabilityGain,
        extraCost,
        gainPerEuro,
      };
    }
  );
}

function recommendGridStrategy({
  strategies,
  difficulty,
} = {}) {
  const prudent =
    strategies
      ?.PRUDENT;

  const balanced =
    strategies
      ?.BALANCED;

  const offensive =
    strategies
      ?.OFFENSIVE;

  if (
    !prudent ||
    !balanced ||
    !offensive
  ) {
    return null;
  }

  const difficultyScore =
    numberOr(
      difficulty
        ?.score
    );

  /*
   * On ne choisit pas uniquement la meilleure probabilité :
   * - grille très difficile -> Prudente
   * - grille moyenne/difficile -> Équilibrée si elle conserve une part
   *   suffisante de la probabilité Prudente
   * - grille facile -> Offensive si le sacrifice probabiliste reste contenu.
   */
  const balancedRetention =
    numberOr(
      prudent
        .theoreticalHitProbability
    ) > 0
      ? (
          numberOr(
            balanced
              .theoreticalHitProbability
          ) /
          numberOr(
            prudent
              .theoreticalHitProbability
          )
        ) *
        100
      : 0;

  const offensiveRetention =
    numberOr(
      prudent
        .theoreticalHitProbability
    ) > 0
      ? (
          numberOr(
            offensive
              .theoreticalHitProbability
          ) /
          numberOr(
            prudent
              .theoreticalHitProbability
          )
        ) *
        100
      : 0;

  let strategy =
    "BALANCED";

  let reason =
    "La stratégie équilibrée offre le meilleur compromis entre coût et couverture sur cette grille.";

  if (
    difficultyScore >= 72
  ) {
    strategy =
      "PRUDENT";
    reason =
      "La grille contient suffisamment d'incertitude et de pièges pour privilégier la couverture maximale.";
  } else if (
    difficultyScore < 45 &&
    offensiveRetention >= 70
  ) {
    strategy =
      "OFFENSIVE";
    reason =
      "La grille est relativement lisible et la stratégie offensive conserve une part suffisante de la couverture prudente.";
  } else if (
    balancedRetention < 72
  ) {
    strategy =
      "PRUDENT";
    reason =
      "La réduction de coût de la stratégie équilibrée fait perdre trop de couverture par rapport à la prudente.";
  }

  const selected =
    strategies[
      strategy
    ];

  return {
    strategy,

    strategyLabel:
      selected
        ?.strategyLabel ||
      strategy,

    reason,

    difficultyScore:
      roundScore(
        difficultyScore
      ),

    usedBudget:
      numberOr(
        selected
          ?.usedBudget
    ),

    unusedBudget:
      numberOr(
        selected
          ?.unusedBudget
    ),

    combinations:
      numberOr(
        selected
          ?.combinations
    ),

    theoreticalHitProbability:
      numberOr(
        selected
          ?.theoreticalHitProbability
    ),

    atLeastMinusOne:
      selected
        ?.rankProfile
        ?.atLeast
        ?.minusOne ??
      null,

    atLeastMinusTwo:
      selected
        ?.rankProfile
        ?.atLeast
        ?.minusTwo ??
      null,

    balancedRetention:
      Number(
        balancedRetention
          .toFixed(2)
      ),

    offensiveRetention:
      Number(
        offensiveRetention
          .toFixed(2)
      ),
  };
}

function createLotoFootEngine({
  app,
  pool,
  callApiFootball,
  adminGuard,
  schedulersEnabled = true,
} = {}) {
  if (!app) {
    throw new Error(
      "LotoFootEngine : app Express manquante."
    );
  }

  if (!pool) {
    throw new Error(
      "LotoFootEngine : pool PostgreSQL manquant."
    );
  }

  if (
    typeof callApiFootball !==
    "function"
  ) {
    throw new Error(
      "LotoFootEngine : callApiFootball manquante."
    );
  }

  async function ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lotofoot_grids (
        id BIGSERIAL PRIMARY KEY,

        grid_type TEXT NOT NULL,
        official_grid_number TEXT,
        source TEXT NOT NULL DEFAULT 'MANUAL_IMPORT',

        title TEXT,
        deadline_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'DRAFT',

        unit_stake NUMERIC(10,2)
          NOT NULL DEFAULT 1.00,

        metadata JSONB
          NOT NULL DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        CONSTRAINT lotofoot_grids_grid_type_check
          CHECK (
            grid_type IN (
              'LF7',
              'LF8',
              'LF12',
              'LF15'
            )
          )
      );
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        idx_lotofoot_grids_official_unique
      ON lotofoot_grids (
        grid_type,
        official_grid_number
      )
      WHERE official_grid_number IS NOT NULL;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
        idx_lotofoot_grids_status
      ON lotofoot_grids (
        status,
        deadline_at
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lotofoot_matches (
        id BIGSERIAL PRIMARY KEY,

        grid_id BIGINT NOT NULL
          REFERENCES lotofoot_grids(id)
          ON DELETE CASCADE,

        line_number INTEGER NOT NULL,

        fixture_id BIGINT,

        home_team_name TEXT NOT NULL,
        away_team_name TEXT NOT NULL,

        fixture_date TIMESTAMPTZ,

        league_id BIGINT,
        league_name TEXT,

        matching_status TEXT
          NOT NULL DEFAULT 'UNMATCHED',

        matching_confidence NUMERIC(5,2),

        public_home_percent NUMERIC(6,2),
        public_draw_percent NUMERIC(6,2),
        public_away_percent NUMERIC(6,2),

        final_result TEXT,

        home_goals INTEGER,
        away_goals INTEGER,

        metadata JSONB
          NOT NULL DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        UNIQUE (
          grid_id,
          line_number
        ),

        CONSTRAINT lotofoot_matches_line_number_check
          CHECK (
            line_number > 0
          ),

        CONSTRAINT lotofoot_matches_final_result_check
          CHECK (
            final_result IS NULL OR
            final_result IN (
              '1',
              'N',
              '2'
            )
          )
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
        idx_lotofoot_matches_fixture
      ON lotofoot_matches (
        fixture_id
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
        idx_lotofoot_matches_grid
      ON lotofoot_matches (
        grid_id,
        line_number
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lotofoot_predictions (
        id BIGSERIAL PRIMARY KEY,

        grid_id BIGINT NOT NULL
          REFERENCES lotofoot_grids(id)
          ON DELETE CASCADE,

        lotofoot_match_id BIGINT NOT NULL
          REFERENCES lotofoot_matches(id)
          ON DELETE CASCADE,

        fixture_id BIGINT,

        footballbrain_home_probability
          NUMERIC(6,2),

        footballbrain_draw_probability
          NUMERIC(6,2),

        footballbrain_away_probability
          NUMERIC(6,2),

        ai_pick TEXT,

        base_score NUMERIC(6,2),
        trap_score NUMERIC(6,2),
        cover_score NUMERIC(6,2),
        surprise_score NUMERIC(6,2),

        recommended_cover TEXT
          NOT NULL DEFAULT 'SIMPLE',

        recommended_selection TEXT,

        analysis_version TEXT
          NOT NULL DEFAULT 'lotofoot-engine-v1.0.0',

        status TEXT
          NOT NULL DEFAULT 'PENDING',

        prediction_payload JSONB
          NOT NULL DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        settled_at TIMESTAMPTZ,

        UNIQUE (
          lotofoot_match_id,
          analysis_version
        ),

        CONSTRAINT lotofoot_predictions_ai_pick_check
          CHECK (
            ai_pick IS NULL OR
            ai_pick IN (
              '1',
              'N',
              '2'
            )
          ),

        CONSTRAINT lotofoot_predictions_cover_check
          CHECK (
            recommended_cover IN (
              'SIMPLE',
              'DOUBLE',
              'TRIPLE'
            )
          )
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
        idx_lotofoot_predictions_grid
      ON lotofoot_predictions (
        grid_id,
        status
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lotofoot_settlements (
        id BIGSERIAL PRIMARY KEY,

        prediction_id BIGINT NOT NULL
          REFERENCES lotofoot_predictions(id)
          ON DELETE CASCADE,

        grid_id BIGINT NOT NULL
          REFERENCES lotofoot_grids(id)
          ON DELETE CASCADE,

        lotofoot_match_id BIGINT NOT NULL
          REFERENCES lotofoot_matches(id)
          ON DELETE CASCADE,

        actual_result TEXT NOT NULL,

        ai_pick_correct BOOLEAN,

        selection_covered BOOLEAN,

        base_hit BOOLEAN,
        trap_event BOOLEAN,

        settled_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        metadata JSONB
          NOT NULL DEFAULT '{}'::jsonb,

        UNIQUE (
          prediction_id
        ),

        CONSTRAINT lotofoot_settlements_actual_result_check
          CHECK (
            actual_result IN (
              '1',
              'N',
              '2'
            )
          )
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lotofoot_learning (
        id BIGSERIAL PRIMARY KEY,

        learning_type TEXT NOT NULL,
        learning_bucket TEXT NOT NULL,

        sample_size INTEGER
          NOT NULL DEFAULT 0,

        hit_count INTEGER
          NOT NULL DEFAULT 0,

        hit_rate NUMERIC(8,4),

        average_predicted_probability
          NUMERIC(8,4),

        actual_frequency
          NUMERIC(8,4),

        calibration_gap
          NUMERIC(8,4),

        brier_score NUMERIC(12,8),

        reliability_level TEXT
          NOT NULL DEFAULT
          'INSUFFICIENT_DATA',

        learning_version TEXT
          NOT NULL DEFAULT
          'lotofoot-learning-v1',

        calculated_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        UNIQUE (
          learning_type,
          learning_bucket,
          learning_version
        )
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lotofoot_grid_optimizations (
        id BIGSERIAL PRIMARY KEY,

        grid_id BIGINT NOT NULL
          REFERENCES lotofoot_grids(id)
          ON DELETE CASCADE,

        analysis_version TEXT NOT NULL,

        requested_budget NUMERIC(10,2)
          NOT NULL,

        unit_stake NUMERIC(10,2)
          NOT NULL DEFAULT 1.00,

        max_combinations INTEGER
          NOT NULL,

        used_combinations INTEGER
          NOT NULL,

        theoretical_hit_probability
          NUMERIC(14,8),

        strategy TEXT
          NOT NULL DEFAULT 'MAX_HIT_PROBABILITY',

        optimization_payload JSONB
          NOT NULL DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
        idx_lotofoot_grid_optimizations_grid
      ON lotofoot_grid_optimizations (
        grid_id,
        created_at DESC
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lotofoot_runs (
        id BIGSERIAL PRIMARY KEY,

        run_type TEXT NOT NULL,
        status TEXT NOT NULL,

        rows_processed INTEGER
          NOT NULL DEFAULT 0,

        summary JSONB
          NOT NULL DEFAULT '{}'::jsonb,

        error_message TEXT,

        started_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),

        finished_at TIMESTAMPTZ
      );
    `);
  }


  async function importManualGrid(
    payload
  ) {
    await ensureTables();

    const data =
      validateManualGridPayload(
        payload
      );

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      let existingGrid =
        null;

      if (
        data.officialGridNumber
      ) {
        const existingResult =
          await client.query(
            `
              SELECT id
              FROM lotofoot_grids
              WHERE grid_type = $1
                AND official_grid_number = $2
              LIMIT 1
            `,
            [
              data.gridType,
              data.officialGridNumber,
            ]
          );

        existingGrid =
          existingResult.rows[0] ||
          null;
      }

      if (existingGrid) {
        throw new Error(
          `La grille ${data.gridType} n°${data.officialGridNumber} existe déjà (id ${existingGrid.id}).`
        );
      }

      const gridResult =
        await client.query(
          `
            INSERT INTO lotofoot_grids (
              grid_type,
              official_grid_number,
              source,
              title,
              deadline_at,
              status,
              unit_stake,
              metadata,
              updated_at
            )
            VALUES (
              $1,
              $2,
              'MANUAL_IMPORT',
              $3,
              $4,
              'IMPORTED',
              $5,
              $6::jsonb,
              NOW()
            )
            RETURNING *
          `,
          [
            data.gridType,
            data.officialGridNumber,
            data.title,
            data.deadlineAt,
            data.unitStake,
            JSON.stringify(
              data.metadata
            ),
          ]
        );

      const grid =
        gridResult.rows[0];

      const insertedMatches =
        [];

      for (
        const match of
        data.matches
      ) {
        const matchResult =
          await client.query(
            `
              INSERT INTO lotofoot_matches (
                grid_id,
                line_number,
                fixture_id,
                home_team_name,
                away_team_name,
                fixture_date,
                league_id,
                league_name,
                matching_status,
                matching_confidence,
                public_home_percent,
                public_draw_percent,
                public_away_percent,
                metadata,
                updated_at
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                $13,
                $14::jsonb,
                NOW()
              )
              RETURNING *
            `,
            [
              grid.id,
              match.lineNumber,
              match.fixtureId,
              match.homeTeam,
              match.awayTeam,
              match.fixtureDate,
              match.leagueId,
              match.leagueName,
              match.fixtureId
                ? "MANUAL_FIXTURE"
                : "UNMATCHED",
              match.fixtureId
                ? 100
                : null,
              match.publicHomePercent,
              match.publicDrawPercent,
              match.publicAwayPercent,
              JSON.stringify(
                match.metadata
              ),
            ]
          );

        insertedMatches.push(
          matchResult.rows[0]
        );
      }

      await client.query(
        "COMMIT"
      );

      return {
        ok: true,
        version:
          LOTOFOOT_VERSION,
        imported: true,
        grid: {
          id:
            numberOr(grid.id),
          gridType:
            grid.grid_type,
          officialGridNumber:
            grid.official_grid_number,
          source:
            grid.source,
          title:
            grid.title,
          deadlineAt:
            grid.deadline_at,
          status:
            grid.status,
          unitStake:
            numberOr(
              grid.unit_stake,
              1
            ),
          matches:
            insertedMatches.length,
        },
        generatedAt:
          new Date().toISOString(),
      };
    } catch (error) {
      await client.query(
        "ROLLBACK"
      );

      throw error;
    } finally {
      client.release();
    }
  }

  async function listGrids({
    limit = 50,
  } = {}) {
    await ensureTables();

    const safeLimit =
      Math.max(
        1,
        Math.min(
          200,
          Number(limit) || 50
        )
      );

    const result =
      await pool.query(
        `
          SELECT
            g.*,
            COUNT(m.id)::INTEGER
              AS match_count
          FROM lotofoot_grids g
          LEFT JOIN lotofoot_matches m
            ON m.grid_id = g.id
          GROUP BY g.id
          ORDER BY
            g.deadline_at DESC NULLS LAST,
            g.id DESC
          LIMIT $1
        `,
        [safeLimit]
      );

    return result.rows;
  }

  async function getGrid(
    gridId
  ) {
    await ensureTables();

    const id =
      Number(gridId);

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      return null;
    }

    const gridResult =
      await pool.query(
        `
          SELECT *
          FROM lotofoot_grids
          WHERE id = $1
          LIMIT 1
        `,
        [id]
      );

    const grid =
      gridResult.rows[0];

    if (!grid) {
      return null;
    }

    const matchesResult =
      await pool.query(
        `
          SELECT *
          FROM lotofoot_matches
          WHERE grid_id = $1
          ORDER BY line_number ASC
        `,
        [id]
      );

    return {
      ...grid,
      matches:
        matchesResult.rows,
    };
  }


  async function loadCandidateFixtures(
    grid
  ) {
    const baseDate =
      formatParisDate(
        grid?.deadline_at ||
        new Date()
      );

    if (!baseDate) {
      throw new Error(
        "Impossible de déterminer la date de recherche de la grille."
      );
    }

    /*
     * Fenêtre volontairement large :
     * J-1 / J / J+1.
     * Certaines grilles clôturent avant une série de matchs répartis
     * autour de minuit ou sur deux journées.
     */
    const dates = [
      addCalendarDays(
        baseDate,
        -1
      ),
      baseDate,
      addCalendarDays(
        baseDate,
        1
      ),
    ];

    const fixturesById =
      new Map();

    for (
      const date of dates
    ) {
      const response =
        await callApiFootball(
          "/fixtures",
          {
            date,
            timezone:
              "Europe/Paris",
          }
        );

      const fixtures =
        Array.isArray(
          response?.data?.response
        )
          ? response.data.response
          : [];

      for (
        const fixture of
        fixtures
      ) {
        const fixtureId =
          Number(
            fixture?.fixture?.id
          );

        if (
          Number.isInteger(
            fixtureId
          ) &&
          fixtureId > 0
        ) {
          fixturesById.set(
            fixtureId,
            fixture
          );
        }
      }
    }

    return [
      ...fixturesById.values(),
    ];
  }

  async function matchGridFixtures(
    gridId,
    {
      minimumScore = 72,
      force = false,
    } = {}
  ) {
    await ensureTables();

    const grid =
      await getGrid(
        gridId
      );

    if (!grid) {
      throw new Error(
        "Grille Loto Foot introuvable."
      );
    }

    const candidates =
      await loadCandidateFixtures(
        grid
      );

    const results = [];

    for (
      const lotoMatch of
      grid.matches
    ) {
      if (
        lotoMatch.fixture_id &&
        !force
      ) {
        results.push({
          lineNumber:
            Number(
              lotoMatch.line_number
            ),
          status:
            "ALREADY_MATCHED",
          fixtureId:
            Number(
              lotoMatch.fixture_id
            ),
          confidence:
            numberOr(
              lotoMatch.matching_confidence,
              100
            ),
        });

        continue;
      }

      const ranked =
        candidates
          .map((fixture) => {
            const scoring =
              fixtureMatchScore(
                lotoMatch,
                fixture
              );

            return {
              fixture,
              ...scoring,
            };
          })
          .sort(
            (a, b) =>
              b.score -
              a.score
          );

      const best =
        ranked[0] ||
        null;

      const second =
        ranked[1] ||
        null;

      const ambiguous =
        best &&
        second &&
        best.score -
          second.score <
          6;

      if (
        !best ||
        best.score <
          minimumScore ||
        ambiguous
      ) {
        await pool.query(
          `
            UPDATE lotofoot_matches
            SET
              fixture_id = NULL,
              fixture_date = NULL,
              league_id = NULL,
              league_name = NULL,
              matching_status = $2,
              matching_confidence = $3,
              updated_at = NOW()
            WHERE id = $1
          `,
          [
            lotoMatch.id,
            ambiguous
              ? "AMBIGUOUS"
              : "UNMATCHED",
            best
              ? best.score
              : 0,
          ]
        );

        results.push({
          lineNumber:
            Number(
              lotoMatch.line_number
            ),
          homeTeam:
            lotoMatch.home_team_name,
          awayTeam:
            lotoMatch.away_team_name,
          status:
            ambiguous
              ? "AMBIGUOUS"
              : "UNMATCHED",
          confidence:
            best
              ? best.score
              : 0,
          bestCandidate:
            best
              ? {
                  fixtureId:
                    Number(
                      best.fixture
                        ?.fixture?.id
                    ),
                  homeTeam:
                    best.fixture
                      ?.teams?.home?.name,
                  awayTeam:
                    best.fixture
                      ?.teams?.away?.name,
                  score:
                    best.score,
                }
              : null,
        });

        continue;
      }

      const fixture =
        best.fixture;

      await pool.query(
        `
          UPDATE lotofoot_matches
          SET
            fixture_id = $2,
            fixture_date = $3,
            league_id = $4,
            league_name = $5,
            matching_status = 'MATCHED',
            matching_confidence = $6,
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          lotoMatch.id,
          Number(
            fixture?.fixture?.id
          ),
          fixture?.fixture?.date ||
            null,
          fixture?.league?.id ||
            null,
          fixture?.league?.name ||
            null,
          best.score,
        ]
      );

      results.push({
        lineNumber:
          Number(
            lotoMatch.line_number
          ),
        homeTeam:
          lotoMatch.home_team_name,
        awayTeam:
          lotoMatch.away_team_name,
        status:
          "MATCHED",
        fixtureId:
          Number(
            fixture?.fixture?.id
          ),
        fixtureDate:
          fixture?.fixture?.date ||
          null,
        leagueId:
          fixture?.league?.id ||
          null,
        leagueName:
          fixture?.league?.name ||
          null,
        confidence:
          best.score,
        apiHomeTeam:
          fixture?.teams?.home?.name ||
          null,
        apiAwayTeam:
          fixture?.teams?.away?.name ||
          null,
      });
    }

    const matched =
      results.filter(
        (item) =>
          item.status ===
            "MATCHED" ||
          item.status ===
            "ALREADY_MATCHED"
      ).length;

    const ambiguous =
      results.filter(
        (item) =>
          item.status ===
          "AMBIGUOUS"
      ).length;

    const unmatched =
      results.filter(
        (item) =>
          item.status ===
          "UNMATCHED"
      ).length;

    return {
      ok: true,
      version:
        LOTOFOOT_VERSION,
      gridId:
        Number(grid.id),
      gridType:
        grid.grid_type,
      officialGridNumber:
        grid.official_grid_number,
      candidates:
        candidates.length,
      total:
        results.length,
      matched,
      ambiguous,
      unmatched,
      results,
      generatedAt:
        new Date().toISOString(),
    };
  }


  async function getFootballBrainPrediction(
    fixtureId
  ) {
    const result =
      await pool.query(
        `
          SELECT
            fixture_id,
            fixture_date,
            league_id,
            league_name,
            home_team_name,
            away_team_name,

            home_probability,
            draw_probability,
            away_probability,

            confidence,
            risk,
            selected_outcome,
            bet_status,

            studio_market_key,
            studio_market_label,
            studio_probability,
            studio_decision_score,
            studio_decision_type,
            studio_decision_grade,
            studio_analysis_version,
            studio_saved_at,

            updated_at
          FROM predictions
          WHERE fixture_id = $1
          LIMIT 1
        `,
        [
          fixtureId,
        ]
      );

    return (
      result.rows[0] ||
      null
    );
  }

  async function analyzeGrid(
    gridId,
    {
      force = false,
    } = {}
  ) {
    await ensureTables();

    const grid =
      await getGrid(
        gridId
      );

    if (!grid) {
      throw new Error(
        "Grille Loto Foot introuvable."
      );
    }

    const results = [];

    for (
      const lotoMatch of
      grid.matches
    ) {
      const fixtureId =
        Number(
          lotoMatch.fixture_id
        );

      if (
        !Number.isInteger(
          fixtureId
        ) ||
        fixtureId <= 0
      ) {
        results.push({
          lineNumber:
            Number(
              lotoMatch.line_number
            ),
          homeTeam:
            lotoMatch.home_team_name,
          awayTeam:
            lotoMatch.away_team_name,
          status:
            "UNMATCHED_FIXTURE",
        });

        continue;
      }

      const existingResult =
        await pool.query(
          `
            SELECT *
            FROM lotofoot_predictions
            WHERE lotofoot_match_id = $1
              AND analysis_version = $2
            LIMIT 1
          `,
          [
            lotoMatch.id,
            LOTOFOOT_VERSION,
          ]
        );

      const existing =
        existingResult.rows[0] ||
        null;

      if (
        existing &&
        !force
      ) {
        results.push({
          lineNumber:
            Number(
              lotoMatch.line_number
            ),
          fixtureId,
          status:
            "ALREADY_ANALYZED",
          aiPick:
            existing.ai_pick,
          baseScore:
            numberOr(
              existing.base_score
            ),
          trapScore:
            numberOr(
              existing.trap_score
            ),
          coverScore:
            numberOr(
              existing.cover_score
            ),
          surpriseScore:
            numberOr(
              existing.surprise_score
            ),
          recommendedCover:
            existing.recommended_cover,
          recommendedSelection:
            existing.recommended_selection,
        });

        continue;
      }

      const brain =
        await getFootballBrainPrediction(
          fixtureId
        );

      if (!brain) {
        results.push({
          lineNumber:
            Number(
              lotoMatch.line_number
            ),
          fixtureId,
          homeTeam:
            lotoMatch.home_team_name,
          awayTeam:
            lotoMatch.away_team_name,
          status:
            "MISSING_BRAIN_DATA",
          reason:
            "Aucune prédiction FootballBrain enregistrée pour ce fixture.",
        });

        continue;
      }

      const probabilities =
        probabilityMapFromRow(
          brain
        );

      const totalProbability =
        probabilities.home +
        probabilities.draw +
        probabilities.away;

      if (
        totalProbability <= 0
      ) {
        results.push({
          lineNumber:
            Number(
              lotoMatch.line_number
            ),
          fixtureId,
          homeTeam:
            lotoMatch.home_team_name,
          awayTeam:
            lotoMatch.away_team_name,
          status:
            "MISSING_PROBABILITIES",
          reason:
            "FootballBrain existe mais les probabilités 1/N/2 sont absentes.",
        });

        continue;
      }

      const scoring =
        computeLotoFootScores({
          probabilities,
          confidence:
            brain.confidence,
          risk:
            brain.risk,
        });

      const payload = {
        fixtureId,

        source:
          "footballbrain-predictions",

        footballBrain: {
          confidence:
            Number.isFinite(
              Number(
                brain.confidence
              )
            )
              ? Number(
                  brain.confidence
                )
              : null,

          risk:
            brain.risk ||
            null,

          selectedOutcome:
            brain.selected_outcome ||
            null,

          betStatus:
            brain.bet_status ||
            null,

          studio: {
            marketKey:
              brain.studio_market_key ||
              null,

            marketLabel:
              brain.studio_market_label ||
              null,

            probability:
              Number.isFinite(
                Number(
                  brain.studio_probability
                )
              )
                ? Number(
                    brain.studio_probability
                  )
                : null,

            decisionScore:
              Number.isFinite(
                Number(
                  brain.studio_decision_score
                )
              )
                ? Number(
                    brain.studio_decision_score
                  )
                : null,

            decisionType:
              brain.studio_decision_type ||
              null,

            decisionGrade:
              brain.studio_decision_grade ||
              null,

            analysisVersion:
              brain.studio_analysis_version ||
              null,

            savedAt:
              brain.studio_saved_at ||
              null,
          },
        },

        scoring: {
          favoriteProbability:
            scoring.favoriteProbability,

          margin:
            scoring.margin,

          ranking:
            scoring.ranking,

          methodology:
            "lotofoot-scoring-v1",
        },
      };

      const upsertResult =
        await pool.query(
          `
            INSERT INTO lotofoot_predictions (
              grid_id,
              lotofoot_match_id,
              fixture_id,

              footballbrain_home_probability,
              footballbrain_draw_probability,
              footballbrain_away_probability,

              ai_pick,

              base_score,
              trap_score,
              cover_score,
              surprise_score,

              recommended_cover,
              recommended_selection,

              analysis_version,
              status,
              prediction_payload,

              updated_at
            )
            VALUES (
              $1,
              $2,
              $3,

              $4,
              $5,
              $6,

              $7,

              $8,
              $9,
              $10,
              $11,

              $12,
              $13,

              $14,
              'PENDING',
              $15::jsonb,

              NOW()
            )
            ON CONFLICT (
              lotofoot_match_id,
              analysis_version
            )
            DO UPDATE SET
              fixture_id =
                EXCLUDED.fixture_id,

              footballbrain_home_probability =
                EXCLUDED.footballbrain_home_probability,

              footballbrain_draw_probability =
                EXCLUDED.footballbrain_draw_probability,

              footballbrain_away_probability =
                EXCLUDED.footballbrain_away_probability,

              ai_pick =
                EXCLUDED.ai_pick,

              base_score =
                EXCLUDED.base_score,

              trap_score =
                EXCLUDED.trap_score,

              cover_score =
                EXCLUDED.cover_score,

              surprise_score =
                EXCLUDED.surprise_score,

              recommended_cover =
                EXCLUDED.recommended_cover,

              recommended_selection =
                EXCLUDED.recommended_selection,

              prediction_payload =
                EXCLUDED.prediction_payload,

              updated_at =
                NOW()

            RETURNING *
          `,
          [
            grid.id,
            lotoMatch.id,
            fixtureId,

            scoring.probabilities.home,
            scoring.probabilities.draw,
            scoring.probabilities.away,

            scoring.aiPick,

            scoring.baseScore,
            scoring.trapScore,
            scoring.coverScore,
            scoring.surpriseScore,

            scoring.recommendedCover,
            scoring.recommendedSelection,

            LOTOFOOT_VERSION,
            JSON.stringify(
              payload
            ),
          ]
        );

      const saved =
        upsertResult.rows[0];

      results.push({
        lineNumber:
          Number(
            lotoMatch.line_number
          ),

        fixtureId,

        homeTeam:
          lotoMatch.home_team_name,

        awayTeam:
          lotoMatch.away_team_name,

        status:
          "ANALYZED",

        probabilities: {
          "1":
            scoring.probabilities.home,
          "N":
            scoring.probabilities.draw,
          "2":
            scoring.probabilities.away,
        },

        aiPick:
          saved.ai_pick,

        favoriteProbability:
          scoring.favoriteProbability,

        margin:
          scoring.margin,

        baseScore:
          numberOr(
            saved.base_score
          ),

        trapScore:
          numberOr(
            saved.trap_score
          ),

        coverScore:
          numberOr(
            saved.cover_score
          ),

        surpriseScore:
          numberOr(
            saved.surprise_score
          ),

        recommendedCover:
          saved.recommended_cover,

        recommendedSelection:
          saved.recommended_selection,
      });
    }

    const analyzed =
      results.filter(
        (item) =>
          item.status ===
            "ANALYZED" ||
          item.status ===
            "ALREADY_ANALYZED"
      ).length;

    const missingBrainData =
      results.filter(
        (item) =>
          item.status ===
            "MISSING_BRAIN_DATA" ||
          item.status ===
            "MISSING_PROBABILITIES"
      ).length;

    const unmatched =
      results.filter(
        (item) =>
          item.status ===
          "UNMATCHED_FIXTURE"
      ).length;

    return {
      ok: true,
      version:
        LOTOFOOT_VERSION,

      gridId:
        Number(
          grid.id
        ),

      gridType:
        grid.grid_type,

      officialGridNumber:
        grid.official_grid_number,

      total:
        results.length,

      analyzed,
      missingBrainData,
      unmatched,

      results,

      generatedAt:
        new Date().toISOString(),
    };
  }

  async function getGridAnalysis(
    gridId
  ) {
    await ensureTables();

    const grid =
      await getGrid(
        gridId
      );

    if (!grid) {
      return null;
    }

    const result =
      await pool.query(
        `
          SELECT
            lp.*,
            lm.line_number,
            lm.home_team_name,
            lm.away_team_name,
            lm.fixture_date,
            lm.league_name
          FROM lotofoot_predictions lp
          INNER JOIN lotofoot_matches lm
            ON lm.id =
              lp.lotofoot_match_id
          WHERE lp.grid_id = $1
          ORDER BY
            lm.line_number ASC,
            lp.id DESC
        `,
        [
          gridId,
        ]
      );

    const latestByLine =
      new Map();

    for (
      const row of
      result.rows
    ) {
      const line =
        Number(
          row.line_number
        );

      if (
        !latestByLine.has(
          line
        )
      ) {
        latestByLine.set(
          line,
          row
        );
      }
    }

    return {
      grid: {
        id:
          Number(
            grid.id
          ),

        gridType:
          grid.grid_type,

        officialGridNumber:
          grid.official_grid_number,

        title:
          grid.title,

        deadlineAt:
          grid.deadline_at,

        status:
          grid.status,
      },

      predictions:
        [
          ...latestByLine.values(),
        ],
    };
  }


  async function optimizeGrid(
    gridId,
    {
      budget = 8,
      unitStake = null,
      persist = true,
    } = {}
  ) {
    await ensureTables();

    const gridAnalysis =
      await getGridAnalysis(
        gridId
      );

    if (!gridAnalysis) {
      throw new Error(
        "Grille Loto Foot introuvable."
      );
    }

    const grid =
      gridAnalysis.grid;

    const predictions =
      Array.isArray(
        gridAnalysis.predictions
      )
        ? gridAnalysis.predictions
        : [];

    const expectedLines =
      Number(
        String(
          grid.gridType || ""
        )
          .replace(
            /\D/g,
            ""
          )
      );

    if (
      predictions.length === 0
    ) {
      throw new Error(
        "Aucune prédiction Loto Foot disponible. Lance d'abord /analyze."
      );
    }

    /*
     * On vérifie qu'une ligne analysée existe pour chaque ligne réellement
     * stockée dans la grille, pas uniquement le nombre théorique du nom LF.
     */
    const fullGrid =
      await getGrid(
        gridId
      );

    const actualMatchCount =
      Array.isArray(
        fullGrid?.matches
      )
        ? fullGrid.matches.length
        : 0;

    if (
      predictions.length !==
      actualMatchCount
    ) {
      throw new Error(
        `Analyse incomplète : ${predictions.length}/${actualMatchCount} lignes disponibles.`
      );
    }

    const storedUnitStake =
      numberOr(
        fullGrid?.unit_stake,
        1
      );

    const effectiveUnitStake =
      Number.isFinite(
        Number(unitStake)
      ) &&
      Number(unitStake) > 0
        ? Number(unitStake)
        : storedUnitStake > 0
          ? storedUnitStake
          : 1;

    const requestedBudget =
      Math.max(
        effectiveUnitStake,
        numberOr(
          budget,
          effectiveUnitStake
        )
      );

    const maxCombinations =
      Math.max(
        1,
        Math.floor(
          requestedBudget /
          effectiveUnitStake
        )
      );

    const optimization =
      optimizeGridSelections({
        predictions,
        maxCombinations,
      });

    const usedBudget =
      Number(
        (
          optimization.combinations *
          effectiveUnitStake
        ).toFixed(2)
      );

    const payload = {
      methodology:
        "grid-optimizer-dp-v1",

      strategy:
        "MAX_HIT_PROBABILITY",

      requestedBudget,

      unitStake:
        effectiveUnitStake,

      maxCombinations,

      usedCombinations:
        optimization.combinations,

      usedBudget,

      theoreticalHitProbability:
        optimization
          .theoreticalHitProbability,

      assumptions: [
        "Les probabilités proviennent de FootballBrain.",
        "La probabilité théorique de grille suppose les matchs indépendants.",
        "Le budget limite le produit des facteurs SIMPLE=1, DOUBLE=2, TRIPLE=3.",
      ],

      lines:
        optimization.lines,
    };

    if (persist) {
      await pool.query(
        `
          INSERT INTO lotofoot_grid_optimizations (
            grid_id,
            analysis_version,
            requested_budget,
            unit_stake,
            max_combinations,
            used_combinations,
            theoretical_hit_probability,
            strategy,
            optimization_payload
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            'MAX_HIT_PROBABILITY',
            $8::jsonb
          )
        `,
        [
          gridId,
          LOTOFOOT_VERSION,
          requestedBudget,
          effectiveUnitStake,
          maxCombinations,
          optimization.combinations,
          optimization
            .theoreticalHitProbability,
          JSON.stringify(
            payload
          ),
        ]
      );
    }

    return {
      ok: true,

      version:
        LOTOFOOT_VERSION,

      gridId:
        Number(
          grid.id
        ),

      gridType:
        grid.gridType,

      officialGridNumber:
        grid.officialGridNumber,

      requestedBudget,

      unitStake:
        effectiveUnitStake,

      maxCombinations,

      usedCombinations:
        optimization.combinations,

      usedBudget,

      theoreticalHitProbability:
        optimization
          .theoreticalHitProbability,

      strategy:
        "MAX_HIT_PROBABILITY",

      lines:
        optimization.lines,

      generatedAt:
        new Date().toISOString(),
    };
  }

  async function getOptimizationHistory(
    gridId,
    {
      limit = 20,
    } = {}
  ) {
    await ensureTables();

    const safeLimit =
      Math.max(
        1,
        Math.min(
          100,
          Number(limit) || 20
        )
      );

    const result =
      await pool.query(
        `
          SELECT *
          FROM lotofoot_grid_optimizations
          WHERE grid_id = $1
          ORDER BY created_at DESC
          LIMIT $2
        `,
        [
          gridId,
          safeLimit,
        ]
      );

    return result.rows;
  }


  async function buildGridStrategies(
    gridId,
    {
      budget = 8,
      unitStake = null,
      persist = true,
    } = {}
  ) {
    await ensureTables();

    const gridAnalysis =
      await getGridAnalysis(
        gridId
      );

    if (!gridAnalysis) {
      throw new Error(
        "Grille Loto Foot introuvable."
      );
    }

    const predictions =
      Array.isArray(
        gridAnalysis.predictions
      )
        ? gridAnalysis.predictions
        : [];

    const fullGrid =
      await getGrid(
        gridId
      );

    const actualMatchCount =
      Array.isArray(
        fullGrid?.matches
      )
        ? fullGrid.matches.length
        : 0;

    if (
      predictions.length !==
      actualMatchCount
    ) {
      throw new Error(
        `Analyse incomplète : ${predictions.length}/${actualMatchCount} lignes disponibles.`
      );
    }

    const storedUnitStake =
      numberOr(
        fullGrid?.unit_stake,
        1
      );

    const effectiveUnitStake =
      Number.isFinite(
        Number(unitStake)
      ) &&
      Number(unitStake) > 0
        ? Number(unitStake)
        : storedUnitStake > 0
          ? storedUnitStake
          : 1;

    const requestedBudget =
      Math.max(
        effectiveUnitStake,
        numberOr(
          budget,
          effectiveUnitStake
        )
      );

    const maxCombinations =
      Math.max(
        1,
        Math.floor(
          requestedBudget /
          effectiveUnitStake
        )
      );

    const strategies = {};

    for (
      const strategy of
      [
        "PRUDENT",
        "BALANCED",
        "OFFENSIVE",
      ]
    ) {
      const profile =
        LOTOFOOT_STRATEGIES[
          strategy
        ];

      const strategyMaxCombinations =
        Math.max(
          1,
          Math.floor(
            maxCombinations *
            numberOr(
              profile
                ?.budgetShare,
              1
            )
          )
        );

      const result =
        optimizeGridSelectionsByStrategy({
          predictions,
          maxCombinations:
            strategyMaxCombinations,
          strategy,
        });

      const usedBudget =
        Number(
          (
            result.combinations *
            effectiveUnitStake
          ).toFixed(2)
        );

      const rankProfile =
        computeCoverageDistribution(
          result.lines
        );

      strategies[strategy] = {
        ...result,

        description:
          profile?.description ||
          null,

        requestedBudget,

        unitStake:
          effectiveUnitStake,

        globalMaxCombinations:
          maxCombinations,

        strategyMaxCombinations,

        budgetShare:
          profile?.budgetShare ||
          1,

        usedBudget,

        unusedBudget:
          Number(
            Math.max(
              0,
              requestedBudget -
              usedBudget
            ).toFixed(2)
          ),

        rankProfile,
      };

      if (persist) {
        await pool.query(
          `
            INSERT INTO lotofoot_grid_optimizations (
              grid_id,
              analysis_version,
              requested_budget,
              unit_stake,
              max_combinations,
              used_combinations,
              theoretical_hit_probability,
              strategy,
              optimization_payload
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9::jsonb
            )
          `,
          [
            gridId,
            LOTOFOOT_VERSION,
            requestedBudget,
            effectiveUnitStake,
            strategyMaxCombinations,
            result.combinations,
            result
              .theoreticalHitProbability,
            strategy,
            JSON.stringify({
              strategy,
              result,
              description:
                profile?.description ||
                null,
              requestedBudget,
              effectiveUnitStake,
              globalMaxCombinations:
                maxCombinations,
              strategyMaxCombinations,
              budgetShare:
                profile?.budgetShare ||
                1,
              usedBudget,
              unusedBudget:
                Math.max(
                  0,
                  requestedBudget -
                  usedBudget
                ),
              rankProfile,
            }),
          ]
        );
      }
    }

    const protectionRanking =
      predictions
        .map(
          buildProtectionPriority
        )
        .sort(
          (a, b) =>
            b.priorityScore -
            a.priorityScore
        )
        .map(
          (
            item,
            index
          ) => ({
            rank:
              index + 1,
            ...item,
          })
        );

    return {
      ok: true,

      version:
        LOTOFOOT_VERSION,

      gridId:
        Number(
          fullGrid.id
        ),

      gridType:
        fullGrid.grid_type,

      officialGridNumber:
        fullGrid
          .official_grid_number,

      requestedBudget,

      unitStake:
        effectiveUnitStake,

      maxCombinations,

      strategyPolicy: {
        PRUDENT:
          "jusqu'à 100 % du budget",

        BALANCED:
          "jusqu'à 75 % du budget",

        OFFENSIVE:
          "jusqu'à 50 % du budget",
      },

      strategies,

      protectionRanking,

      generatedAt:
        new Date().toISOString(),
    };
  }

  async function getProtectionRanking(
    gridId
  ) {
    const analysis =
      await getGridAnalysis(
        gridId
      );

    if (!analysis) {
      return null;
    }

    const predictions =
      Array.isArray(
        analysis.predictions
      )
        ? analysis.predictions
        : [];

    return predictions
      .map(
        buildProtectionPriority
      )
      .sort(
        (a, b) =>
          b.priorityScore -
          a.priorityScore
      )
      .map(
        (
          item,
          index
        ) => ({
          rank:
            index + 1,
          ...item,
        })
      );
  }


  async function getGridIntelligence(
    gridId,
    {
      budget = 16,
      unitStake = null,
      persist = false,
    } = {}
  ) {
    await ensureTables();

    const analysis =
      await getGridAnalysis(
        gridId
      );

    if (!analysis) {
      throw new Error(
        "Grille Loto Foot introuvable."
      );
    }

    const predictions =
      Array.isArray(
        analysis.predictions
      )
        ? analysis.predictions
        : [];

    const fullGrid =
      await getGrid(
        gridId
      );

    const actualMatchCount =
      Array.isArray(
        fullGrid?.matches
      )
        ? fullGrid.matches.length
        : 0;

    if (
      predictions.length !==
      actualMatchCount
    ) {
      throw new Error(
        `Analyse incomplète : ${predictions.length}/${actualMatchCount} lignes disponibles.`
      );
    }

    const storedUnitStake =
      numberOr(
        fullGrid?.unit_stake,
        1
      );

    const effectiveUnitStake =
      Number.isFinite(
        Number(unitStake)
      ) &&
      Number(unitStake) > 0
        ? Number(unitStake)
        : storedUnitStake > 0
          ? storedUnitStake
          : 1;

    const requestedBudget =
      Math.max(
        effectiveUnitStake,
        numberOr(
          budget,
          16
        )
      );

    const strategyResult =
      await buildGridStrategies(
        gridId,
        {
          budget:
            requestedBudget,
          unitStake:
            effectiveUnitStake,
          persist,
        }
      );

    const difficulty =
      buildGridDifficulty(
        predictions
      );

    const defaultBudgets =
      [
        4,
        8,
        12,
        16,
        24,
        32,
      ]
        .map(
          (value) =>
            Math.max(
              effectiveUnitStake,
              value
            )
        );

    if (
      !defaultBudgets.some(
        (value) =>
          Math.abs(
            value -
            requestedBudget
          ) < 0.000001
      )
    ) {
      defaultBudgets.push(
        requestedBudget
      );
    }

    const budgetEfficiency =
      buildBudgetEfficiencyCurve({
        predictions,
        unitStake:
          effectiveUnitStake,
        budgets:
          defaultBudgets,
      });

    const recommendation =
      recommendGridStrategy({
        strategies:
          strategyResult
            .strategies,
        difficulty,
      });

    const protectionRanking =
      strategyResult
        .protectionRanking;

    const recommendedStrategy =
      recommendation
        ?.strategy
        ? strategyResult
            .strategies[
              recommendation
                .strategy
            ]
        : null;

    const summary = {
      difficultyScore:
        difficulty.score,

      difficultyLabel:
        difficulty.label,

      strongBases:
        difficulty.strongBases,

      openMatches:
        difficulty.openMatches,

      majorTraps:
        difficulty.majorTraps,

      recommendedStrategy:
        recommendation
          ?.strategy ||
        null,

      recommendedStrategyLabel:
        recommendation
          ?.strategyLabel ||
        null,

      recommendedCost:
        recommendation
          ?.usedBudget ??
        null,

      recommendedCombinations:
        recommendation
          ?.combinations ??
        null,

      perfectProbability:
        recommendation
          ?.theoreticalHitProbability ??
        null,

      atLeastMinusOne:
        recommendation
          ?.atLeastMinusOne ??
        null,

      atLeastMinusTwo:
        recommendation
          ?.atLeastMinusTwo ??
        null,

      topProtectionPriorities:
        Array.isArray(
          protectionRanking
        )
          ? protectionRanking
              .slice(
                0,
                4
              )
          : [],
    };

    return {
      ok: true,

      version:
        LOTOFOOT_VERSION,

      gridId:
        Number(
          fullGrid.id
        ),

      gridType:
        fullGrid.grid_type,

      officialGridNumber:
        fullGrid
          .official_grid_number,

      requestedBudget,

      unitStake:
        effectiveUnitStake,

      summary,

      difficulty,

      recommendation,

      strategies:
        strategyResult
          .strategies,

      protectionRanking,

      budgetEfficiency,

      generatedAt:
        new Date().toISOString(),
    };
  }

  async function getStatus() {
    await ensureTables();

    const result =
      await pool.query(`
        SELECT
          (
            SELECT COUNT(*)::INTEGER
            FROM lotofoot_grids
          ) AS grids,

          (
            SELECT COUNT(*)::INTEGER
            FROM lotofoot_matches
          ) AS matches,

          (
            SELECT COUNT(*)::INTEGER
            FROM lotofoot_predictions
          ) AS predictions,

          (
            SELECT COUNT(*)::INTEGER
            FROM lotofoot_settlements
          ) AS settled,

          (
            SELECT COUNT(*)::INTEGER
            FROM lotofoot_learning
          ) AS learning_groups
      `);

    const row =
      result.rows[0] || {};

    return {
      ok: true,
      version:
        LOTOFOOT_VERSION,

      mode:
        LOTOFOOT_MODE,

      grids:
        numberOr(
          row.grids
        ),

      matches:
        numberOr(
          row.matches
        ),

      predictions:
        numberOr(
          row.predictions
        ),

      settled:
        numberOr(
          row.settled
        ),

      learningGroups:
        numberOr(
          row.learning_groups
        ),

      supportedGridTypes:
        [
          "LF7",
          "LF8",
          "LF12",
          "LF15",
        ],

      schedulersEnabled:
        Boolean(
          schedulersEnabled
        ),

      generatedAt:
        new Date().toISOString(),
    };
  }

  function protectAdmin(
    handler
  ) {
    return async function protectedHandler(
      req,
      res,
      next
    ) {
      if (
        typeof adminGuard ===
        "function"
      ) {
        let guardPassed =
          false;

        const guardNext = () => {
          guardPassed = true;
        };

        await adminGuard(
          req,
          res,
          guardNext
        );

        if (
          !guardPassed ||
          res.headersSent
        ) {
          return;
        }
      }

      return handler(
        req,
        res,
        next
      );
    };
  }

  function registerRoutes() {
    app.get(
      "/internal/lotofoot/status",
      protectAdmin(
        async (req, res) => {
          try {
            const status =
              await getStatus();

            return res.json(
              status
            );
          } catch (error) {
            console.error(
              "LOTOFOOT STATUS ERROR :",
              error
            );

            return res
              .status(500)
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,

                error:
                  error?.message ||
                  "Impossible de charger le statut Loto Foot.",
              });
          }
        }
      )
    );

    app.post(
      "/internal/lotofoot/grid/:gridId/intelligence",
      protectAdmin(
        async (req, res) => {
          try {
            const result =
              await getGridIntelligence(
                req.params.gridId,
                {
                  budget:
                    req.body
                      ?.budget ?? 16,

                  unitStake:
                    req.body
                      ?.unitStake ??
                    null,

                  persist:
                    req.body
                      ?.persist === true,
                }
              );

            return res.json(
              result
            );
          } catch (error) {
            console.error(
              "LOTOFOOT GRID INTELLIGENCE ERROR :",
              error
            );

            return res
              .status(500)
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  error?.message ||
                  "Impossible de calculer l'intelligence de grille Loto Foot.",
              });
          }
        }
      )
    );

    app.post(
      "/internal/lotofoot/grid/:gridId/strategies",
      protectAdmin(
        async (req, res) => {
          try {
            const result =
              await buildGridStrategies(
                req.params.gridId,
                {
                  budget:
                    req.body
                      ?.budget ?? 8,

                  unitStake:
                    req.body
                      ?.unitStake ??
                    null,

                  persist:
                    req.body
                      ?.persist !== false,
                }
              );

            return res.json(
              result
            );
          } catch (error) {
            console.error(
              "LOTOFOOT STRATEGIES ERROR :",
              error
            );

            return res
              .status(500)
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  error?.message ||
                  "Impossible de générer les stratégies Loto Foot.",
              });
          }
        }
      )
    );

    app.get(
      "/internal/lotofoot/grid/:gridId/protection-ranking",
      protectAdmin(
        async (req, res) => {
          try {
            const ranking =
              await getProtectionRanking(
                req.params.gridId
              );

            if (!ranking) {
              return res
                .status(404)
                .json({
                  ok: false,
                  version:
                    LOTOFOOT_VERSION,
                  error:
                    "Grille Loto Foot introuvable.",
                });
            }

            return res.json({
              ok: true,
              version:
                LOTOFOOT_VERSION,
              gridId:
                Number(
                  req.params.gridId
                ),
              count:
                ranking.length,
              ranking,
              generatedAt:
                new Date().toISOString(),
            });
          } catch (error) {
            return res
              .status(500)
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  error?.message ||
                  "Impossible de charger les priorités de protection.",
              });
          }
        }
      )
    );

    app.post(
      "/internal/lotofoot/grid/:gridId/optimize",
      protectAdmin(
        async (req, res) => {
          try {
            const result =
              await optimizeGrid(
                req.params.gridId,
                {
                  budget:
                    req.body
                      ?.budget ?? 8,

                  unitStake:
                    req.body
                      ?.unitStake ??
                    null,

                  persist:
                    req.body
                      ?.persist !== false,
                }
              );

            return res.json(
              result
            );
          } catch (error) {
            console.error(
              "LOTOFOOT GRID OPTIMIZER ERROR :",
              error
            );

            return res
              .status(500)
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  error?.message ||
                  "Impossible d'optimiser la grille Loto Foot.",
              });
          }
        }
      )
    );

    app.get(
      "/internal/lotofoot/grid/:gridId/optimizations",
      protectAdmin(
        async (req, res) => {
          try {
            const history =
              await getOptimizationHistory(
                req.params.gridId,
                {
                  limit:
                    req.query?.limit,
                }
              );

            return res.json({
              ok: true,
              version:
                LOTOFOOT_VERSION,
              gridId:
                Number(
                  req.params.gridId
                ),
              count:
                history.length,
              optimizations:
                history,
              generatedAt:
                new Date().toISOString(),
            });
          } catch (error) {
            return res
              .status(500)
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  error?.message ||
                  "Impossible de charger l'historique des optimisations.",
              });
          }
        }
      )
    );

    app.post(
      "/internal/lotofoot/grid/:gridId/analyze",
      protectAdmin(
        async (req, res) => {
          try {
            const result =
              await analyzeGrid(
                req.params.gridId,
                {
                  force:
                    req.body
                      ?.force === true,
                }
              );

            return res.json(
              result
            );
          } catch (error) {
            console.error(
              "LOTOFOOT ANALYZE GRID ERROR :",
              error
            );

            return res
              .status(500)
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  error?.message ||
                  "Impossible d'analyser la grille Loto Foot.",
              });
          }
        }
      )
    );

    app.get(
      "/internal/lotofoot/grid/:gridId/analysis",
      protectAdmin(
        async (req, res) => {
          try {
            const analysis =
              await getGridAnalysis(
                req.params.gridId
              );

            if (!analysis) {
              return res
                .status(404)
                .json({
                  ok: false,
                  version:
                    LOTOFOOT_VERSION,
                  error:
                    "Grille Loto Foot introuvable.",
                });
            }

            return res.json({
              ok: true,
              version:
                LOTOFOOT_VERSION,
              ...analysis,
              generatedAt:
                new Date().toISOString(),
            });
          } catch (error) {
            return res
              .status(500)
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  error?.message ||
                  "Impossible de charger l'analyse Loto Foot.",
              });
          }
        }
      )
    );

    app.post(
      "/internal/lotofoot/grid/:gridId/match-fixtures",
      protectAdmin(
        async (req, res) => {
          try {
            const result =
              await matchGridFixtures(
                req.params.gridId,
                {
                  minimumScore:
                    Number(
                      req.body
                        ?.minimumScore
                    ) || 72,
                  force:
                    req.body
                      ?.force === true,
                }
              );

            return res.json(
              result
            );
          } catch (error) {
            console.error(
              "LOTOFOOT FIXTURE MATCHER ERROR :",
              error
            );

            return res
              .status(500)
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  error?.message ||
                  "Impossible de matcher les rencontres Loto Foot.",
              });
          }
        }
      )
    );

    app.post(
      "/internal/lotofoot/import-grid",
      protectAdmin(
        async (req, res) => {
          try {
            const result =
              await importManualGrid(
                req.body || {}
              );

            return res
              .status(201)
              .json(result);
          } catch (error) {
            console.error(
              "LOTOFOOT IMPORT GRID ERROR :",
              error
            );

            const message =
              error?.message ||
              "Impossible d'importer la grille Loto Foot.";

            const isDuplicate =
              /existe déjà/i.test(
                message
              );

            return res
              .status(
                isDuplicate
                  ? 409
                  : 400
              )
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  message,
              });
          }
        }
      )
    );

    app.get(
      "/internal/lotofoot/grids",
      protectAdmin(
        async (req, res) => {
          try {
            const grids =
              await listGrids({
                limit:
                  req.query?.limit,
              });

            return res.json({
              ok: true,
              version:
                LOTOFOOT_VERSION,
              count:
                grids.length,
              grids,
              generatedAt:
                new Date().toISOString(),
            });
          } catch (error) {
            return res
              .status(500)
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  error?.message ||
                  "Impossible de lister les grilles.",
              });
          }
        }
      )
    );

    app.get(
      "/internal/lotofoot/grid/:gridId",
      protectAdmin(
        async (req, res) => {
          try {
            const grid =
              await getGrid(
                req.params.gridId
              );

            if (!grid) {
              return res
                .status(404)
                .json({
                  ok: false,
                  version:
                    LOTOFOOT_VERSION,
                  error:
                    "Grille Loto Foot introuvable.",
                });
            }

            return res.json({
              ok: true,
              version:
                LOTOFOOT_VERSION,
              grid,
              generatedAt:
                new Date().toISOString(),
            });
          } catch (error) {
            return res
              .status(500)
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  error?.message ||
                  "Impossible de charger la grille.",
              });
          }
        }
      )
    );


    app.post(
      "/internal/lotofoot/grid/:gridId/settle",
      protectAdmin(
        async (req, res) => {
          try {
            const result =
              await settleLotoFootGrid(
                req.params.gridId
              );

            return res.json(
              result
            );
          } catch (error) {
            console.error(
              "LOTOFOOT SETTLEMENT ERROR :",
              error
            );

            const message =
              error?.message ||
              "Impossible de régler la grille Loto Foot.";

            const isNotFound =
              /introuvable/i.test(
                message
              );

            const isBadRequest =
              /invalide/i.test(
                message
              );

            return res
              .status(
                isNotFound
                  ? 404
                  : isBadRequest
                    ? 400
                    : 500
              )
              .json({
                ok: false,
                version:
                  LOTOFOOT_VERSION,
                error:
                  message,
              });
          }
        }
      )
    );

    app.post(
      "/internal/lotofoot/ensure-tables",
      protectAdmin(
        async (req, res) => {
          try {
            await ensureTables();

            return res.json({
              ok: true,
              version:
                LOTOFOOT_VERSION,

              message:
                "Tables Loto Foot prêtes.",

              generatedAt:
                new Date().toISOString(),
            });
          } catch (error) {
            console.error(
              "LOTOFOOT ENSURE TABLES ERROR :",
              error
            );

            return res
              .status(500)
              .json({
                ok: false,
                error:
                  error?.message ||
                  "Impossible de préparer les tables Loto Foot.",
              });
          }
        }
      )
    );
  }


  async function settleLotoFootGrid(
    gridId
  ) {
    await ensureTables();

    const normalizedGridId =
      Number(gridId);

    if (
      !Number.isInteger(
        normalizedGridId
      ) ||
      normalizedGridId <= 0
    ) {
      throw new Error(
        "gridId invalide."
      );
    }

    const gridResult =
      await pool.query(
        `
          SELECT *
          FROM lotofoot_grids
          WHERE id = $1
          LIMIT 1
        `,
        [normalizedGridId]
      );

    const grid =
      gridResult.rows[0];

    if (!grid) {
      throw new Error(
        "Grille Loto Foot introuvable."
      );
    }

    const matchesResult =
      await pool.query(
        `
          SELECT *
          FROM lotofoot_matches
          WHERE grid_id = $1
          ORDER BY line_number ASC
        `,
        [normalizedGridId]
      );

    const summary = {
      total:
        matchesResult.rows.length,
      settledMatches: 0,
      pendingResults: 0,
      settledPredictions: 0,
      alreadySettledPredictions: 0,
      results: [],
    };

    for (
      const lotoMatch of
      matchesResult.rows
    ) {
      const fixtureId =
        Number(
          lotoMatch.fixture_id
        );

      if (
        !Number.isInteger(
          fixtureId
        ) ||
        fixtureId <= 0
      ) {
        summary.pendingResults += 1;

        summary.results.push({
          lineNumber:
            Number(
              lotoMatch.line_number
            ),
          fixtureId: null,
          status:
            "NO_FIXTURE",
        });

        continue;
      }

      /*
       * Source officielle interne :
       * table predictions de FootballBrain.
       * Aucun nouvel appel API-Football n'est nécessaire.
       */
      const footballResult =
        await pool.query(
          `
            SELECT
              fixture_id,
              result_status,
              home_goals,
              away_goals
            FROM predictions
            WHERE fixture_id = $1
              AND UPPER(
                COALESCE(
                  result_status,
                  ''
                )
              ) IN (
                'COMPLETED',
                'FINISHED',
                'FT',
                'AET',
                'PEN'
              )
              AND home_goals IS NOT NULL
              AND away_goals IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT 1
          `,
          [fixtureId]
        );

      const footballMatch =
        footballResult.rows[0];

      if (!footballMatch) {
        summary.pendingResults += 1;

        summary.results.push({
          lineNumber:
            Number(
              lotoMatch.line_number
            ),
          fixtureId,
          homeTeam:
            lotoMatch.home_team_name,
          awayTeam:
            lotoMatch.away_team_name,
          status:
            "RESULT_NOT_AVAILABLE",
        });

        continue;
      }

      const homeGoals =
        Number(
          footballMatch.home_goals
        );

      const awayGoals =
        Number(
          footballMatch.away_goals
        );

      let actualResult;

      if (homeGoals > awayGoals) {
        actualResult = "1";
      } else if (homeGoals < awayGoals) {
        actualResult = "2";
      } else {
        actualResult = "N";
      }

      const client =
        await pool.connect();

      try {
        await client.query(
          "BEGIN"
        );

        await client.query(
          `
            UPDATE lotofoot_matches
            SET
              final_result = $2,
              home_goals = $3,
              away_goals = $4,
              updated_at = NOW()
            WHERE id = $1
          `,
          [
            lotoMatch.id,
            actualResult,
            homeGoals,
            awayGoals,
          ]
        );

        const predictionsResult =
          await client.query(
            `
              SELECT *
              FROM lotofoot_predictions
              WHERE lotofoot_match_id = $1
              ORDER BY created_at ASC
            `,
            [lotoMatch.id]
          );

        let lineSettledPredictions =
          0;

        for (
          const prediction of
          predictionsResult.rows
        ) {
          const existingSettlement =
            await client.query(
              `
                SELECT id
                FROM lotofoot_settlements
                WHERE prediction_id = $1
                LIMIT 1
              `,
              [prediction.id]
            );

          if (
            existingSettlement
              .rows.length > 0
          ) {
            summary
              .alreadySettledPredictions +=
              1;

            continue;
          }

          const aiPick =
            normalizePick(
              prediction.ai_pick
            );

          const recommendedSelection =
            normalizeSelection(
              prediction
                .recommended_selection
            );

          const aiPickCorrect =
            aiPick
              ? aiPick === actualResult
              : null;

          const selectionCovered =
            recommendedSelection
              ? recommendedSelection
                  .includes(
                    actualResult
                  )
              : null;

          const baseScore =
            numberOr(
              prediction.base_score
            );

          const baseHit =
            baseScore >= 60 && aiPick
              ? aiPickCorrect
              : null;

          const trapScore =
            numberOr(
              prediction.trap_score
            );

          const trapEvent =
            trapScore >= 80 && aiPick
              ? !aiPickCorrect
              : false;

          const settlementInsert =
            await client.query(
              `
                INSERT INTO lotofoot_settlements (
                  prediction_id,
                  grid_id,
                  lotofoot_match_id,
                  actual_result,
                  ai_pick_correct,
                  selection_covered,
                  base_hit,
                  trap_event,
                  metadata,
                  settled_at
                )
                VALUES (
                  $1,
                  $2,
                  $3,
                  $4,
                  $5,
                  $6,
                  $7,
                  $8,
                  $9::jsonb,
                  NOW()
                )
                ON CONFLICT (
                  prediction_id
                )
                DO NOTHING
                RETURNING id
              `,
              [
                prediction.id,
                normalizedGridId,
                lotoMatch.id,
                actualResult,
                aiPickCorrect,
                selectionCovered,
                baseHit,
                trapEvent,
                JSON.stringify({
                  source:
                    "FOOTBALLBRAIN_PREDICTIONS",
                  fixtureId,
                  homeGoals,
                  awayGoals,
                  engineVersion:
                    prediction
                      .analysis_version ||
                    null,
                }),
              ]
            );

          if (
            settlementInsert.rows.length > 0
          ) {
            await client.query(
              `
                UPDATE lotofoot_predictions
                SET
                  status = 'SETTLED',
                  settled_at = NOW(),
                  updated_at = NOW()
                WHERE id = $1
              `,
              [prediction.id]
            );

            lineSettledPredictions +=
              1;

            summary
              .settledPredictions +=
              1;
          }
        }

        await client.query(
          "COMMIT"
        );

        summary.settledMatches +=
          1;

        summary.results.push({
          lineNumber:
            Number(
              lotoMatch.line_number
            ),
          fixtureId,
          homeTeam:
            lotoMatch.home_team_name,
          awayTeam:
            lotoMatch.away_team_name,
          score:
            `${homeGoals}-${awayGoals}`,
          actualResult,
          status:
            "SETTLED",
          settledPredictions:
            lineSettledPredictions,
        });
      } catch (error) {
        await client.query(
          "ROLLBACK"
        );

        throw error;
      } finally {
        client.release();
      }
    }

    return {
      ok: true,
      version:
        LOTOFOOT_VERSION,
      gridId:
        normalizedGridId,
      gridType:
        grid.grid_type,
      officialGridNumber:
        grid.official_grid_number,
      ...summary,
      complete:
        summary.settledMatches ===
        summary.total,
      generatedAt:
        new Date().toISOString(),
    };
  }

  async function initialize() {
    await ensureTables();

    console.log(
      "✅ LotoFootEngine initialisé",
      {
        version:
          LOTOFOOT_VERSION,

        mode:
          LOTOFOOT_MODE,

        schedulersEnabled:
          Boolean(
            schedulersEnabled
          ),
      }
    );
  }

  return {
    version:
      LOTOFOOT_VERSION,

    mode:
      LOTOFOOT_MODE,

    ensureTables,
    getStatus,
    importManualGrid,
    listGrids,
    getGrid,
    matchGridFixtures,
    analyzeGrid,
    getGridAnalysis,
    optimizeGrid,
    getOptimizationHistory,
    buildGridStrategies,
    getProtectionRanking,
    getGridIntelligence,
    settleLotoFootGrid,
    registerRoutes,
    initialize,

    helpers: {
      normalizeGridType,
      normalizePick,
      normalizeProbabilityTriple,
      clamp,
    },
  };
}

module.exports = {
  createLotoFootEngine,
};
