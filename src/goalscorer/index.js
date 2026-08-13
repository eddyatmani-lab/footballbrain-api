"use strict";

/*
 * ============================================================
 * FOOTBALL AI PRO — GOALSCORER ENGINE V2
 * ============================================================
 *
 * Principes V2 :
 * 1) Brain Studio / xG équipe = ancre principale.
 * 2) Les xG équipe sont répartis entre les joueurs.
 * 3) Les petits échantillons sont shrinkés vers un prior par poste.
 * 4) Les données incohérentes sont dégradées ou rejetées.
 * 5) Les cotes sont appariées STRICTEMENT au bon marché.
 * 6) La garantie remplaçant reste distincte et prudente.
 * 7) Le Learning n'utilise QUE les prédictions V2.
 */

const GOALSCORER_VERSION =
  "goalscorer-engine-v2.6.1-first-analysis-fix";

const GOALSCORER_LEARNING_GENERATION =
  "goalscorer-probability-v2";

const GOALSCORER_RECOMMENDATION_GENERATION =
  "goalscorer-recommendation-v1";

const LEARNING_APPLICATION_MIN_SAMPLE = 150;

const MARKET_TYPES = Object.freeze({
  ANYTIME: "ANYTIME_GOALSCORER",
  REPLACEMENT: "SCORER_OR_REPLACEMENT",
});

const FINISHED_90 = new Set(["FT"]);
const FINISHED_EXTRA = new Set(["AET", "PEN"]);

const POSITION_PRIORS = Object.freeze({
  ATTACKER: {
    goalsPer90: 0.34,
    shotsPer90: 2.4,
    shotsOnPer90: 1.0,
    expectedMinutesStarter: 76,
  },
  MIDFIELDER: {
    goalsPer90: 0.14,
    shotsPer90: 1.35,
    shotsOnPer90: 0.48,
    expectedMinutesStarter: 78,
  },
  DEFENDER: {
    goalsPer90: 0.055,
    shotsPer90: 0.55,
    shotsOnPer90: 0.18,
    expectedMinutesStarter: 82,
  },
  UNKNOWN: {
    goalsPer90: 0.12,
    shotsPer90: 1.0,
    shotsOnPer90: 0.35,
    expectedMinutesStarter: 75,
  },
});

const SHRINKAGE_PRIOR_MINUTES = 900;

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, numberOr(value)));
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function normalizeToken(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function probabilityFromLambda(lambda) {
  return clamp((1 - Math.exp(-clamp(lambda, 0, 2.5))) * 100, 0.1, 88);
}

function impliedProbability(odd) {
  const n = numberOrNull(odd);
  if (!n || n <= 1) return null;
  return 100 / n;
}

function fairOdd(probability) {
  const p = numberOr(probability) / 100;
  if (p <= 0) return null;
  return round(1 / p, 2);
}

function positionGroup(position) {
  const normalized = normalizeToken(position);

  if (
    normalized.includes("ATT") ||
    normalized.includes("FORWARD") ||
    normalized === "F"
  ) {
    return "ATTACKER";
  }

  if (
    normalized.includes("MID") ||
    normalized === "M"
  ) {
    return "MIDFIELDER";
  }

  if (
    normalized.includes("DEF") ||
    normalized === "D"
  ) {
    return "DEFENDER";
  }

  if (
    normalized.includes("GOAL") ||
    normalized === "G"
  ) {
    return "GOALKEEPER";
  }

  return "UNKNOWN";
}

function probabilityBucket(probability) {
  const p = numberOr(probability);
  if (p < 10) return "00_10";
  if (p < 20) return "10_20";
  if (p < 30) return "20_30";
  if (p < 40) return "30_40";
  if (p < 50) return "40_50";
  return "50_PLUS";
}

function dataReliability(sampleMinutes, anomalyCount) {
  const minutes = numberOr(sampleMinutes);
  const anomalies = numberOr(anomalyCount);

  if (anomalies >= 2) return "LOW";
  if (minutes >= 900 && anomalies === 0) return "HIGH";
  if (minutes >= 450) return "MEDIUM";
  return "LOW";
}

function validatePlayerSample({
  appearances,
  starts,
  minutes,
  goals,
  shots,
  shotsOnTarget,
}) {
  const anomalies = [];

  if (minutes < 0 || appearances < 0 || starts < 0) {
    anomalies.push("NEGATIVE_SAMPLE");
  }

  if (starts > appearances && appearances > 0) {
    anomalies.push("STARTS_GT_APPEARANCES");
  }

  if (appearances >= 3 && starts >= 3 && minutes / Math.max(starts, 1) < 35) {
    anomalies.push("START_MINUTES_TOO_LOW");
  }

  if (minutes > appearances * 130) {
    anomalies.push("MINUTES_TOO_HIGH");
  }

  if (goals > Math.max(appearances * 3, 10)) {
    anomalies.push("GOALS_IMPLAUSIBLE");
  }

  if (shotsOnTarget > shots && shots > 0) {
    anomalies.push("SHOTS_ON_GT_SHOTS");
  }

  return anomalies;
}

function shrinkRate({
  observedCount,
  observedMinutes,
  priorRatePer90,
  priorMinutes = SHRINKAGE_PRIOR_MINUTES,
}) {
  const obsMinutes = Math.max(0, numberOr(observedMinutes));
  const obsCount = Math.max(0, numberOr(observedCount));
  const priorGoals = priorRatePer90 * priorMinutes / 90;

  return (
    (obsCount + priorGoals) /
    Math.max(1, obsMinutes + priorMinutes)
  ) * 90;
}

function shrinkContinuousRate({
  observedRatePer90,
  observedMinutes,
  priorRatePer90,
  priorMinutes = SHRINKAGE_PRIOR_MINUTES,
}) {
  const obsMinutes = Math.max(0, numberOr(observedMinutes));
  const obsRate = Math.max(0, numberOr(observedRatePer90));
  return (
    obsRate * obsMinutes +
    priorRatePer90 * priorMinutes
  ) / Math.max(1, obsMinutes + priorMinutes);
}

function aggregatePlayerStats(playerResponse, teamId) {
  const statistics = Array.isArray(playerResponse?.statistics)
    ? playerResponse.statistics
    : [];

  const relevant = statistics.filter((stat) => {
    const statTeamId = Number(stat?.team?.id);
    return !teamId || !statTeamId || statTeamId === Number(teamId);
  });

  const rows = relevant.length > 0 ? relevant : statistics;

  let appearances = 0;
  let starts = 0;
  let minutes = 0;
  let goals = 0;
  let shots = 0;
  let shotsOnTarget = 0;
  let penaltyGoals = 0;
  let substituteIns = 0;
  let position = null;

  for (const stat of rows) {
    const games = stat?.games || {};
    const goal = stat?.goals || {};
    const shot = stat?.shots || {};
    const penalty = stat?.penalty || {};
    const substitutes = stat?.substitutes || {};

    appearances += Math.max(
      0,
      numberOr(games.appearences ?? games.appearances)
    );
    starts += Math.max(0, numberOr(games.lineups));
    minutes += Math.max(0, numberOr(games.minutes));
    goals += Math.max(0, numberOr(goal.total));
    shots += Math.max(0, numberOr(shot.total));
    shotsOnTarget += Math.max(0, numberOr(shot.on));
    penaltyGoals += Math.max(0, numberOr(penalty.scored));
    substituteIns += Math.max(0, numberOr(substitutes.in));

    if (!position && games.position) {
      position = games.position;
    }
  }

  return {
    appearances,
    starts,
    minutes,
    goals,
    shots,
    shotsOnTarget,
    penaltyGoals,
    substituteIns,
    position,
  };
}

function buildPlayerProfile({
  playerResponse,
  teamId,
  injured,
  lineupState,
}) {
  const player = playerResponse?.player || {};
  const agg = aggregatePlayerStats(playerResponse, teamId);
  const group = positionGroup(agg.position || player.position);
  const prior = POSITION_PRIORS[group] || POSITION_PRIORS.UNKNOWN;

  const anomalies = validatePlayerSample(agg);

  const observedAvgMinutes =
    agg.appearances > 0 ? agg.minutes / agg.appearances : 0;

  const observedGoalsPer90 =
    agg.minutes > 0 ? (agg.goals * 90) / agg.minutes : 0;

  const observedShotsPer90 =
    agg.minutes > 0 ? (agg.shots * 90) / agg.minutes : 0;

  const observedShotsOnPer90 =
    agg.minutes > 0 ? (agg.shotsOnTarget * 90) / agg.minutes : 0;

  const posteriorGoalsPer90 = shrinkRate({
    observedCount: agg.goals,
    observedMinutes: agg.minutes,
    priorRatePer90: prior.goalsPer90,
  });

  const posteriorShotsPer90 = shrinkContinuousRate({
    observedRatePer90: observedShotsPer90,
    observedMinutes: agg.minutes,
    priorRatePer90: prior.shotsPer90,
  });

  const posteriorShotsOnPer90 = shrinkContinuousRate({
    observedRatePer90: observedShotsOnPer90,
    observedMinutes: agg.minutes,
    priorRatePer90: prior.shotsOnPer90,
  });

  const starterRate =
    agg.appearances > 0
      ? clamp(agg.starts / agg.appearances, 0, 1)
      : 0.5;

  let starterProbability =
    clamp(
      (starterRate * 0.72 +
        clamp(observedAvgMinutes / 90, 0, 1) * 0.28) *
        100,
      8,
      98
    );

  if (anomalies.includes("START_MINUTES_TOO_LOW")) {
    starterProbability = clamp(
      starterRate * 65 + 20,
      20,
      80
    );
  }

  if (lineupState === "STARTER") {
    starterProbability = 100;
  } else if (lineupState === "SUBSTITUTE") {
    starterProbability = 2;
  }

  if (injured) {
    starterProbability = Math.min(starterProbability, 12);
  }

  const starterMinutesBase =
    agg.minutes >= 270 && anomalies.length === 0
      ? clamp(observedAvgMinutes, 55, 90)
      : prior.expectedMinutesStarter;

  let expectedMinutes;

  if (lineupState === "STARTER") {
    expectedMinutes = clamp(starterMinutesBase, 55, 90);
  } else if (lineupState === "SUBSTITUTE") {
    expectedMinutes = 24;
  } else {
    expectedMinutes = clamp(
      (starterProbability / 100) * starterMinutesBase +
        (1 - starterProbability / 100) * 22,
      18,
      88
    );
  }

  if (injured) {
    expectedMinutes *= 0.35;
  }

  const sampleReliability = dataReliability(
    agg.minutes,
    anomalies.length
  );

  const attackingIndex =
    clamp(
      posteriorGoalsPer90 * 0.52 +
        posteriorShotsOnPer90 * 0.20 +
        posteriorShotsPer90 * 0.055 +
        (agg.penaltyGoals > 0 ? 0.08 : 0) +
        (group === "ATTACKER"
          ? 0.08
          : group === "MIDFIELDER"
            ? 0.03
            : 0),
      0.03,
      2.0
    );

  let dataQuality = 100;

  if (agg.minutes < 900) dataQuality -= 10;
  if (agg.minutes < 450) dataQuality -= 10;
  if (agg.minutes < 180) dataQuality -= 12;
  if (lineupState === "UNKNOWN") dataQuality -= 8;
  if (anomalies.length > 0) dataQuality -= anomalies.length * 12;
  if (injured) dataQuality -= 20;

  dataQuality = clamp(dataQuality, 20, 100);

  return {
    playerId: Number(player.id),
    playerName:
      player.name ||
      `${player.firstname || ""} ${player.lastname || ""}`.trim(),
    position: agg.position || player.position || null,
    positionGroup: group,

    appearances: agg.appearances,
    starts: agg.starts,
    minutes: agg.minutes,
    avgMinutes: round(observedAvgMinutes, 2),

    goals: agg.goals,
    goalsPer90: round(observedGoalsPer90, 4),
    posteriorGoalsPer90: round(posteriorGoalsPer90, 4),

    shots: agg.shots,
    shotsPer90: round(observedShotsPer90, 4),
    posteriorShotsPer90: round(posteriorShotsPer90, 4),

    shotsOnTarget: agg.shotsOnTarget,
    shotsOnTargetPer90: round(observedShotsOnPer90, 4),
    posteriorShotsOnTargetPer90: round(posteriorShotsOnPer90, 4),

    penaltyGoals: agg.penaltyGoals,
    substituteIns: agg.substituteIns,

    injured: Boolean(injured),
    lineupState,
    starterProbability: round(starterProbability, 2),
    expectedMinutes: round(expectedMinutes, 1),

    attackingIndex: round(attackingIndex, 5),
    sampleReliability,
    anomalies,
    dataQuality: round(dataQuality, 1),
  };
}

function buildRecommendation({
  probability,
  dataQuality,
  sampleReliability,
  anomalies,
  expectedMinutes,
  starterProbability,
  injured,
  lineupState,
}) {
  const p = clamp(probability, 0, 100);
  const quality = clamp(dataQuality, 0, 100);
  const minutes = clamp(expectedMinutes, 0, 90);
  const starter = clamp(starterProbability, 0, 100);
  const anomalyCount = Array.isArray(anomalies) ? anomalies.length : 0;

  const reliabilityScore =
    sampleReliability === "HIGH" ? 100 :
    sampleReliability === "MEDIUM" ? 70 : 35;

  let score =
    clamp((p / 50) * 100, 0, 100) * 0.40 +
    clamp((minutes / 90) * 100, 0, 100) * 0.20 +
    starter * 0.15 +
    quality * 0.15 +
    reliabilityScore * 0.10;

  if (lineupState === "STARTER") score += 3;
  if (lineupState === "SUBSTITUTE") score -= 8;
  if (injured) score -= 25;
  score -= anomalyCount * 8;
  score = round(clamp(score, 0, 100), 1);

  const reasons = [];
  if (p >= 38) reasons.push("HIGH_GOAL_PROBABILITY");
  else if (p >= 28) reasons.push("GOOD_GOAL_PROBABILITY");
  else if (p >= 17) reasons.push("WATCH_GOAL_PROBABILITY");
  else reasons.push("LOW_GOAL_PROBABILITY");
  if (minutes >= 75) reasons.push("HIGH_EXPECTED_MINUTES");
  else if (minutes < 50) reasons.push("LOW_EXPECTED_MINUTES");
  if (starter >= 75) reasons.push("LIKELY_STARTER");
  else if (starter < 55) reasons.push("STARTER_UNCERTAINTY");
  if (quality >= 75) reasons.push("HIGH_DATA_QUALITY");
  else if (quality < 60) reasons.push("LIMITED_DATA_QUALITY");
  if (sampleReliability === "HIGH") reasons.push("RELIABLE_SAMPLE");
  else if (sampleReliability === "LOW") reasons.push("LOW_SAMPLE_RELIABILITY");
  if (anomalyCount > 0) reasons.push("DATA_ANOMALY");
  if (injured) reasons.push("INJURY_FLAG");

  let tier = "REJECTED";
  if (
    !injured && anomalyCount < 2 && score >= 80 && p >= 38 &&
    quality >= 75 && minutes >= 65 && starter >= 75 &&
    sampleReliability !== "LOW"
  ) tier = "TOP_SCORER";
  else if (
    !injured && anomalyCount < 2 && score >= 65 && p >= 28 &&
    quality >= 60 && minutes >= 50 && starter >= 55
  ) tier = "RECOMMENDED";
  else if (
    !injured && anomalyCount < 2 && score >= 45 && p >= 17 &&
    quality >= 45
  ) tier = "WATCH";

  return { score, tier, reasons };
}

function scorerStatus(input) {
  return buildRecommendation(input).tier;
}

function teamGoalAverage(stats, side) {
  const goals = stats?.goals?.for?.average || {};
  return numberOr(goals?.[side] ?? goals?.total, 1.35);
}

function opponentConcededAverage(stats, side) {
  const conceded = stats?.goals?.against?.average || {};
  return numberOr(conceded?.[side] ?? conceded?.total, 1.35);
}

function fallbackExpectedTeamGoals({
  teamStats,
  opponentStats,
  homeAway,
}) {
  const ownSide = homeAway === "HOME" ? "home" : "away";
  const opponentSide = homeAway === "HOME" ? "away" : "home";

  const own = teamGoalAverage(teamStats, ownSide);
  const conceded = opponentConcededAverage(opponentStats, opponentSide);

  return clamp(own * 0.55 + conceded * 0.45, 0.35, 3.5);
}

function resolveBrainTeamXg({
  dbRow,
  homeAway,
  fallback,
}) {
  const brainValue =
    homeAway === "HOME"
      ? numberOrNull(dbRow?.official_xg_home)
      : numberOrNull(dbRow?.official_xg_away);

  if (brainValue !== null && brainValue > 0) {
    return {
      value: clamp(brainValue, 0.2, 4.5),
      source: "BRAIN_STUDIO_OFFICIAL_XG",
    };
  }

  return {
    value: fallback,
    source: "TEAM_STATS_FALLBACK",
  };
}

function exactMarketNameMatch(betName, marketType) {
  const name = normalizeText(betName);

  const scorerWord =
    /\b(goal ?scorer|goalscorer|buteur|to score)\b/.test(name);

  if (!scorerWord) return false;

  const firstLast =
    /\b(first|1st|premier|last|dernier)\b/.test(name);

  const sideSpecific =
    /\b(home first|away first|home last|away last)\b/.test(name);

  if (marketType === MARKET_TYPES.ANYTIME) {
    if (firstLast || sideSpecific) return false;

    return (
      /\b(anytime|any time|tout moment)\b/.test(name) ||
      /\b(player to score)\b/.test(name)
    );
  }

  if (marketType === MARKET_TYPES.REPLACEMENT) {
    return (
      !firstLast &&
      /\b(replacement|substitute|remplacant|remplacante|coaching)\b/.test(name)
    );
  }

  return false;
}

function scanOddsForPlayer({
  oddsResponse,
  playerName,
  marketType,
}) {
  const normalizedPlayer = normalizeText(playerName);
  if (!normalizedPlayer) return null;

  const matches = [];

  for (const fixture of Array.isArray(oddsResponse) ? oddsResponse : []) {
    for (const bookmaker of fixture?.bookmakers || []) {
      for (const bet of bookmaker?.bets || []) {
        if (!exactMarketNameMatch(bet?.name, marketType)) {
          continue;
        }

        for (const value of bet?.values || []) {
          const valueName = normalizeText(value?.value);

          if (
            !valueName ||
            !(
              valueName.includes(normalizedPlayer) ||
              normalizedPlayer.includes(valueName)
            )
          ) {
            continue;
          }

          const odd = numberOrNull(value?.odd);
          if (!odd || odd <= 1) continue;

          matches.push({
            odd,
            bookmakerId: bookmaker?.id ?? null,
            bookmakerName: bookmaker?.name ?? null,
            betId: bet?.id ?? null,
            betName: bet?.name ?? null,
            value: value?.value ?? null,
          });
        }
      }
    }
  }

  if (matches.length === 0) return null;

  return [...matches].sort((a, b) => b.odd - a.odd)[0];
}

async function fetchPagedPlayers({
  callApiFootball,
  teamId,
  season,
  leagueId = null,
}) {
  const rows = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= 8) {
    const params = {
      team: teamId,
      season,
      page,
    };

    if (leagueId) {
      params.league = leagueId;
    }

    const response = await callApiFootball("/players", params);
    const payload = response?.data || {};

    rows.push(
      ...(Array.isArray(payload.response) ? payload.response : [])
    );

    totalPages = Math.max(1, numberOr(payload?.paging?.total, 1));
    page += 1;
  }

  return rows;
}

function statIdentity(stat) {
  const teamId = Number(stat?.team?.id) || 0;
  const leagueId = Number(stat?.league?.id) || 0;
  const season = Number(stat?.league?.season) || 0;

  /*
   * API-Football peut renvoyer le même bloc statistique :
   * - dans /players?team=...&season=...
   * - puis à nouveau dans /players?team=...&season=...&league=...
   *
   * Pour le même joueur, la combinaison équipe + compétition + saison
   * doit donc être unique dans notre profil agrégé.
   */
  return `${teamId}:${leagueId}:${season}`;
}

function statCompletenessScore(stat) {
  const games = stat?.games || {};
  const goals = stat?.goals || {};
  const shots = stat?.shots || {};
  const penalty = stat?.penalty || {};
  const substitutes = stat?.substitutes || {};

  const values = [
    games.appearences ?? games.appearances,
    games.lineups,
    games.minutes,
    games.position,
    goals.total,
    shots.total,
    shots.on,
    penalty.scored,
    substitutes.in,
    substitutes.out,
  ];

  return values.reduce(
    (score, value) =>
      score +
      (value !== null &&
      value !== undefined &&
      value !== ""
        ? 1
        : 0),
    0
  );
}

function mergePlayerResponses(primary, secondary) {
  const byPlayer = new Map();

  /*
   * IMPORTANT V2.1 :
   * on fusionne les deux endpoints sans additionner deux fois
   * le même bloc de compétition.
   */
  for (const source of [primary, secondary]) {
    for (const row of source || []) {
      const id = Number(row?.player?.id);
      if (!id) continue;

      if (!byPlayer.has(id)) {
        byPlayer.set(id, {
          player: row.player,
          statisticsByKey: new Map(),
        });
      }

      const entry = byPlayer.get(id);

      /*
       * Conserve les infos joueur les plus complètes si l'un
       * des deux appels API en retourne davantage.
       */
      if (
        row?.player &&
        Object.keys(row.player).length >
          Object.keys(entry.player || {}).length
      ) {
        entry.player = row.player;
      }

      for (const stat of Array.isArray(row?.statistics)
        ? row.statistics
        : []) {
        const key = statIdentity(stat);

        if (!entry.statisticsByKey.has(key)) {
          entry.statisticsByKey.set(key, stat);
          continue;
        }

        /*
         * Si deux blocs ont la même identité mais ne sont pas
         * strictement identiques, on garde le plus complet au lieu
         * de les additionner.
         */
        const existing = entry.statisticsByKey.get(key);

        if (
          statCompletenessScore(stat) >
          statCompletenessScore(existing)
        ) {
          entry.statisticsByKey.set(key, stat);
        }
      }
    }
  }

  return [...byPlayer.values()].map((entry) => ({
    player: entry.player,
    statistics: [...entry.statisticsByKey.values()],
  }));
}

function allocateTeamXg({
  profiles,
  teamExpectedGoals,
}) {
  const eligible = profiles.filter(
    (p) =>
      p.positionGroup !== "GOALKEEPER" &&
      p.expectedMinutes >= 10 &&
      p.dataQuality >= 35
  );

  const rawWeights = eligible.map((profile) => {
    const minutesShare = clamp(profile.expectedMinutes / 90, 0.08, 1);
    const starterExposure = clamp(
      0.35 + profile.starterProbability / 100 * 0.65,
      0.35,
      1
    );

    const reliabilityPenalty =
      profile.sampleReliability === "LOW"
        ? 0.88
        : profile.sampleReliability === "MEDIUM"
          ? 0.96
          : 1;

    const anomalyPenalty =
      Math.max(0.65, 1 - profile.anomalies.length * 0.12);

    const weight =
      profile.attackingIndex *
      minutesShare *
      starterExposure *
      reliabilityPenalty *
      anomalyPenalty;

    return Math.max(0.01, weight);
  });

  const totalWeight = rawWeights.reduce((sum, n) => sum + n, 0);

  return eligible.map((profile, index) => {
    const share =
      totalWeight > 0
        ? rawWeights[index] / totalWeight
        : 1 / Math.max(1, eligible.length);

    /*
     * Contrôle de cohérence :
     * la somme des lambda individuels est égale à l'xG équipe.
     */
    const lambda = clamp(teamExpectedGoals * share, 0.005, 1.35);
    const probability = probabilityFromLambda(lambda);

    return {
      ...profile,
      allocationShare: round(share * 100, 3),
      rawLambda: round(lambda, 5),
      anytimeProbability: round(probability, 2),
    };
  });
}

function replacementCoverageProbability({
  player,
  teamProfiles,
}) {
  /*
   * V2 : couverture prudente.
   * On estime seulement l'exposition au scénario "joueur non titulaire".
   * Le moteur n'invente pas un remplaçant spécifique.
   */
  const notStarter = clamp(1 - player.starterProbability / 100, 0, 1);

  const replacementPool = teamProfiles
    .filter(
      (p) =>
        p.playerId !== player.playerId &&
        (p.positionGroup === "ATTACKER" ||
          p.positionGroup === "MIDFIELDER") &&
        p.expectedMinutes >= 15
    )
    .sort((a, b) => b.anytimeProbability - a.anytimeProbability)
    .slice(0, 4);

  if (replacementPool.length === 0) {
    return {
      conditionalReplacementProbability: 0,
      boost: 0,
    };
  }

  const average =
    replacementPool.reduce(
      (sum, p) => sum + p.anytimeProbability,
      0
    ) / replacementPool.length;

  const conditionalReplacementProbability = clamp(
    average * 0.45,
    2,
    18
  );

  /*
   * Boost plafonné : on reste conservateur tant qu'on ne connaît
   * pas la règle exacte et le remplaçant réel.
   */
  const boost = clamp(
    notStarter * conditionalReplacementProbability,
    0,
    8
  );

  return {
    conditionalReplacementProbability: round(
      conditionalReplacementProbability,
      2
    ),
    boost: round(boost, 2),
  };
}

function createGoalscorerEngine({
  app,
  pool,
  callApiFootball,
  adminGuard,
  schedulersEnabled = true,
}) {
  let tablesReady = false;
  let ensurePromise = null;
  let schedulerTimer = null;
  let schedulerRunning = false;

  const guards =
    typeof adminGuard === "function" ? [adminGuard] : [];

  async function ensureTables() {
    if (tablesReady) return;
    if (ensurePromise) return ensurePromise;

    ensurePromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS goalscorer_predictions (
          id BIGSERIAL PRIMARY KEY,

          fixture_id BIGINT NOT NULL,
          fixture_date TIMESTAMPTZ,
          league_id BIGINT,
          season INTEGER,

          team_id BIGINT NOT NULL,
          opponent_id BIGINT,
          home_away TEXT,

          player_id BIGINT NOT NULL,
          player_name TEXT NOT NULL,
          position TEXT,
          position_group TEXT,

          market_type TEXT NOT NULL,
          replacement_guarantee BOOLEAN NOT NULL DEFAULT FALSE,

          starter_probability NUMERIC(8,4),
          expected_minutes NUMERIC(8,3),

          appearances INTEGER,
          starts INTEGER,
          minutes INTEGER,
          goals INTEGER,
          goals_per90 NUMERIC(10,5),
          shots INTEGER,
          shots_per90 NUMERIC(10,5),
          shots_on_target INTEGER,
          shots_on_target_per90 NUMERIC(10,5),
          penalty_goals INTEGER,

          team_expected_goals NUMERIC(10,5),
          team_average_goals NUMERIC(10,5),
          opponent_conceded_average NUMERIC(10,5),

          anytime_probability NUMERIC(8,4),
          guarantee_boost NUMERIC(8,4),
          predicted_probability NUMERIC(8,4) NOT NULL,
          fair_odd NUMERIC(10,4),

          market_odd NUMERIC(10,4),
          odd_source TEXT,
          bookmaker_id BIGINT,
          bookmaker_name TEXT,
          api_bet_id BIGINT,
          api_bet_name TEXT,
          value_edge NUMERIC(10,4),

          data_quality NUMERIC(8,3),
          scorer_status TEXT NOT NULL,

          injured BOOLEAN NOT NULL DEFAULT FALSE,
          lineup_state TEXT NOT NULL DEFAULT 'UNKNOWN',

          model_version TEXT NOT NULL,
          model_inputs JSONB,
          raw_player JSONB,

          result_status TEXT NOT NULL DEFAULT 'PENDING',
          scored BOOLEAN,
          player_goals INTEGER,
          replacement_player_id BIGINT,
          replacement_player_name TEXT,
          replacement_scored BOOLEAN,
          settlement_note TEXT,

          profit_units NUMERIC(10,4),

          analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          settled_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

          UNIQUE (fixture_id, player_id, market_type)
        );
      `);

      await pool.query(`
        ALTER TABLE goalscorer_predictions
        ADD COLUMN IF NOT EXISTS sample_reliability TEXT;
      `);

      await pool.query(`
        ALTER TABLE goalscorer_predictions
        ADD COLUMN IF NOT EXISTS anomaly_flags JSONB;
      `);

      await pool.query(`
        ALTER TABLE goalscorer_predictions
        ADD COLUMN IF NOT EXISTS xg_source TEXT;
      `);

      await pool.query(`
        ALTER TABLE goalscorer_predictions
        ADD COLUMN IF NOT EXISTS allocation_share NUMERIC(10,5);
      `);

      await pool.query(`
        ALTER TABLE goalscorer_predictions
        ADD COLUMN IF NOT EXISTS posterior_goals_per90 NUMERIC(10,5);
      `);

      await pool.query(`
        ALTER TABLE goalscorer_predictions
        ADD COLUMN IF NOT EXISTS recommendation_score NUMERIC(8,3);
      `);

      await pool.query(`
        ALTER TABLE goalscorer_predictions
        ADD COLUMN IF NOT EXISTS recommendation_tier TEXT;
      `);

      await pool.query(`
        ALTER TABLE goalscorer_predictions
        ADD COLUMN IF NOT EXISTS recommendation_reasons JSONB;
      `);

      await pool.query(`
        ALTER TABLE goalscorer_predictions
        ADD COLUMN IF NOT EXISTS learning_generation TEXT;
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_goalscorer_predictions_learning_generation
        ON goalscorer_predictions (
          learning_generation,
          result_status,
          fixture_date
        );
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_goalscorer_predictions_fixture
        ON goalscorer_predictions (fixture_id);
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_goalscorer_predictions_pending
        ON goalscorer_predictions (result_status, fixture_date);
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS goalscorer_learning_stats (
          id BIGSERIAL PRIMARY KEY,

          market_type TEXT NOT NULL,
          probability_bucket TEXT NOT NULL,
          position_group TEXT NOT NULL,

          sample_size INTEGER NOT NULL DEFAULT 0,
          wins INTEGER NOT NULL DEFAULT 0,
          losses INTEGER NOT NULL DEFAULT 0,

          average_predicted_probability NUMERIC(10,5),
          actual_score_rate NUMERIC(10,5),
          calibration_gap NUMERIC(10,5),
          brier_score NUMERIC(10,6),

          bets_with_odds INTEGER NOT NULL DEFAULT 0,
          profit_units NUMERIC(12,5),
          roi_percentage NUMERIC(10,5),

          reliability_level TEXT NOT NULL,
          learning_version TEXT NOT NULL,

          calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

          UNIQUE (market_type, probability_bucket, position_group)
        );
      `);


      await pool.query(`
        ALTER TABLE goalscorer_learning_stats
        ADD COLUMN IF NOT EXISTS suggested_probability_adjustment NUMERIC(10,5);
      `);

      await pool.query(`
        ALTER TABLE goalscorer_learning_stats
        ADD COLUMN IF NOT EXISTS application_ready BOOLEAN NOT NULL DEFAULT FALSE;
      `);

      await pool.query(`
        ALTER TABLE goalscorer_learning_stats
        ADD COLUMN IF NOT EXISTS learning_generation TEXT;
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS goalscorer_recommendation_learning (
          id BIGSERIAL PRIMARY KEY,

          market_type TEXT NOT NULL,
          recommendation_tier TEXT NOT NULL,

          sample_size INTEGER NOT NULL DEFAULT 0,
          wins INTEGER NOT NULL DEFAULT 0,
          losses INTEGER NOT NULL DEFAULT 0,

          average_predicted_probability NUMERIC(10,5),
          actual_score_rate NUMERIC(10,5),
          calibration_gap NUMERIC(10,5),
          brier_score NUMERIC(10,6),

          reliability_level TEXT NOT NULL,
          application_ready BOOLEAN NOT NULL DEFAULT FALSE,

          learning_generation TEXT NOT NULL,
          calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

          UNIQUE (
            market_type,
            recommendation_tier,
            learning_generation
          )
        );
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS goalscorer_learning_runs (
          id BIGSERIAL PRIMARY KEY,
          run_type TEXT NOT NULL,
          status TEXT NOT NULL,
          rows_processed INTEGER NOT NULL DEFAULT 0,
          summary JSONB,
          error_message TEXT,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          finished_at TIMESTAMPTZ
        );
      `);

      /*
       * V2.4 est la première génération publique stable du modèle.
       * On la rattache à la génération probabiliste V2 pour ne pas
       * perdre ses résultats au prochain déploiement.
       */
      await pool.query(
        `
          UPDATE goalscorer_predictions
          SET learning_generation = $1
          WHERE learning_generation IS NULL
            AND model_version IN ($2, $3)
        `,
        [
          GOALSCORER_LEARNING_GENERATION,
          "goalscorer-engine-v2.4.0-brain-studio-public",
          GOALSCORER_VERSION,
        ]
      );

      /*
       * Les prédictions V1 étaient des tests exploratoires.
       * On les retire pour éviter de contaminer le Learning V2
       * et pour libérer la contrainte UNIQUE fixture/player/market.
       */
      await pool.query(
        `
          DELETE FROM goalscorer_predictions
          WHERE model_version IN ($1, $2, $3)
        `,
        [
          "goalscorer-engine-v1.0.0",
          "goalscorer-engine-v2.0.0",
          "goalscorer-engine-v2.1.0-deduplicated-stats",
        ]
      );


      tablesReady = true;
    })();

    try {
      await ensurePromise;
    } finally {
      ensurePromise = null;
    }
  }

  async function getFixtureContext(fixtureId) {
    const dbResult = await pool.query(
      `
        SELECT
          fixture_id,
          fixture_date,
          league_id,
          league_name,
          home_team_id,
          home_team_name,
          away_team_id,
          away_team_name,
          official_xg_home,
          official_xg_away,
          result_status,
          home_goals,
          away_goals
        FROM predictions
        WHERE fixture_id = $1
        LIMIT 1
      `,
      [fixtureId]
    );

    const dbRow = dbResult.rows[0] || null;

    const fixtureResponse = await callApiFootball("/fixtures", {
      id: fixtureId,
    });

    const fixture = fixtureResponse?.data?.response?.[0];

    if (!fixture && !dbRow) {
      throw new Error("Fixture introuvable.");
    }

    return {
      fixtureId: Number(fixtureId),
      fixtureDate: fixture?.fixture?.date || dbRow?.fixture_date || null,

      leagueId: Number(fixture?.league?.id || dbRow?.league_id),
      leagueName: fixture?.league?.name || dbRow?.league_name || null,
      season: Number(fixture?.league?.season),

      homeTeamId: Number(
        fixture?.teams?.home?.id || dbRow?.home_team_id
      ),
      homeTeamName:
        fixture?.teams?.home?.name || dbRow?.home_team_name || null,

      awayTeamId: Number(
        fixture?.teams?.away?.id || dbRow?.away_team_id
      ),
      awayTeamName:
        fixture?.teams?.away?.name || dbRow?.away_team_name || null,

      status:
        fixture?.fixture?.status?.short ||
        dbRow?.result_status ||
        null,

      homeGoals: numberOrNull(
        fixture?.goals?.home ?? dbRow?.home_goals
      ),
      awayGoals: numberOrNull(
        fixture?.goals?.away ?? dbRow?.away_goals
      ),

      dbRow,
      fixture,
    };
  }

  async function getLineupStateMap(fixtureId) {
    try {
      const response = await callApiFootball("/fixtures/lineups", {
        fixture: fixtureId,
      });

      const map = new Map();

      for (const team of response?.data?.response || []) {
        for (const item of team?.startXI || []) {
          const id = Number(item?.player?.id);
          if (id) map.set(id, "STARTER");
        }

        for (const item of team?.substitutes || []) {
          const id = Number(item?.player?.id);
          if (id) map.set(id, "SUBSTITUTE");
        }
      }

      return map;
    } catch {
      return new Map();
    }
  }

  async function getInjurySet({ leagueId, season, fixtureId }) {
    try {
      const response = await callApiFootball("/injuries", {
        league: leagueId,
        season,
        fixture: fixtureId,
      });

      return new Set(
        (response?.data?.response || [])
          .map((item) => Number(item?.player?.id))
          .filter(Boolean)
      );
    } catch {
      return new Set();
    }
  }

  async function getTeamStats({ leagueId, season, teamId }) {
    try {
      const response = await callApiFootball("/teams/statistics", {
        league: leagueId,
        season,
        team: teamId,
      });

      return response?.data?.response || {};
    } catch {
      return {};
    }
  }

  async function getPrematchOdds(fixtureId) {
    try {
      const response = await callApiFootball("/odds", {
        fixture: fixtureId,
      });

      return response?.data?.response || [];
    } catch {
      return [];
    }
  }

  async function getPlayersForTeam({
    teamId,
    season,
    leagueId,
  }) {
    let fullSeason = [];
    let competition = [];

    try {
      fullSeason = await fetchPagedPlayers({
        callApiFootball,
        teamId,
        season,
      });
    } catch {
      fullSeason = [];
    }

    try {
      competition = await fetchPagedPlayers({
        callApiFootball,
        teamId,
        season,
        leagueId,
      });
    } catch {
      competition = [];
    }

    return mergePlayerResponses(fullSeason, competition);
  }

  async function analyzeFixture({
    fixtureId,
    marketTypes = [
      MARKET_TYPES.ANYTIME,
      MARKET_TYPES.REPLACEMENT,
    ],
    persist = true,
  }) {
    await ensureTables();

    const context = await getFixtureContext(fixtureId);

    if (
      !context.leagueId ||
      !context.season ||
      !context.homeTeamId ||
      !context.awayTeamId
    ) {
      throw new Error("Contexte fixture incomplet pour Goalscorer.");
    }

    const [
      homePlayers,
      awayPlayers,
      homeStats,
      awayStats,
      injuries,
      lineupMap,
      odds,
    ] = await Promise.all([
      getPlayersForTeam({
        teamId: context.homeTeamId,
        season: context.season,
        leagueId: context.leagueId,
      }),
      getPlayersForTeam({
        teamId: context.awayTeamId,
        season: context.season,
        leagueId: context.leagueId,
      }),
      getTeamStats({
        leagueId: context.leagueId,
        season: context.season,
        teamId: context.homeTeamId,
      }),
      getTeamStats({
        leagueId: context.leagueId,
        season: context.season,
        teamId: context.awayTeamId,
      }),
      getInjurySet({
        leagueId: context.leagueId,
        season: context.season,
        fixtureId: context.fixtureId,
      }),
      getLineupStateMap(context.fixtureId),
      getPrematchOdds(context.fixtureId),
    ]);

    const teamContexts = [
      {
        teamId: context.homeTeamId,
        opponentId: context.awayTeamId,
        homeAway: "HOME",
        players: homePlayers,
        teamStats: homeStats,
        opponentStats: awayStats,
      },
      {
        teamId: context.awayTeamId,
        opponentId: context.homeTeamId,
        homeAway: "AWAY",
        players: awayPlayers,
        teamStats: awayStats,
        opponentStats: homeStats,
      },
    ];

    const rows = [];

    for (const teamContext of teamContexts) {
      const ownSide = teamContext.homeAway === "HOME" ? "home" : "away";
      const opponentSide =
        teamContext.homeAway === "HOME" ? "away" : "home";

      const teamAverage = teamGoalAverage(
        teamContext.teamStats,
        ownSide
      );

      const opponentConceded = opponentConcededAverage(
        teamContext.opponentStats,
        opponentSide
      );

      const fallbackXg = fallbackExpectedTeamGoals({
        teamStats: teamContext.teamStats,
        opponentStats: teamContext.opponentStats,
        homeAway: teamContext.homeAway,
      });

      const brainXg = resolveBrainTeamXg({
        dbRow: context.dbRow,
        homeAway: teamContext.homeAway,
        fallback: fallbackXg,
      });

      const profiles = teamContext.players
        .map((playerResponse) => {
          const playerId = Number(playerResponse?.player?.id);
          if (!playerId) return null;

          const profile = buildPlayerProfile({
            playerResponse,
            teamId: teamContext.teamId,
            injured: injuries.has(playerId),
            lineupState: lineupMap.get(playerId) || "UNKNOWN",
          });

          if (profile.positionGroup === "GOALKEEPER") return null;

          /*
           * Filtre souple : on garde les joueurs à faible sample
           * mais ils seront shrinkés et leur dataQuality sera réduite.
           */
          if (profile.appearances < 1 && profile.minutes < 45) {
            return null;
          }

          return {
            ...profile,
            rawPlayer: playerResponse,
          };
        })
        .filter(Boolean);

      const allocated = allocateTeamXg({
        profiles,
        teamExpectedGoals: brainXg.value,
      });

      for (const player of allocated) {
        for (const marketType of marketTypes) {
          let predictedProbability = player.anytimeProbability;
          let guaranteeBoost = 0;
          let conditionalReplacementProbability = 0;

          if (marketType === MARKET_TYPES.REPLACEMENT) {
            const replacement = replacementCoverageProbability({
              player,
              teamProfiles: allocated,
            });

            guaranteeBoost = replacement.boost;
            conditionalReplacementProbability =
              replacement.conditionalReplacementProbability;

            predictedProbability = clamp(
              100 -
                ((100 - player.anytimeProbability) *
                  (100 - guaranteeBoost)) /
                  100,
              player.anytimeProbability,
              88
            );
          }

          const bestOdd = scanOddsForPlayer({
            oddsResponse: odds,
            playerName: player.playerName,
            marketType,
          });

          const marketOdd = bestOdd?.odd || null;
          const implied = impliedProbability(marketOdd);

          const valueEdge =
            implied == null
              ? null
              : round(predictedProbability - implied, 2);

          const recommendation = buildRecommendation({
            probability: predictedProbability,
            dataQuality: player.dataQuality,
            sampleReliability: player.sampleReliability,
            anomalies: player.anomalies,
            expectedMinutes: player.expectedMinutes,
            starterProbability: player.starterProbability,
            injured: player.injured,
            lineupState: player.lineupState,
          });

          const status = recommendation.tier;

          const row = {
            fixtureId: context.fixtureId,
            fixtureDate: context.fixtureDate,
            leagueId: context.leagueId,
            leagueName: context.leagueName,
            season: context.season,

            teamId: teamContext.teamId,
            opponentId: teamContext.opponentId,
            homeAway: teamContext.homeAway,

            ...player,

            teamExpectedGoals: round(brainXg.value, 4),
            teamExpectedGoalsSource: brainXg.source,
            teamAverageGoals: round(teamAverage, 4),
            opponentConcededAverage: round(opponentConceded, 4),

            marketType,
            replacementGuarantee:
              marketType === MARKET_TYPES.REPLACEMENT,

            guaranteeBoost: round(guaranteeBoost, 2),
            conditionalReplacementProbability,

            probability: round(predictedProbability, 2),
            fairOdd: fairOdd(predictedProbability),

            marketOdd,
            oddSource: bestOdd ? "API_FOOTBALL_STRICT_MATCH" : null,
            bookmakerId: bestOdd?.bookmakerId || null,
            bookmakerName: bestOdd?.bookmakerName || null,
            apiBetId: bestOdd?.betId || null,
            apiBetName: bestOdd?.betName || null,
            valueEdge,

            scorerStatus: status,
            recommendationScore: recommendation.score,
            recommendationTier: recommendation.tier,
            recommendationReasons: recommendation.reasons,
          };

          rows.push(row);

          if (persist) {
            await pool.query(
              `
                INSERT INTO goalscorer_predictions (
                  fixture_id,
                  fixture_date,
                  league_id,
                  season,
                  team_id,
                  opponent_id,
                  home_away,

                  player_id,
                  player_name,
                  position,
                  position_group,

                  market_type,
                  replacement_guarantee,

                  starter_probability,
                  expected_minutes,

                  appearances,
                  starts,
                  minutes,
                  goals,
                  goals_per90,
                  posterior_goals_per90,
                  shots,
                  shots_per90,
                  shots_on_target,
                  shots_on_target_per90,
                  penalty_goals,

                  team_expected_goals,
                  team_average_goals,
                  opponent_conceded_average,
                  xg_source,
                  allocation_share,

                  anytime_probability,
                  guarantee_boost,
                  predicted_probability,
                  fair_odd,

                  market_odd,
                  odd_source,
                  bookmaker_id,
                  bookmaker_name,
                  api_bet_id,
                  api_bet_name,
                  value_edge,

                  data_quality,
                  sample_reliability,
                  anomaly_flags,
                  scorer_status,

                  injured,
                  lineup_state,

                  model_version,
                  model_inputs,
                  raw_player,

                  result_status,
                  analyzed_at,
                  updated_at
                )
                VALUES (
                  $1,$2,$3,$4,$5,$6,$7,
                  $8,$9,$10,$11,$12,$13,
                  $14,$15,$16,$17,$18,$19,$20,$21,
                  $22,$23,$24,$25,$26,
                  $27,$28,$29,$30,$31,
                  $32,$33,$34,$35,
                  $36,$37,$38,$39,$40,$41,$42,
                  $43,$44,$45::jsonb,$46,
                  $47,$48,
                  $49,$50::jsonb,$51::jsonb,
                  'PENDING',
                  NOW(),NOW()
                )
                ON CONFLICT (
                  fixture_id,
                  player_id,
                  market_type
                )
                DO UPDATE SET
                  fixture_date = EXCLUDED.fixture_date,
                  league_id = EXCLUDED.league_id,
                  season = EXCLUDED.season,
                  team_id = EXCLUDED.team_id,
                  opponent_id = EXCLUDED.opponent_id,
                  home_away = EXCLUDED.home_away,

                  player_name = EXCLUDED.player_name,
                  position = EXCLUDED.position,
                  position_group = EXCLUDED.position_group,

                  replacement_guarantee = EXCLUDED.replacement_guarantee,

                  starter_probability = EXCLUDED.starter_probability,
                  expected_minutes = EXCLUDED.expected_minutes,

                  appearances = EXCLUDED.appearances,
                  starts = EXCLUDED.starts,
                  minutes = EXCLUDED.minutes,
                  goals = EXCLUDED.goals,
                  goals_per90 = EXCLUDED.goals_per90,
                  posterior_goals_per90 = EXCLUDED.posterior_goals_per90,
                  shots = EXCLUDED.shots,
                  shots_per90 = EXCLUDED.shots_per90,
                  shots_on_target = EXCLUDED.shots_on_target,
                  shots_on_target_per90 = EXCLUDED.shots_on_target_per90,
                  penalty_goals = EXCLUDED.penalty_goals,

                  team_expected_goals = EXCLUDED.team_expected_goals,
                  team_average_goals = EXCLUDED.team_average_goals,
                  opponent_conceded_average = EXCLUDED.opponent_conceded_average,
                  xg_source = EXCLUDED.xg_source,
                  allocation_share = EXCLUDED.allocation_share,

                  anytime_probability = EXCLUDED.anytime_probability,
                  guarantee_boost = EXCLUDED.guarantee_boost,
                  predicted_probability = EXCLUDED.predicted_probability,
                  fair_odd = EXCLUDED.fair_odd,

                  market_odd = EXCLUDED.market_odd,
                  odd_source = EXCLUDED.odd_source,
                  bookmaker_id = EXCLUDED.bookmaker_id,
                  bookmaker_name = EXCLUDED.bookmaker_name,
                  api_bet_id = EXCLUDED.api_bet_id,
                  api_bet_name = EXCLUDED.api_bet_name,
                  value_edge = EXCLUDED.value_edge,

                  data_quality = EXCLUDED.data_quality,
                  sample_reliability = EXCLUDED.sample_reliability,
                  anomaly_flags = EXCLUDED.anomaly_flags,
                  scorer_status = EXCLUDED.scorer_status,

                  injured = EXCLUDED.injured,
                  lineup_state = EXCLUDED.lineup_state,

                  model_version = EXCLUDED.model_version,
                  model_inputs = EXCLUDED.model_inputs,
                  raw_player = EXCLUDED.raw_player,

                  result_status =
                    CASE
                      WHEN goalscorer_predictions.model_version <> EXCLUDED.model_version
                      THEN 'PENDING'
                      ELSE goalscorer_predictions.result_status
                    END,
                  updated_at = NOW()
              `,
              [
                row.fixtureId,
                row.fixtureDate,
                row.leagueId,
                row.season,
                row.teamId,
                row.opponentId,
                row.homeAway,

                row.playerId,
                row.playerName,
                row.position,
                row.positionGroup,

                row.marketType,
                row.replacementGuarantee,

                row.starterProbability,
                row.expectedMinutes,

                row.appearances,
                row.starts,
                row.minutes,
                row.goals,
                row.goalsPer90,
                row.posteriorGoalsPer90,
                row.shots,
                row.shotsPer90,
                row.shotsOnTarget,
                row.shotsOnTargetPer90,
                row.penaltyGoals,

                row.teamExpectedGoals,
                row.teamAverageGoals,
                row.opponentConcededAverage,
                row.teamExpectedGoalsSource,
                row.allocationShare,

                row.anytimeProbability,
                row.guaranteeBoost,
                row.probability,
                row.fairOdd,

                row.marketOdd,
                row.oddSource,
                row.bookmakerId,
                row.bookmakerName,
                row.apiBetId,
                row.apiBetName,
                row.valueEdge,

                row.dataQuality,
                row.sampleReliability,
                safeJson(row.anomalies),
                row.scorerStatus,

                row.injured,
                row.lineupState,

                GOALSCORER_VERSION,
                safeJson({
                  shrinkagePriorMinutes: SHRINKAGE_PRIOR_MINUTES,
                  xgSource: row.teamExpectedGoalsSource,
                  conditionalReplacementProbability:
                    row.conditionalReplacementProbability,
                  strictMarketMatching: true,
                  teamLambdaConstraint: true,
                  recommendationVersion: "V2.3",
                }),
                safeJson(row.rawPlayer),
              ]
            );

            await pool.query(
              `
                UPDATE goalscorer_predictions
                SET
                  recommendation_score = $4,
                  recommendation_tier = $5,
                  recommendation_reasons = $6::jsonb,
                  learning_generation = $7,
                  updated_at = NOW()
                WHERE fixture_id = $1
                  AND player_id = $2
                  AND market_type = $3
              `,
              [
                row.fixtureId,
                row.playerId,
                row.marketType,
                row.recommendationScore,
                row.recommendationTier,
                safeJson(row.recommendationReasons),
                GOALSCORER_LEARNING_GENERATION,
              ]
            );
          }
        }
      }
    }

    const teamChecks = {};

    for (const side of ["HOME", "AWAY"]) {
      const anytimeRows = rows.filter(
        (row) =>
          row.homeAway === side &&
          row.marketType === MARKET_TYPES.ANYTIME
      );

      teamChecks[side] = {
        expectedGoals:
          anytimeRows[0]?.teamExpectedGoals ?? null,
        allocatedLambda: round(
          anytimeRows.reduce(
            (sum, row) => sum + numberOr(row.rawLambda),
            0
          ),
          4
        ),
        players: anytimeRows.length,
      };
    }

    return {
      ok: true,
      version: GOALSCORER_VERSION,
      fixture: context,
      count: rows.length,
      teamChecks,
      rows: rows.sort((a, b) => b.probability - a.probability),
      generatedAt: new Date().toISOString(),
    };
  }

  async function getFixturePredictions(fixtureId) {
    await ensureTables();

    const result = await pool.query(
      `
        SELECT *
        FROM goalscorer_predictions
        WHERE fixture_id = $1
          AND model_version = $2
        ORDER BY
          market_type ASC,
          predicted_probability DESC,
          player_name ASC
      `,
      [fixtureId, GOALSCORER_VERSION]
    );

    return {
      ok: true,
      version: GOALSCORER_VERSION,
      count: result.rows.length,
      rows: result.rows,
      generatedAt: new Date().toISOString(),
    };
  }

  async function settleFixture(fixtureId) {
    await ensureTables();

    const context = await getFixtureContext(fixtureId);
    const status = normalizeToken(context.status);

    if (
      !FINISHED_90.has(status) &&
      !FINISHED_EXTRA.has(status) &&
      !(context.homeGoals !== null && context.awayGoals !== null)
    ) {
      return {
        ok: true,
        fixtureId,
        skipped: true,
        reason: "MATCH_NOT_FINISHED",
      };
    }

    const [playersResponse, eventsResponse] = await Promise.all([
      callApiFootball("/fixtures/players", { fixture: fixtureId }),
      callApiFootball("/fixtures/events", { fixture: fixtureId }),
    ]);

    const playerGoals = new Map();

    for (const team of playersResponse?.data?.response || []) {
      for (const item of team?.players || []) {
        const id = Number(item?.player?.id);
        let goals = 0;

        for (const stat of item?.statistics || []) {
          goals += numberOr(stat?.goals?.total);
        }

        if (id) {
          playerGoals.set(id, {
            goals,
            name: item?.player?.name || null,
          });
        }
      }
    }

    const substitutionByOut = new Map();

    for (const event of eventsResponse?.data?.response || []) {
      if (normalizeToken(event?.type) !== "SUBST") continue;

      const outId = Number(event?.player?.id);
      const inId = Number(event?.assist?.id);

      if (outId && inId) {
        substitutionByOut.set(outId, {
          playerId: inId,
          playerName: event?.assist?.name || null,
        });
      }
    }

    const pending = await pool.query(
      `
        SELECT *
        FROM goalscorer_predictions
        WHERE fixture_id = $1
          AND learning_generation = $2
          AND result_status = 'PENDING'
      `,
      [fixtureId, GOALSCORER_LEARNING_GENERATION]
    );

    let settled = 0;
    let review = 0;

    for (const row of pending.rows) {
      const playerResult = playerGoals.get(Number(row.player_id));
      const ownGoals = numberOr(playerResult?.goals);
      const scored = ownGoals > 0;

      let replacement = null;
      let replacementScored = false;
      let resultStatus = "SETTLED";
      let settlementNote = null;

      /*
       * AET/PEN : on refuse de supposer les règles bookmaker.
       * Le marché buteur peut être limité aux 90 minutes.
       */
      if (FINISHED_EXTRA.has(status)) {
        resultStatus = "REVIEW";
        settlementNote =
          "Match prolongé / tirs au but : règle bookmaker requise pour le périmètre temporel du marché buteur.";
      }

      if (
        resultStatus === "SETTLED" &&
        row.replacement_guarantee
      ) {
        replacement =
          substitutionByOut.get(Number(row.player_id)) || null;

        if (replacement) {
          replacementScored =
            numberOr(
              playerGoals.get(Number(replacement.playerId))?.goals
            ) > 0;
        } else if (!scored) {
          resultStatus = "REVIEW";
          settlementNote =
            "Garantie remplaçant : aucune chaîne de substitution sortante vérifiable. Validation bookmaker requise.";
        }
      }

      const won = scored || replacementScored;
      const odd = numberOrNull(row.market_odd);

      const profit =
        resultStatus === "SETTLED" && odd && odd > 1
          ? won
            ? odd - 1
            : -1
          : null;

      await pool.query(
        `
          UPDATE goalscorer_predictions
          SET
            result_status = $2,
            scored = $3,
            player_goals = $4,
            replacement_player_id = $5,
            replacement_player_name = $6,
            replacement_scored = $7,
            settlement_note = $8,
            profit_units = $9,
            settled_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          row.id,
          resultStatus,
          won,
          ownGoals,
          replacement?.playerId || null,
          replacement?.playerName || null,
          replacementScored,
          settlementNote,
          profit,
        ]
      );

      if (resultStatus === "SETTLED") settled += 1;
      else review += 1;
    }

    return {
      ok: true,
      fixtureId,
      found: pending.rows.length,
      settled,
      review,
      generatedAt: new Date().toISOString(),
    };
  }

  async function settleFinished() {
    await ensureTables();

    const result = await pool.query(
      `
        SELECT DISTINCT g.fixture_id
        FROM goalscorer_predictions g
        JOIN predictions p
          ON p.fixture_id = g.fixture_id
        WHERE
          g.learning_generation = $1
          AND g.result_status = 'PENDING'
          AND (
            p.result_status = 'COMPLETED'
            OR (
              p.home_goals IS NOT NULL
              AND p.away_goals IS NOT NULL
            )
          )
        ORDER BY g.fixture_id ASC
        LIMIT 100
      `,
      [GOALSCORER_LEARNING_GENERATION]
    );

    let settled = 0;
    let review = 0;
    const errors = [];

    for (const row of result.rows) {
      try {
        const response = await settleFixture(row.fixture_id);
        settled += numberOr(response.settled);
        review += numberOr(response.review);
      } catch (error) {
        errors.push({
          fixtureId: row.fixture_id,
          error: error?.message || String(error),
        });
      }
    }

    return {
      ok: errors.length === 0,
      fixtures: result.rows.length,
      settled,
      review,
      errors,
      generatedAt: new Date().toISOString(),
    };
  }

  async function recordLearningRun({
    runType,
    status,
    rowsProcessed = 0,
    summary = null,
    errorMessage = null,
    startedAt = new Date(),
  }) {
    try {
      await pool.query(
        `
          INSERT INTO goalscorer_learning_runs (
            run_type,
            status,
            rows_processed,
            summary,
            error_message,
            started_at,
            finished_at
          )
          VALUES (
            $1,$2,$3,$4::jsonb,$5,$6,NOW()
          )
        `,
        [
          runType,
          status,
          rowsProcessed,
          safeJson(summary),
          errorMessage,
          startedAt,
        ]
      );
    } catch (error) {
      console.error(
        "GOALSCORER LEARNING RUN LOG :",
        error?.message || error
      );
    }
  }

  function learningReliability(sample) {
    const n = numberOr(sample);

    if (n >= 300) return "RELIABLE";
    if (n >= 150) return "DEVELOPING";
    if (n >= 50) return "OBSERVATION";

    return "INSUFFICIENT_DATA";
  }

  function suggestedCalibrationAdjustment({
    sample,
    predicted,
    actual,
  }) {
    const n = numberOr(sample);

    if (n < 50) return 0;

    const raw =
      numberOr(actual) -
      numberOr(predicted);

    /*
     * Shrinkage de la correction :
     * - à 50 observations, correction très prudente ;
     * - à 300+, la correction peut atteindre le plafond.
     */
    const sampleWeight =
      clamp(n / 300, 0.15, 1);

    return round(
      clamp(raw * sampleWeight, -8, 8),
      4
    );
  }

  async function rebuildRecommendationLearning() {
    const result = await pool.query(
      `
        SELECT
          market_type,
          COALESCE(
            NULLIF(recommendation_tier, ''),
            'UNKNOWN'
          ) AS recommendation_tier,

          COUNT(*)::INTEGER AS sample_size,

          COUNT(*) FILTER (
            WHERE scored = TRUE
          )::INTEGER AS wins,

          COUNT(*) FILTER (
            WHERE scored = FALSE
          )::INTEGER AS losses,

          AVG(predicted_probability)::NUMERIC
            AS average_predicted_probability,

          (
            COUNT(*) FILTER (
              WHERE scored = TRUE
            )::NUMERIC /
            NULLIF(COUNT(*), 0)
          ) * 100
            AS actual_score_rate,

          AVG(
            POWER(
              (predicted_probability / 100.0) -
              CASE
                WHEN scored = TRUE THEN 1.0
                ELSE 0.0
              END,
              2
            )
          )::NUMERIC AS brier_score

        FROM goalscorer_predictions
        WHERE
          learning_generation = $1
          AND result_status = 'SETTLED'
          AND scored IS NOT NULL
          AND recommendation_tier IS NOT NULL

        GROUP BY
          market_type,
          recommendation_tier

        ORDER BY
          market_type,
          recommendation_tier
      `,
      [GOALSCORER_LEARNING_GENERATION]
    );

    await pool.query(
      `
        DELETE FROM goalscorer_recommendation_learning
        WHERE learning_generation = $1
      `,
      [GOALSCORER_RECOMMENDATION_GENERATION]
    );

    for (const row of result.rows) {
      const sample = numberOr(row.sample_size);
      const predicted =
        numberOr(row.average_predicted_probability);
      const actual =
        numberOr(row.actual_score_rate);
      const gap =
        round(predicted - actual, 4);

      await pool.query(
        `
          INSERT INTO goalscorer_recommendation_learning (
            market_type,
            recommendation_tier,
            sample_size,
            wins,
            losses,
            average_predicted_probability,
            actual_score_rate,
            calibration_gap,
            brier_score,
            reliability_level,
            application_ready,
            learning_generation,
            calculated_at,
            updated_at
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,
            $10,$11,$12,NOW(),NOW()
          )
        `,
        [
          row.market_type,
          row.recommendation_tier,
          sample,
          numberOr(row.wins),
          numberOr(row.losses),
          predicted,
          actual,
          gap,
          numberOrNull(row.brier_score),
          learningReliability(sample),
          sample >= LEARNING_APPLICATION_MIN_SAMPLE,
          GOALSCORER_RECOMMENDATION_GENERATION,
        ]
      );
    }

    return {
      ok: true,
      groups: result.rows.length,
    };
  }

  async function rebuildLearning() {
    await ensureTables();

    const startedAt = new Date();

    try {
      const result = await pool.query(
        `
          SELECT
            market_type,
            CASE
              WHEN predicted_probability < 10 THEN '00_10'
              WHEN predicted_probability < 20 THEN '10_20'
              WHEN predicted_probability < 30 THEN '20_30'
              WHEN predicted_probability < 40 THEN '30_40'
              WHEN predicted_probability < 50 THEN '40_50'
              ELSE '50_PLUS'
            END AS probability_bucket,

            COALESCE(
              NULLIF(position_group, ''),
              'UNKNOWN'
            ) AS position_group,

            COUNT(*)::INTEGER AS sample_size,

            COUNT(*) FILTER (
              WHERE scored = TRUE
            )::INTEGER AS wins,

            COUNT(*) FILTER (
              WHERE scored = FALSE
            )::INTEGER AS losses,

            AVG(predicted_probability)::NUMERIC
              AS average_predicted_probability,

            (
              COUNT(*) FILTER (
                WHERE scored = TRUE
              )::NUMERIC /
              NULLIF(COUNT(*), 0)
            ) * 100
              AS actual_score_rate,

            AVG(
              POWER(
                (predicted_probability / 100.0) -
                CASE
                  WHEN scored = TRUE THEN 1.0
                  ELSE 0.0
                END,
                2
              )
            )::NUMERIC AS brier_score,

            COUNT(*) FILTER (
              WHERE market_odd > 1
                AND profit_units IS NOT NULL
            )::INTEGER AS bets_with_odds,

            COALESCE(
              SUM(profit_units) FILTER (
                WHERE market_odd > 1
              ),
              0
            )::NUMERIC AS profit_units

          FROM goalscorer_predictions
          WHERE
            learning_generation = $1
            AND result_status = 'SETTLED'
            AND scored IS NOT NULL

          GROUP BY
            market_type,
            probability_bucket,
            position_group

          ORDER BY
            market_type,
            probability_bucket,
            position_group
        `,
        [GOALSCORER_LEARNING_GENERATION]
      );

      await pool.query(
        `
          DELETE FROM goalscorer_learning_stats
          WHERE learning_generation = $1
        `,
        [GOALSCORER_LEARNING_GENERATION]
      );

      for (const row of result.rows) {
        const sample =
          numberOr(row.sample_size);

        const predicted =
          numberOr(
            row.average_predicted_probability
          );

        const actual =
          numberOr(row.actual_score_rate);

        const gap =
          round(predicted - actual, 4);

        const bets =
          numberOr(row.bets_with_odds);

        const profit =
          numberOr(row.profit_units);

        const roi =
          bets > 0
            ? round(
                (profit / bets) * 100,
                4
              )
            : null;

        const adjustment =
          suggestedCalibrationAdjustment({
            sample,
            predicted,
            actual,
          });

        const applicationReady =
          sample >=
          LEARNING_APPLICATION_MIN_SAMPLE;

        await pool.query(
          `
            INSERT INTO goalscorer_learning_stats (
              market_type,
              probability_bucket,
              position_group,
              sample_size,
              wins,
              losses,
              average_predicted_probability,
              actual_score_rate,
              calibration_gap,
              brier_score,
              bets_with_odds,
              profit_units,
              roi_percentage,
              reliability_level,
              learning_version,
              suggested_probability_adjustment,
              application_ready,
              learning_generation,
              calculated_at,
              updated_at
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
              $11,$12,$13,$14,$15,$16,$17,$18,
              NOW(),NOW()
            )
          `,
          [
            row.market_type,
            row.probability_bucket,
            row.position_group,
            sample,
            numberOr(row.wins),
            numberOr(row.losses),
            predicted,
            actual,
            gap,
            numberOrNull(row.brier_score),
            bets,
            profit,
            roi,
            learningReliability(sample),
            GOALSCORER_VERSION,
            adjustment,
            applicationReady,
            GOALSCORER_LEARNING_GENERATION,
          ]
        );
      }

      const recommendation =
        await rebuildRecommendationLearning();

      const summary = {
        ok: true,
        groups: result.rows.length,
        recommendationGroups:
          recommendation.groups,
        learningGeneration:
          GOALSCORER_LEARNING_GENERATION,
        applicationMinSample:
          LEARNING_APPLICATION_MIN_SAMPLE,
      };

      await recordLearningRun({
        runType: "LEARNING_REBUILD",
        status: "COMPLETED",
        rowsProcessed:
          result.rows.length +
          recommendation.groups,
        summary,
        startedAt,
      });

      return {
        ...summary,
        version: GOALSCORER_VERSION,
        generatedAt:
          new Date().toISOString(),
      };
    } catch (error) {
      await recordLearningRun({
        runType: "LEARNING_REBUILD",
        status: "FAILED",
        rowsProcessed: 0,
        errorMessage:
          error?.message || String(error),
        startedAt,
      });

      throw error;
    }
  }

  async function getLearningHealth() {
    await ensureTables();

    const [
      predictionCounts,
      learningGroups,
      recommendationGroups,
      lastRun,
    ] = await Promise.all([
      pool.query(
        `
          SELECT
            COUNT(*)::INTEGER AS total,
            COUNT(*) FILTER (
              WHERE result_status = 'PENDING'
            )::INTEGER AS pending,
            COUNT(*) FILTER (
              WHERE result_status = 'SETTLED'
            )::INTEGER AS settled,
            COUNT(*) FILTER (
              WHERE result_status = 'REVIEW'
            )::INTEGER AS review,
            COUNT(DISTINCT fixture_id)::INTEGER
              AS fixtures,
            MAX(settled_at) AS last_settled_at
          FROM goalscorer_predictions
          WHERE learning_generation = $1
        `,
        [GOALSCORER_LEARNING_GENERATION]
      ),
      pool.query(
        `
          SELECT
            COUNT(*)::INTEGER AS groups,
            COALESCE(
              SUM(sample_size),
              0
            )::INTEGER AS grouped_samples,
            COUNT(*) FILTER (
              WHERE application_ready = TRUE
            )::INTEGER AS application_ready_groups
          FROM goalscorer_learning_stats
          WHERE learning_generation = $1
        `,
        [GOALSCORER_LEARNING_GENERATION]
      ),
      pool.query(
        `
          SELECT
            COUNT(*)::INTEGER AS groups,
            COALESCE(
              SUM(sample_size),
              0
            )::INTEGER AS grouped_samples,
            COUNT(*) FILTER (
              WHERE application_ready = TRUE
            )::INTEGER AS application_ready_groups
          FROM goalscorer_recommendation_learning
          WHERE learning_generation = $1
        `,
        [GOALSCORER_RECOMMENDATION_GENERATION]
      ),
      pool.query(
        `
          SELECT
            run_type,
            status,
            rows_processed,
            summary,
            error_message,
            started_at,
            finished_at
          FROM goalscorer_learning_runs
          ORDER BY id DESC
          LIMIT 1
        `
      ),
    ]);

    const counts =
      predictionCounts.rows[0] || {};

    return {
      ok: true,
      version: GOALSCORER_VERSION,
      learningGeneration:
        GOALSCORER_LEARNING_GENERATION,
      recommendationGeneration:
        GOALSCORER_RECOMMENDATION_GENERATION,
      applicationMinSample:
        LEARNING_APPLICATION_MIN_SAMPLE,

      predictions: {
        total: numberOr(counts.total),
        fixtures:
          numberOr(counts.fixtures),
        pending:
          numberOr(counts.pending),
        settled:
          numberOr(counts.settled),
        review:
          numberOr(counts.review),
        lastSettledAt:
          counts.last_settled_at || null,
      },

      probabilityLearning: {
        groups:
          numberOr(
            learningGroups.rows[0]
              ?.groups
          ),
        groupedSamples:
          numberOr(
            learningGroups.rows[0]
              ?.grouped_samples
          ),
        applicationReadyGroups:
          numberOr(
            learningGroups.rows[0]
              ?.application_ready_groups
          ),
      },

      recommendationLearning: {
        groups:
          numberOr(
            recommendationGroups.rows[0]
              ?.groups
          ),
        groupedSamples:
          numberOr(
            recommendationGroups.rows[0]
              ?.grouped_samples
          ),
        applicationReadyGroups:
          numberOr(
            recommendationGroups.rows[0]
              ?.application_ready_groups
          ),
      },

      lastLearningRun:
        lastRun.rows[0] || null,

      calibrationPolicy: {
        automaticMeasurement: true,
        automaticApplication: false,
        reason:
          "Les corrections sont calculées automatiquement mais ne sont appliquées aux probabilités qu'après validation d'un échantillon suffisant.",
      },

      generatedAt:
        new Date().toISOString(),
    };
  }

  async function analyzeUpcoming({
    hours = 36,
    limit = 12,
  } = {}) {
    await ensureTables();

    const safeHours = clamp(hours, 6, 168);
    const safeLimit = Math.floor(clamp(limit, 1, 30));

    const result = await pool.query(
      `
        SELECT p.fixture_id
        FROM predictions p
        WHERE
          p.fixture_date > NOW()
          AND p.fixture_date <
            NOW() + ($1 || ' hours')::interval
          AND p.home_team_id IS NOT NULL
          AND p.away_team_id IS NOT NULL
        ORDER BY p.fixture_date ASC
        LIMIT $2
      `,
      [String(safeHours), safeLimit]
    );

    let analyzed = 0;
    const errors = [];

    for (const row of result.rows) {
      try {
        await analyzeFixture({
          fixtureId: Number(row.fixture_id),
          persist: true,
        });
        analyzed += 1;
      } catch (error) {
        errors.push({
          fixtureId: row.fixture_id,
          error: error?.message || String(error),
        });
      }
    }

    return {
      ok: errors.length === 0,
      found: result.rows.length,
      analyzed,
      errors: errors.slice(0, 20),
      generatedAt: new Date().toISOString(),
    };
  }

  async function getStatus() {
    await ensureTables();

    const [predictions, pending, settled, review, learning] =
      await Promise.all([
        pool.query(
          `
            SELECT COUNT(*)::INTEGER AS count
            FROM goalscorer_predictions
            WHERE model_version = $1
          `,
          [GOALSCORER_VERSION]
        ),
        pool.query(
          `
            SELECT COUNT(*)::INTEGER AS count
            FROM goalscorer_predictions
            WHERE model_version = $1
              AND result_status = 'PENDING'
          `,
          [GOALSCORER_VERSION]
        ),
        pool.query(
          `
            SELECT COUNT(*)::INTEGER AS count
            FROM goalscorer_predictions
            WHERE model_version = $1
              AND result_status = 'SETTLED'
          `,
          [GOALSCORER_VERSION]
        ),
        pool.query(
          `
            SELECT COUNT(*)::INTEGER AS count
            FROM goalscorer_predictions
            WHERE model_version = $1
              AND result_status = 'REVIEW'
          `,
          [GOALSCORER_VERSION]
        ),
        pool.query(
          `
            SELECT COUNT(*)::INTEGER AS count
            FROM goalscorer_learning_stats
            WHERE learning_version = $1
          `,
          [GOALSCORER_VERSION]
        ),
      ]);

    return {
      ok: true,
      version: GOALSCORER_VERSION,
      markets: MARKET_TYPES,
      predictions: numberOr(predictions.rows[0]?.count),
      pending: numberOr(pending.rows[0]?.count),
      settled: numberOr(settled.rows[0]?.count),
      review: numberOr(review.rows[0]?.count),
      learningGroups: numberOr(learning.rows[0]?.count),
      scheduler: Boolean(schedulersEnabled),
      architecture: {
        xgAnchor: "BRAIN_STUDIO_FIRST",
        shrinkagePriorMinutes: SHRINKAGE_PRIOR_MINUTES,
        strictMarketMatching: true,
        dataValidation: true,
        teamLambdaConstraint: true,
        recommendationEngine: true,
        recommendationTiers: ["TOP_SCORER", "RECOMMENDED", "WATCH", "REJECTED"],
        automaticSettlement: true,
        automaticLearning: true,
        learningGeneration: GOALSCORER_LEARNING_GENERATION,
        calibrationApplicationMinSample: LEARNING_APPLICATION_MIN_SAMPLE,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  function publicRecommendationRank(tier) {
    const ranks = {
      TOP_SCORER: 4,
      RECOMMENDED: 3,
      WATCH: 2,
      REJECTED: 1,
    };

    return ranks[String(tier || "").toUpperCase()] || 0;
  }

  function publicRecommendationLabel(tier) {
    const labels = {
      TOP_SCORER: "TOP BUTEUR",
      RECOMMENDED: "RECOMMANDÉ",
      WATCH: "À SURVEILLER",
      REJECTED: "NON CONSEILLÉ",
    };

    return labels[String(tier || "").toUpperCase()] || "INDISPONIBLE";
  }

  function publicReasonLabel(reason) {
    const labels = {
      HIGH_GOAL_PROBABILITY: "Forte probabilité de but",
      WATCH_GOAL_PROBABILITY: "Probabilité de but intéressante",
      LOW_GOAL_PROBABILITY: "Probabilité de but limitée",
      HIGH_EXPECTED_MINUTES: "Temps de jeu attendu élevé",
      LOW_EXPECTED_MINUTES: "Temps de jeu attendu limité",
      LIKELY_STARTER: "Titularisation probable",
      STARTER_UNCERTAINTY: "Titularisation incertaine",
      HIGH_DATA_QUALITY: "Données de bonne qualité",
      LIMITED_DATA_QUALITY: "Qualité des données limitée",
      LOW_SAMPLE_RELIABILITY: "Échantillon encore limité",
      DATA_ANOMALY: "Anomalie détectée dans les données",
      INJURED: "Joueur signalé blessé",
    };

    return labels[String(reason || "").toUpperCase()] || null;
  }

  function buildPublicGoalscorerPlayer(rows) {
    const anytime =
      rows.find(
        (row) =>
          row.market_type === MARKET_TYPES.ANYTIME
      ) || null;

    const replacement =
      rows.find(
        (row) =>
          row.market_type === MARKET_TYPES.REPLACEMENT
      ) || null;

    const candidates = [anytime, replacement].filter(Boolean);

    const best =
      [...candidates].sort(
        (a, b) => {
          const tierDiff =
            publicRecommendationRank(b.recommendation_tier) -
            publicRecommendationRank(a.recommendation_tier);

          if (tierDiff !== 0) return tierDiff;

          return (
            numberOr(b.recommendation_score) -
            numberOr(a.recommendation_score)
          );
        }
      )[0] || null;

    if (!best) return null;

    const rawReasons =
      Array.isArray(best.recommendation_reasons)
        ? best.recommendation_reasons
        : [];

    return {
      playerId: Number(best.player_id),
      playerName: best.player_name,
      position: best.position,
      positionGroup: best.position_group,
      teamId: Number(best.team_id),
      homeAway: best.home_away,

      tier: best.recommendation_tier,
      tierLabel: publicRecommendationLabel(
        best.recommendation_tier
      ),
      score:
        best.recommendation_score != null
          ? Number(best.recommendation_score)
          : null,

      reasons: rawReasons
        .map(publicReasonLabel)
        .filter(Boolean),

      sampleReliability:
        best.sample_reliability || null,
      dataQuality:
        best.data_quality != null
          ? Number(best.data_quality)
          : null,
      starterProbability:
        best.starter_probability != null
          ? Number(best.starter_probability)
          : null,
      expectedMinutes:
        best.expected_minutes != null
          ? Number(best.expected_minutes)
          : null,

      anytime: anytime
        ? {
            probability:
              anytime.predicted_probability != null
                ? Number(anytime.predicted_probability)
                : null,
            fairOdd:
              anytime.fair_odd != null
                ? Number(anytime.fair_odd)
                : null,
            tier: anytime.recommendation_tier,
            tierLabel: publicRecommendationLabel(
              anytime.recommendation_tier
            ),
            score:
              anytime.recommendation_score != null
                ? Number(anytime.recommendation_score)
                : null,
          }
        : null,

      scorerOrReplacement: replacement
        ? {
            probability:
              replacement.predicted_probability != null
                ? Number(replacement.predicted_probability)
                : null,
            fairOdd:
              replacement.fair_odd != null
                ? Number(replacement.fair_odd)
                : null,
            tier: replacement.recommendation_tier,
            tierLabel: publicRecommendationLabel(
              replacement.recommendation_tier
            ),
            score:
              replacement.recommendation_score != null
                ? Number(replacement.recommendation_score)
                : null,
          }
        : null,
    };
  }

  function registerRoutes() {
    /*
     * ============================================================
     * BRAIN STUDIO — BUTEURS (PUBLIC, LECTURE SEULE)
     * ============================================================
     *
     * IMPORTANT :
     * - aucune clé admin n'est exposée au frontend ;
     * - aucune donnée raw/API interne n'est renvoyée ;
     * - cette route ne déclenche AUCUNE analyse coûteuse ;
     * - elle lit uniquement les prédictions déjà calculées.
     */
    app.get(
      "/public/goalscorer/:fixtureId",
      async (req, res) => {
        try {
          await ensureTables();

          const fixtureId = Number(req.params.fixtureId);

          if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
            return res.status(400).json({
              ok: false,
              error: "fixtureId invalide",
            });
          }

          const [predictionResult, matchResult] = await Promise.all([
            pool.query(
              `
                SELECT
                  fixture_id,
                  fixture_date,
                  team_id,
                  opponent_id,
                  home_away,
                  player_id,
                  player_name,
                  position,
                  position_group,
                  market_type,
                  predicted_probability,
                  fair_odd,
                  starter_probability,
                  expected_minutes,
                  data_quality,
                  sample_reliability,
                  recommendation_score,
                  recommendation_tier,
                  recommendation_reasons
                FROM goalscorer_predictions
                WHERE fixture_id = $1
                  AND learning_generation = $2
                ORDER BY
                  recommendation_score DESC NULLS LAST,
                  predicted_probability DESC
              `,
              [
                fixtureId,
                GOALSCORER_LEARNING_GENERATION,
              ]
            ),
            pool.query(
              `
                SELECT
                  fixture_id,
                  fixture_date,
                  home_team_id,
                  home_team_name,
                  away_team_id,
                  away_team_name,
                  official_xg_home,
                  official_xg_away
                FROM predictions
                WHERE fixture_id = $1
                LIMIT 1
              `,
              [fixtureId]
            ),
          ]);

          const grouped = new Map();

          for (const row of predictionResult.rows) {
            const playerId = Number(row.player_id);

            if (!grouped.has(playerId)) {
              grouped.set(playerId, []);
            }

            grouped.get(playerId).push(row);
          }

          /*
           * V2.6 — APERÇU PUBLIC COMPLET
           *
           * On ne masque plus les joueurs REJECTED dans la réponse publique.
           * Cela permet à Brain Studio d'afficher les meilleurs candidats
           * évalués même lorsqu'aucun joueur n'atteint WATCH/RECOMMENDED.
           *
           * IMPORTANT :
           * REJECTED reste bien "NON CONSEILLÉ".
           * On expose une estimation, on ne transforme pas artificiellement
           * un profil faible en recommandation.
           */
          const players =
            [...grouped.values()]
              .map(buildPublicGoalscorerPlayer)
              .filter(Boolean)
              .sort((a, b) => {
                const tierDiff =
                  publicRecommendationRank(b.tier) -
                  publicRecommendationRank(a.tier);

                if (tierDiff !== 0) return tierDiff;

                const scoreDiff =
                  numberOr(b.score) -
                  numberOr(a.score);

                if (scoreDiff !== 0) {
                  return scoreDiff;
                }

                return (
                  numberOr(
                    b?.anytime?.probability
                  ) -
                  numberOr(
                    a?.anytime?.probability
                  )
                );
              });

          const match = matchResult.rows[0] || null;

          return res.json({
            ok: true,
            available: predictionResult.rows.length > 0,
            version: GOALSCORER_VERSION,
            fixtureId,
            match: match
              ? {
                  kickoff: match.fixture_date,
                  homeTeam: {
                    id: Number(match.home_team_id),
                    name: match.home_team_name,
                    expectedGoals:
                      match.official_xg_home != null
                        ? Number(match.official_xg_home)
                        : null,
                  },
                  awayTeam: {
                    id: Number(match.away_team_id),
                    name: match.away_team_name,
                    expectedGoals:
                      match.official_xg_away != null
                        ? Number(match.official_xg_away)
                        : null,
                  },
                }
              : null,
            summary: {
              topScorers: players.filter(
                (player) => player.tier === "TOP_SCORER"
              ).length,
              recommended: players.filter(
                (player) => player.tier === "RECOMMENDED"
              ).length,
              watch: players.filter(
                (player) => player.tier === "WATCH"
              ).length,
              rejected: players.filter(
                (player) => player.tier === "REJECTED"
              ).length,
              evaluatedPlayers: players.length,
            },
            players,
            generatedAt: new Date().toISOString(),
          });
        } catch (error) {
          console.error(
            "GOALSCORER PUBLIC ROUTE :",
            error
          );

          return res.status(500).json({
            ok: false,
            error:
              error?.message ||
              "Impossible de charger les recommandations buteur.",
          });
        }
      }
    );

    app.get(
      "/internal/goalscorer/status",
      ...guards,
      async (req, res) => {
        try {
          return res.json(await getStatus());
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error: error?.message || String(error),
          });
        }
      }
    );

    app.post(
      "/internal/goalscorer/analyze/:fixtureId",
      ...guards,
      async (req, res) => {
        try {
          const fixtureId = Number(req.params.fixtureId);

          if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
            return res.status(400).json({
              ok: false,
              error: "fixtureId invalide",
            });
          }

          const market = normalizeToken(req.body?.market);

          const marketTypes =
            market === MARKET_TYPES.ANYTIME
              ? [MARKET_TYPES.ANYTIME]
              : market === MARKET_TYPES.REPLACEMENT
                ? [MARKET_TYPES.REPLACEMENT]
                : [
                    MARKET_TYPES.ANYTIME,
                    MARKET_TYPES.REPLACEMENT,
                  ];

          return res.json(
            await analyzeFixture({
              fixtureId,
              marketTypes,
              persist: true,
            })
          );
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error: error?.message || String(error),
          });
        }
      }
    );

    app.post(
      "/internal/goalscorer/analyze-upcoming",
      ...guards,
      async (req, res) => {
        try {
          return res.json(
            await analyzeUpcoming({
              hours: req.body?.hours ?? 36,
              limit: req.body?.limit ?? 12,
            })
          );
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error: error?.message || String(error),
          });
        }
      }
    );

    app.get(
      "/internal/goalscorer/fixture/:fixtureId",
      ...guards,
      async (req, res) => {
        try {
          return res.json(
            await getFixturePredictions(
              Number(req.params.fixtureId)
            )
          );
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error: error?.message || String(error),
          });
        }
      }
    );

    app.patch(
      "/internal/goalscorer/predictions/:id/odd",
      ...guards,
      async (req, res) => {
        try {
          await ensureTables();

          const id = Number(req.params.id);
          const odd = numberOrNull(req.body?.odd);

          if (!Number.isInteger(id) || id <= 0 || !odd || odd <= 1) {
            return res.status(400).json({
              ok: false,
              error: "id ou cote invalide",
            });
          }

          const result = await pool.query(
            `
              UPDATE goalscorer_predictions
              SET
                market_odd = $2,
                odd_source = $3,
                bookmaker_name = $4,
                value_edge =
                  predicted_probability - (100 / $2),
                updated_at = NOW()
              WHERE id = $1
                AND model_version = $5
              RETURNING *
            `,
            [
              id,
              odd,
              String(req.body?.source || "MANUAL"),
              req.body?.bookmakerName || null,
              GOALSCORER_VERSION,
            ]
          );

          if (result.rows.length === 0) {
            return res.status(404).json({
              ok: false,
              error: "Prédiction buteur V2 introuvable",
            });
          }

          return res.json({
            ok: true,
            prediction: result.rows[0],
          });
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error: error?.message || String(error),
          });
        }
      }
    );

    app.post(
      "/internal/goalscorer/settle",
      ...guards,
      async (req, res) => {
        try {
          return res.json(await settleFinished());
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error: error?.message || String(error),
          });
        }
      }
    );

    app.post(
      "/internal/goalscorer/rebuild-learning",
      ...guards,
      async (req, res) => {
        try {
          return res.json(await rebuildLearning());
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error: error?.message || String(error),
          });
        }
      }
    );

    app.get(
      "/internal/goalscorer/learning-health",
      ...guards,
      async (req, res) => {
        try {
          return res.json(
            await getLearningHealth()
          );
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error:
              error?.message ||
              String(error),
          });
        }
      }
    );

    app.get(
      "/internal/goalscorer/recommendation-learning",
      ...guards,
      async (req, res) => {
        try {
          await ensureTables();

          const result =
            await pool.query(
              `
                SELECT *
                FROM goalscorer_recommendation_learning
                WHERE learning_generation = $1
                ORDER BY
                  market_type,
                  recommendation_tier
              `,
              [
                GOALSCORER_RECOMMENDATION_GENERATION,
              ]
            );

          return res.json({
            ok: true,
            version:
              GOALSCORER_VERSION,
            count:
              result.rows.length,
            stats:
              result.rows,
            generatedAt:
              new Date().toISOString(),
          });
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error:
              error?.message ||
              String(error),
          });
        }
      }
    );

    app.get(
      "/internal/goalscorer/learning",
      ...guards,
      async (req, res) => {
        try {
          await ensureTables();

          const result = await pool.query(
            `
              SELECT *
              FROM goalscorer_learning_stats
              WHERE learning_generation = $1
              ORDER BY
                market_type,
                probability_bucket,
                position_group
            `,
            [GOALSCORER_LEARNING_GENERATION]
          );

          return res.json({
            ok: true,
            version: GOALSCORER_VERSION,
            count: result.rows.length,
            stats: result.rows,
            generatedAt: new Date().toISOString(),
          });
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error: error?.message || String(error),
          });
        }
      }
    );

    /*
     * Diagnostic brut des cotes d'un fixture.
     * Sert à vérifier quels bet IDs sont réellement proposés
     * sur un match précis (ex: 92 / 218 / 231).
     */
    app.get(
      "/internal/goalscorer/raw-odds/:fixtureId",
      ...guards,
      async (req, res) => {
        try {
          const fixtureId = Number(req.params.fixtureId);

          if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
            return res.status(400).json({
              ok: false,
              error: "fixtureId invalide",
            });
          }

          const response = await callApiFootball(
            "/odds",
            {
              fixture: fixtureId,
            }
          );

          const raw = Array.isArray(response?.data?.response)
            ? response.data.response
            : [];

          const anytimeBetIds = new Set([92, 218, 231]);

          const anytimeMarkets = [];

          for (const fixture of raw) {
            for (const bookmaker of fixture?.bookmakers || []) {
              for (const bet of bookmaker?.bets || []) {
                const betId = Number(bet?.id);

                if (!anytimeBetIds.has(betId)) {
                  continue;
                }

                anytimeMarkets.push({
                  bookmakerId: bookmaker?.id ?? null,
                  bookmakerName: bookmaker?.name ?? null,
                  betId,
                  betName: bet?.name ?? null,
                  values: Array.isArray(bet?.values)
                    ? bet.values
                    : [],
                });
              }
            }
          }

          return res.json({
            ok: true,
            version: GOALSCORER_VERSION,
            fixtureId,
            apiResults: raw.length,
            anytimeMarketCount: anytimeMarkets.length,
            anytimeBetIds: [92, 218, 231],
            anytimeMarkets,
            raw,
            generatedAt: new Date().toISOString(),
          });
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error: error?.message || String(error),
          });
        }
      }
    );

    app.get(
      "/internal/goalscorer/api-bets",
      ...guards,
      async (req, res) => {
        try {
          const search = String(req.query.search || "scor")
            .trim()
            .slice(0, 40);

          const response = await callApiFootball(
            "/odds/bets",
            {
              search: search.length >= 3 ? search : "scor",
            }
          );

          const rows = response?.data?.response || [];

          return res.json({
            ok: true,
            search,
            response: rows,
            classified: rows.map((bet) => ({
              id: bet?.id ?? null,
              name: bet?.name ?? null,
              anytime: exactMarketNameMatch(
                bet?.name,
                MARKET_TYPES.ANYTIME
              ),
              replacement: exactMarketNameMatch(
                bet?.name,
                MARKET_TYPES.REPLACEMENT
              ),
            })),
            note:
              "V2 n'utilise une cote que si son intitulé correspond strictement au marché.",
          });
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error: error?.message || String(error),
          });
        }
      }
    );
  }

  let lastUpcomingAnalysisAt = 0;

  async function schedulerTick() {
    if (!schedulersEnabled || schedulerRunning) return;

    schedulerRunning = true;

    try {
      const now = Date.now();

      /*
       * L'analyse des matchs à venir consomme des appels API.
       * Elle reste donc limitée à une fois toutes les 6 heures.
       */
      if (
        now - lastUpcomingAnalysisAt >=
        6 * 60 * 60 * 1000
      ) {
        await analyzeUpcoming({
          hours: 36,
          limit: 12,
        });

        lastUpcomingAnalysisAt = now;
      }

      /*
       * Settlement + Learning : toutes les heures.
       * Aucun recalcul API n'est effectué si aucun match
       * terminé n'est en attente.
       */
      const settlement =
        await settleFinished();

      const learning =
        await rebuildLearning();

      await recordLearningRun({
        runType: "AUTO_CYCLE",
        status: "COMPLETED",
        rowsProcessed:
          numberOr(settlement.settled) +
          numberOr(settlement.review),
        summary: {
          settlement,
          learning,
        },
      });
    } catch (error) {
      console.error(
        "GOALSCORER V2.5 SCHEDULER :",
        error?.message || error
      );

      await recordLearningRun({
        runType: "AUTO_CYCLE",
        status: "FAILED",
        errorMessage:
          error?.message || String(error),
      });
    } finally {
      schedulerRunning = false;
    }
  }

  function startScheduler() {
    if (!schedulersEnabled || schedulerTimer) return;

    setTimeout(
      () => schedulerTick(),
      3 * 60 * 1000
    );

    schedulerTimer = setInterval(
      schedulerTick,
      60 * 60 * 1000
    );
  }

  function stopScheduler() {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
  }

  return {
    ensureTables,
    registerRoutes,
    startScheduler,
    stopScheduler,
    analyzeFixture,
    analyzeUpcoming,
    settleFinished,
    rebuildLearning,
    getLearningHealth,
    getStatus,
    version: GOALSCORER_VERSION,
  };
}

module.exports = {
  createGoalscorerEngine,
  GOALSCORER_VERSION,
  MARKET_TYPES,
};
