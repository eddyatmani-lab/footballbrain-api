/*
 * ============================================================
 * FOOTBALLBRAIN CORE
 * DECISION EXPLAINABILITY ENGINE
 * ============================================================
 *
 * Ce moteur transforme les entrées déjà utilisées par
 * FootballBrain en explications lisibles par un utilisateur.
 *
 * Important : les "points d'influence" sont des indicateurs
 * d'importance relatifs. Ils n'affirment pas qu'un facteur a,
 * à lui seul, ajouté exactement X points à la probabilité finale.
 */

const OUTCOME_LABELS = {
  home: "Victoire domicile",
  draw: "Match nul",
  away: "Victoire extérieur",
};

const SOURCE_LABELS = {
  form: "Forme des équipes",
  market: "Consensus du marché",
  monteCarlo: "Simulation Monte Carlo",
};

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeOutcome(value) {
  return Object.prototype.hasOwnProperty.call(OUTCOME_LABELS, value)
    ? value
    : "home";
}

function probabilityForOutcome(source, outcome) {
  return finiteNumber(source?.[outcome], null);
}

function buildSourceFactor({
  sourceKey,
  sourceProbabilities,
  weight,
  selectedOutcome,
  available = true,
}) {
  const probability = probabilityForOutcome(
    sourceProbabilities,
    selectedOutcome
  );

  const normalizedWeight = clamp(
    finiteNumber(weight, 0),
    0,
    1
  );

  if (!available || probability === null) {
    return {
      key: sourceKey,
      label: SOURCE_LABELS[sourceKey] || sourceKey,
      available: false,
      direction: "neutral",
      influencePoints: 0,
      weightPercent: round(normalizedWeight * 100, 1),
      sourceProbability: null,
      explanation: "Donnée indisponible pour cette analyse.",
    };
  }

  // Écart à une situation neutre 1N2 (33,3 %), pondéré par
  // l'importance réelle de la source dans FootballBrain.
  const influencePoints = round(
    (probability - 1 / 3) * normalizedWeight * 100,
    1
  );

  let direction = "neutral";
  if (influencePoints >= 0.5) direction = "positive";
  if (influencePoints <= -0.5) direction = "negative";

  const directionText =
    direction === "positive"
      ? "soutient ce scénario"
      : direction === "negative"
        ? "affaiblit ce scénario"
        : "reste neutre sur ce scénario";

  return {
    key: sourceKey,
    label: SOURCE_LABELS[sourceKey] || sourceKey,
    available: true,
    direction,
    influencePoints,
    weightPercent: round(normalizedWeight * 100, 1),
    sourceProbability: round(probability * 100, 1),
    explanation: `${SOURCE_LABELS[sourceKey] || sourceKey} ${directionText} (${round(
      probability * 100,
      1
    )} % selon cette source, poids ${round(normalizedWeight * 100, 1)} %).`,
  };
}

function buildMarketValueFactor({
  value,
  fairOdd,
  marketOdd,
  betStatus,
}) {
  const normalizedValue = finiteNumber(value, null);
  const normalizedFairOdd = finiteNumber(fairOdd, null);
  const normalizedMarketOdd = finiteNumber(marketOdd, null);

  if (normalizedValue === null) {
    return {
      key: "value",
      label: "Value de la cote",
      available: false,
      direction: "neutral",
      influencePoints: 0,
      explanation: "Aucune cote exploitable n'est disponible pour mesurer la value.",
    };
  }

  const influencePoints = round(
    clamp(normalizedValue / 2, -15, 15),
    1
  );

  const direction =
    normalizedValue >= 3
      ? "positive"
      : normalizedValue < 0
        ? "negative"
        : "neutral";

  let explanation;
  if (betStatus === "VALUE_BET") {
    explanation = `La cote marché (${normalizedMarketOdd ?? "N/A"}) dépasse la cote juste (${normalizedFairOdd ?? "N/A"}) : value estimée à ${normalizedValue} %.`;
  } else if (normalizedValue < 3) {
    explanation = `Le scénario peut être probable sans être rentable : value estimée à ${normalizedValue} %, sous le seuil de recommandation.`;
  } else {
    explanation = `Value estimée à ${normalizedValue} % pour une cote marché de ${normalizedMarketOdd ?? "N/A"}.`;
  }

  return {
    key: "value",
    label: "Value de la cote",
    available: true,
    direction,
    influencePoints,
    valuePercent: normalizedValue,
    fairOdd: normalizedFairOdd,
    marketOdd: normalizedMarketOdd,
    explanation,
  };
}

function buildConfidenceFactor({ confidence, probabilityGap, risk }) {
  const normalizedConfidence = finiteNumber(confidence, 50);
  const normalizedGap = finiteNumber(probabilityGap, 0);

  return {
    key: "confidence",
    label: "Séparation entre les scénarios",
    available: true,
    direction:
      normalizedGap >= 10
        ? "positive"
        : normalizedGap < 5
          ? "negative"
          : "neutral",
    influencePoints: round(clamp(normalizedGap / 2, -10, 10), 1),
    confidence: normalizedConfidence,
    probabilityGap: round(normalizedGap, 1),
    explanation: `L'écart avec le deuxième scénario est de ${round(normalizedGap, 1)} point(s). Confiance ${normalizedConfidence}/100, risque ${risk || "non défini"}.`,
  };
}

function createDecisionExplainability({
  selectedOutcome,
  selectedProbability,
  probabilities,
  weights,
  modelInputs,
  monteCarlo,
  confidence,
  risk,
  fairOdd,
  marketOdd,
  value,
  betStatus,
  probabilityGap,
} = {}) {
  const outcome = normalizeOutcome(selectedOutcome);
  const selectedLabel = OUTCOME_LABELS[outcome];

  const sourceFactors = [
    buildSourceFactor({
      sourceKey: "form",
      sourceProbabilities: modelInputs?.form,
      weight: weights?.form,
      selectedOutcome: outcome,
    }),
    buildSourceFactor({
      sourceKey: "market",
      sourceProbabilities: modelInputs?.market,
      weight: weights?.market,
      selectedOutcome: outcome,
    }),
    buildSourceFactor({
      sourceKey: "monteCarlo",
      sourceProbabilities: modelInputs?.monteCarlo,
      weight: weights?.monteCarlo,
      selectedOutcome: outcome,
      available: monteCarlo?.available !== false,
    }),
  ];

  const decisionFactors = [
    ...sourceFactors,
    buildConfidenceFactor({
      confidence,
      probabilityGap,
      risk,
    }),
    buildMarketValueFactor({
      value,
      fairOdd,
      marketOdd,
      betStatus,
    }),
  ];

  const rankedFactors = [...decisionFactors]
    .filter((factor) => factor.available)
    .sort(
      (a, b) =>
        Math.abs(b.influencePoints) -
        Math.abs(a.influencePoints)
    );

  const positiveFactors = rankedFactors.filter(
    (factor) => factor.direction === "positive"
  );
  const negativeFactors = rankedFactors.filter(
    (factor) => factor.direction === "negative"
  );

  const normalizedSelectedProbability = finiteNumber(
    selectedProbability,
    probabilities?.[outcome]
  );

  const recommendationText =
    betStatus === "VALUE_BET"
      ? "Le scénario le plus probable présente aussi une value suffisante."
      : betStatus === "À_SURVEILLER"
        ? "Le scénario est à surveiller, mais la marge de value reste limitée."
        : "Le scénario le plus probable ne constitue pas forcément un pari rentable.";

  return {
    version: "footballbrain-explainability-v1",
    methodology:
      "Les points d'influence indiquent la direction et l'importance relative de chaque source dans le modèle pondéré. Ils ne doivent pas être additionnés à la probabilité finale.",
    selectedOutcome: outcome,
    selectedLabel,
    selectedProbability: normalizedSelectedProbability,
    headline: `Pourquoi ${selectedLabel} à ${normalizedSelectedProbability ?? "N/A"} % ?`,
    summary: `${selectedLabel} ressort en tête après combinaison de la forme, du marché et des simulations. ${recommendationText}`,
    factors: rankedFactors,
    topFactors: rankedFactors.slice(0, 5),
    supportingFactors: positiveFactors.slice(0, 3),
    limitingFactors: negativeFactors.slice(0, 3),
    sourceAgreement: {
      monteCarloAgrees: monteCarlo?.agrees ?? null,
      monteCarloFavorite: monteCarlo?.favorite ?? null,
      sourcesSupportingOutcome: sourceFactors.filter(
        (factor) => factor.direction === "positive"
      ).length,
      sourcesAvailable: sourceFactors.filter(
        (factor) => factor.available
      ).length,
    },
  };
}

module.exports = {
  createDecisionExplainability,
};
