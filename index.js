require("dotenv").config();
const express = require("express");
const axios = require("axios");

const PORT =
  Number(process.env.PORT) || 3000;
const {
  computeAdvancedXGModel,
} = require("./src/services/FootballXGModel");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const cors = require("cors");
const {
  FootballMonteCarlo,
} = require("./FootballMonteCarlo");
const {
  createAIEventEngine,
} = require("./core/events/eventEngine");
const {
  registerAIEventRoutes,
} = require("./routes/aiEventRoutes");
const {
  createDecisionExplainability,
  createMarketExplainability,
} = require("./core/explainability/decisionExplainability");
const app = express();
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());
const analysisCache = new Map();
const ANALYSIS_CACHE_TTL = 60 * 60 * 1000;
const FINISHED_FIXTURE_STATUSES = new Set([
  "FT",
  "AET",
  "PEN",
]);
const API_BASE_URL =
  "https://v3.football.api-sports.io";

const DEFAULT_BOOKMAKER = 4; // Pinnacle
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});
const aiEventEngine =
  createAIEventEngine({
    pool,
  });

registerAIEventRoutes({
  app,
  aiEventEngine,
});
const HISTORY_FILE = path.join(__dirname, "predictions-history.json");

function getApiKey() {
  const apiKey =
    process.env.API_FOOTBALL_KEY;

  if (!apiKey) {
    throw new Error(
      "API_FOOTBALL_KEY manquante"
    );
  }

  return apiKey.trim();
}

async function callApiFootball(
  endpoint,
  params = {}
) {
  const response = await axios.get(
    `${API_BASE_URL}${endpoint}`,
    {
      headers: {
        "x-apisports-key":
          getApiKey(),
      },
      params,
      timeout: 15000,
    }
  );

  return response;
}
function isExcludedFixture(
  fixture = {}
) {
  const leagueName = String(
    fixture?.league?.name ||
    fixture?.league_name ||
    ""
  )
    .trim()
    .toLowerCase();

  const homeTeamName = String(
    fixture?.teams?.home?.name ||
    fixture?.homeTeam?.name ||
    fixture?.home_team_name ||
    ""
  )
    .trim()
    .toLowerCase();

  const awayTeamName = String(
    fixture?.teams?.away?.name ||
    fixture?.awayTeam?.name ||
    fixture?.away_team_name ||
    ""
  )
    .trim()
    .toLowerCase();

  const combinedText =
    `${leagueName} ${homeTeamName} ${awayTeamName}`;

  /*
   * Détecte :
   * U17, U-17, U 17
   * Under 17
   * moins de 17 ans
   *
   * De U15 jusqu'à U23.
   */
  const youthAgePattern =
    /\b(?:u[\s-]?(?:15|16|17|18|19|20|21|22|23)|under[\s-]?(?:15|16|17|18|19|20|21|22|23))\b/i;

  const friendlyKeywords = [
    "friendly",
    "friendlies",
    "amical",
    "amicaux",
  ];

  const youthKeywords = [
    "youth",
    "junior",
    "juniors",
    "academy",
    "academia",
    "akademiya",
    "primavera",
    "juvenil",
    "jeunes",
    "espoirs",
  ];

  const isFriendly =
    friendlyKeywords.some((keyword) =>
      combinedText.includes(keyword)
    );

  const isYouth =
    youthAgePattern.test(combinedText) ||
    youthKeywords.some((keyword) =>
      combinedText.includes(keyword)
    );

  return isFriendly || isYouth;
}
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service:
      "FootballBrain API",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service:
      "FootballBrain API",
    apiKeyConfigured:
      Boolean(
        process.env
          .API_FOOTBALL_KEY
      ),
  });
});

app.get(
  "/timezone",
  async (req, res) => {
    try {
      const response =
        await callApiFootball(
          "/timezone"
        );

      return res.json({
        ok: true,
        httpStatus:
          response.status,
        data:
          response.data,
      });
   

} catch (error) {
  console.error("ERREUR ANALYSE COMPLÈTE :", error);

  return res
    .status(error.response?.status || 500)
    .json({
      ok: false,

      message:
        error.message ||
        "Erreur inconnue",

      code:
        error.code || null,

      status:
        error.response?.status || null,

      endpoint:
        error.config?.url || null,

      apiData:
        error.response?.data || null,

      stack:
        process.env.NODE_ENV === "production"
          ? undefined
          : error.stack,
    });
}

  }
);

app.get(
  "/fixtures",
  async (req, res) => {
    try {
      const date =
        req.query.date;

      if (!date) {
        return res.status(400).json({
          ok: false,
          error:
            "Le paramètre date est obligatoire. Exemple : /fixtures?date=2026-07-22",
        });
      }

      const dateFormat =
        /^\d{4}-\d{2}-\d{2}$/;

      if (
        !dateFormat.test(date)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "La date doit être au format YYYY-MM-DD.",
        });
      }

      const response =
        await callApiFootball(
          "/fixtures",
          {
  date,
  league: 2,
  season: 2026,
  timezone: "Europe/Paris",
}
        );

      const fixtures =
        Array.isArray(
          response.data?.response
        )
          ? response.data.response
          : [];

      const matches =
        fixtures.map((item) => ({
          fixtureId:
            item.fixture?.id,
          date:
            item.fixture?.date,
          timestamp:
            item.fixture
              ?.timestamp,
          status:
            item.fixture?.status,
          venue:
            item.fixture?.venue,

          league: {
            id:
              item.league?.id,
            name:
              item.league?.name,
            country:
              item.league?.country,
            season:
              item.league?.season,
            round:
              item.league?.round,
            logo:
              item.league?.logo,
          },

          homeTeam: {
            id:
              item.teams?.home
                ?.id,
            name:
              item.teams?.home
                ?.name,
            logo:
              item.teams?.home
                ?.logo,
          },

          awayTeam: {
            id:
              item.teams?.away
                ?.id,
            name:
              item.teams?.away
                ?.name,
            logo:
              item.teams?.away
                ?.logo,
          },
        }));

      return res.json({
        ok: true,
        date,
        count:
          matches.length,
        matches,
      });
    } catch (error) {
      return res.status(
        error.response?.status ||
          500
      ).json({
        ok: false,
        error:
          error.response?.data ||
          error.message,
      });
    }
  }
);
app.get("/fixtures-test", async (req, res) => {
  try {
    const response =
      await callApiFootball(
        "/fixtures",
        {
          live: "all",
        }
      );

    res.json(response.data);
  } catch (error) {
    res.json(
      error.response?.data
    );
  }
});
app.get("/leagues", async (req, res) => {
  try {
    const response = await callApiFootball("/leagues");

    res.json({
      count: response.data.response.length,
      data: response.data.response.slice(0, 20),
    });
  } catch (error) {
    res.status(500).json({
      error: error.response?.data || error.message,
    });
  }
});
app.get("/status", async (req, res) => {
  try {
    const response = await axios.get(
      "https://v3.football.api-sports.io/status",
      {
        headers: {
          "x-apisports-key":
            process.env.API_FOOTBALL_KEY,
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    res.json(
      error.response?.data ||
      error.message
    );
  }
});
app.get("/internal/match/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    const response = await callApiFootball("/fixtures", {
      id: fixtureId,
      timezone: "Europe/Paris",
    });

    const apiData = response.data;

    if (
      apiData.errors &&
      Object.keys(apiData.errors).length > 0
    ) {
      return res.status(502).json({
        ok: false,
        error: apiData.errors,
      });
    }

    const item = apiData.response?.[0];

    if (!item) {
      return res.status(404).json({
        ok: false,
        error: "Match introuvable",
      });
    }

    return res.json({
      ok: true,
      match: {
        fixtureId: item.fixture?.id,
        date: item.fixture?.date,
        timestamp: item.fixture?.timestamp,
        status: item.fixture?.status,
        venue: item.fixture?.venue,

        league: {
          id: item.league?.id,
          name: item.league?.name,
          season: item.league?.season,
          round: item.league?.round,
          logo: item.league?.logo,
        },

        homeTeam: {
          id: item.teams?.home?.id,
          name: item.teams?.home?.name,
          logo: item.teams?.home?.logo,
        },

        awayTeam: {
          id: item.teams?.away?.id,
          name: item.teams?.away?.name,
          logo: item.teams?.away?.logo,
        },

        goals: item.goals,
        score: item.score,
      },
    });
  } catch (error) {
    return res.status(error.response?.status || 500).json({
      ok: false,
      error:
        error.response?.data ||
        error.message,
    });
  }
});
app.get("/internal/match/:fixtureId/context", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    const fixtureResponse = await callApiFootball("/fixtures", {
      id: fixtureId,
      timezone: "Europe/Paris",
    });

    const fixture = fixtureResponse.data?.response?.[0];

    if (!fixture) {
      return res.status(404).json({
        ok: false,
        error: "Match introuvable",
      });
    }

    const leagueId = fixture.league?.id;
    const season = fixture.league?.season;
    const homeTeamId = fixture.teams?.home?.id;
    const awayTeamId = fixture.teams?.away?.id;

    const [
  homeStatsResponse,
  awayStatsResponse,
  homeRecentResponse,
  awayRecentResponse,
  h2hResponse,
] = await Promise.all([
      callApiFootball("/teams/statistics", {
        league: leagueId,
        season,
        team: homeTeamId,
      }),

      callApiFootball("/teams/statistics", {
        league: leagueId,
        season,
        team: awayTeamId,
      }),

      callApiFootball("/fixtures", {
        team: homeTeamId,
        last: 5,
        timezone: "Europe/Paris",
      }),

      callApiFootball("/fixtures", {
        team: awayTeamId,
        last: 5,
        timezone: "Europe/Paris",
      }),
    callApiFootball("/fixtures/headtohead", {
  h2h: `${homeTeamId}-${awayTeamId}`,
  last: 10,
  timezone: "Europe/Paris",
}),

      ]);

    function simplifyRecentMatch(item, teamId) {
      const isHome = item.teams?.home?.id === teamId;

      const goalsFor = isHome
        ? item.goals?.home
        : item.goals?.away;

      const goalsAgainst = isHome
        ? item.goals?.away
        : item.goals?.home;

      let result = "D";

      if (goalsFor > goalsAgainst) {
        result = "W";
      } else if (goalsFor < goalsAgainst) {
        result = "L";
      }

      return {
        fixtureId: item.fixture?.id,
        date: item.fixture?.date,
        competition: item.league?.name,
        opponent: isHome
          ? item.teams?.away?.name
          : item.teams?.home?.name,
        location: isHome ? "home" : "away",
        goalsFor,
        goalsAgainst,
        result,
      };
    }

    const homeRecentMatches =
      homeRecentResponse.data?.response || [];

    const awayRecentMatches =
      awayRecentResponse.data?.response || [];
const h2hMatches =
  h2hResponse.data?.response || [];

const headToHead = h2hMatches.map((item) => ({
  fixtureId: item.fixture?.id,
  date: item.fixture?.date,
  competition: item.league?.name,

  homeTeam: {
    id: item.teams?.home?.id,
    name: item.teams?.home?.name,
  },

  awayTeam: {
    id: item.teams?.away?.id,
    name: item.teams?.away?.name,
  },

  goals: {
    home: item.goals?.home,
    away: item.goals?.away,
  },
}));
    return res.json({
      ok: true,

      match: {
        fixtureId,
        date: fixture.fixture?.date,
        league: fixture.league,
        homeTeam: fixture.teams?.home,
        awayTeam: fixture.teams?.away,
      },

      internalContext: {
        homeTeamStatistics:
          homeStatsResponse.data?.response || null,

        awayTeamStatistics:
          awayStatsResponse.data?.response || null,

        homeRecentForm: homeRecentMatches.map((item) =>
          simplifyRecentMatch(item, homeTeamId)
        ),

        awayRecentForm: awayRecentMatches.map((item) =>
          simplifyRecentMatch(item, awayTeamId)
        ),
     headToHead,
 },
    });


} catch (error) {
  console.error("DEBUG CATCH ANALYSE :", error);

  return res.status(error.response?.status || 500).json({
    ok: false,
    debugCatch: "NOUVEAU_CATCH_ACTIF",
    message: error.message || "Erreur inconnue",
    code: error.code || null,
    status: error.response?.status || null,
    endpoint: error.config?.url || null,
    apiData: error.response?.data ?? null,
  });
}

});

app.get("/internal/analyze/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    // ...

   const forceRefresh =
  req.query.refresh === "1" ||
  req.query.refresh === "true";

const cached =
  analysisCache.get(fixtureId);

if (
  !forceRefresh &&
  cached &&
  Date.now() - cached.createdAt <
    ANALYSIS_CACHE_TTL
) {
  return res.json({
    ...cached.data,
    cached: true,
  });
}

if (forceRefresh) {
  analysisCache.delete(fixtureId);
}
 const fixtureResponse = await callApiFootball("/fixtures", {
      id: fixtureId,
      timezone: "Europe/Paris",
    });

    const fixture = fixtureResponse.data?.response?.[0];

    if (!fixture) {
      return res.status(404).json({
        ok: false,
        error: "Match introuvable",
      });
    }
if (
  isExcludedFixture(fixture)
) {
  analysisCache.delete(
    fixtureId
  );

  return res.status(422).json({
    ok: false,
    skipped: true,
    reason:
      "FRIENDLY_MATCH_EXCLUDED",
  });
}
    const homeTeamId = fixture.teams?.home?.id;
    const awayTeamId = fixture.teams?.away?.id;

    const [
      homeRecentResponse,
      awayRecentResponse,
      h2hResponse,
      oddsResponse,
injuriesResponse,
lineupsResponse,
    ] = await Promise.all([
      callApiFootball("/fixtures", {
        team: homeTeamId,
        last: 5,
        timezone: "Europe/Paris",
      }),

      callApiFootball("/fixtures", {
        team: awayTeamId,
        last: 5,
        timezone: "Europe/Paris",
      }),

      callApiFootball("/fixtures/headtohead", {
        h2h: `${homeTeamId}-${awayTeamId}`,
        last: 10,
        timezone: "Europe/Paris",
      }),

      callApiFootball("/odds", {
  fixture: fixtureId,
  bookmaker: DEFAULT_BOOKMAKER,
}),
callApiFootball("/injuries", {
  fixture: fixtureId,
}),

callApiFootball("/fixtures/lineups", {
  fixture: fixtureId,
}),
    ]);
const homeRecentForm =
  homeRecentResponse.data?.response || [];

const awayRecentForm =
  awayRecentResponse.data?.response || [];
const getTeamResult = (match, teamId) => {
  const isHome =
    match.teams?.home?.id === teamId;

  const goalsFor = isHome
    ? match.goals?.home
    : match.goals?.away;

  const goalsAgainst = isHome
    ? match.goals?.away
    : match.goals?.home;

  if (goalsFor > goalsAgainst) return "W";
  if (goalsFor < goalsAgainst) return "L";

  return "D";
};

const homeResults = homeRecentForm.map(
  (match) => getTeamResult(match, homeTeamId)
);

const awayResults = awayRecentForm.map(
  (match) => getTeamResult(match, awayTeamId)
);
const rawOdds = oddsResponse.data?.response || [];
console.log(
  rawOdds[0]?.bookmakers?.map(b => ({
    id: b.id,
    name: b.name,
  }))
);
const market = summarizeMatchWinnerOdds(rawOdds);

const injuries =
  injuriesResponse.data?.response || [];

const lineups =
  lineupsResponse.data?.response || [];

const poissonModel =
  computePoissonModel({
    homeRecentForm,
    awayRecentForm,
    homeTeamId,
    awayTeamId,
  });

const extractGoals = (matches, teamId) => {
  const goalsFor = [];
  const goalsAgainst = [];

  for (const match of matches) {
    const isHome =
      match.teams?.home?.id === teamId;

    const scored = isHome
      ? match.goals?.home
      : match.goals?.away;

    const conceded = isHome
      ? match.goals?.away
      : match.goals?.home;

    if (
      Number.isFinite(scored) &&
      Number.isFinite(conceded)
    ) {
      goalsFor.push(scored);
      goalsAgainst.push(conceded);
    }
  }

  return {
    goalsFor,
    goalsAgainst,
  };
};

const homeGoalsData = extractGoals(
  homeRecentForm,
  homeTeamId
);

const awayGoalsData = extractGoals(
  awayRecentForm,
  awayTeamId
);

const advancedXGModel =
  computeAdvancedXGModel({
    leagueAverageGoals: {
      home: 1.4,
      away: 1.1,
    },

    home: {
      recent: {
        goalsFor:
          homeGoalsData.goalsFor,
        goalsAgainst:
          homeGoalsData.goalsAgainst,
      },

      season: {
        goalsForPerMatch:
          poissonModel.expectedGoals.home,
        goalsAgainstPerMatch:
          poissonModel.expectedGoals.away,
      },

      venue: {
        goalsForPerMatch:
          poissonModel.expectedGoals.home,
        goalsAgainstPerMatch:
          poissonModel.expectedGoals.away,
      },

      injuryImpact: 0,
      lineupImpact: 0,
      fatigueImpact: 0,
      motivationImpact: 0,
    },

    away: {
      recent: {
        goalsFor:
          awayGoalsData.goalsFor,
        goalsAgainst:
          awayGoalsData.goalsAgainst,
      },

      season: {
        goalsForPerMatch:
          poissonModel.expectedGoals.away,
        goalsAgainstPerMatch:
          poissonModel.expectedGoals.home,
      },

      venue: {
        goalsForPerMatch:
          poissonModel.expectedGoals.away,
        goalsAgainstPerMatch:
          poissonModel.expectedGoals.home,
      },

      injuryImpact: 0,
      lineupImpact: 0,
      fatigueImpact: 0,
      motivationImpact: 0,
    },

    metadata: {
      hasLineups:
        Array.isArray(lineups) &&
        lineups.length >= 2,

      hasInjuries:
        Array.isArray(injuries),
    },
  });

const xgConfidence =
  computeXgConfidence({
    homeRecentForm,
    awayRecentForm,
    injuries,
    lineups,
  });

const xgSource =
  poissonModel.source ||
  "recent-form-goals";

const xgQuality =
  poissonModel.quality ||
  "low";

const officialXgHome =
  advancedXGModel?.expectedGoals?.home ??
  poissonModel.expectedGoals.home;

const officialXgAway =
  advancedXGModel?.expectedGoals?.away ??
  poissonModel.expectedGoals.away;

const officialXgSource =
  advancedXGModel
    ? "advanced-xg-v1"
    : "poisson";

const monteCarloModel =
  FootballMonteCarlo(
    {
      id: fixtureId,
     xg_home: officialXgHome,
xg_away: officialXgAway,
    },
    {
      match: {
        id: fixtureId,
        xgHome: officialXgHome,
xgAway: officialXgAway,
      },
    },
    10000,
    {
      seed: fixtureId,
    }
  );
const monteCarloFavorite = [
  {
    key: "home",
    probability: monteCarloModel.homeWin,
  },
  {
    key: "draw",
    probability: monteCarloModel.draw,
  },
  {
    key: "away",
    probability: monteCarloModel.awayWin,
  },
].sort(
  (a, b) =>
    b.probability - a.probability
)[0];

const baseFootballBrain =
  computeFootballBrainScore(
    homeResults.map((result) => ({ result })),
    awayResults.map((result) => ({ result }))
  );

const phaseOneContext =
  computePhaseOneContext({
    match: {
      league: fixture.league,
    },
    homeResults,
    awayResults,
    market,
    baseScore: baseFootballBrain,
  });

const phaseTwoContext =
  computePhaseTwoContext({
    fixture,
    homeRecentForm,
    awayRecentForm,
    injuries,
    lineups,
  });

const footballBrain = {
  homeScore:
    phaseOneContext.adjustedHomeScore +
    phaseTwoContext.scoreAdjustment.home,

  awayScore:
    phaseOneContext.adjustedAwayScore +
    phaseTwoContext.scoreAdjustment.away,

  advantage:
    (
      phaseOneContext.adjustedHomeScore +
      phaseTwoContext.scoreAdjustment.home
    ) -
    (
      phaseOneContext.adjustedAwayScore +
      phaseTwoContext.scoreAdjustment.away
    ),

  baseScore: baseFootballBrain,

  context: {
    phaseOne: phaseOneContext,
    phaseTwo: phaseTwoContext,
  },
};
const footballBrainDecision =
  computeFootballBrainDecision(
    footballBrain,
    market,
    monteCarloModel,
    xgConfidence
  );
const monteCarloAgreement = {
  favorite:
    monteCarloFavorite.key,

  probability:
    Number(
      monteCarloFavorite.probability
    ),

  agreesWithDecision:
    monteCarloFavorite.key ===
    footballBrainDecision.selectedOutcome,
};
const headToHead =
  h2hResponse.data?.response || [];

const footballBrainRating =
  computeFootballBrainRating({
    footballBrain,
    footballBrainDecision,
    market,
    headToHead,
  });
const footballBrainPickScore =
  computeFootballBrainPickScore({
    decision: footballBrainDecision,
    market,
    footballBrain,
  });
const result = {
  ok: true,
  analysis: {
    fixtureId,
    match: {
      date: fixture.fixture?.date,
      homeTeam: fixture.teams?.home,
      awayTeam: fixture.teams?.away,
      league: fixture.league,
    },

  homeRecentForm,
    awayRecentForm,
    headToHead,
    market,
    poissonModel,
    advancedXGModel,
    xgConfidence,
    officialXgHome,
officialXgAway,
officialXgSource,
    xgSource,
    xgQuality,
    monteCarloModel,

    context: {
      injuries: {
        available:
          Array.isArray(injuries),
        count:
          Array.isArray(injuries)
            ? injuries.length
            : 0,
        items:
          Array.isArray(injuries)
            ? injuries
            : [],
        impact:
          phaseTwoContext?.injuryImpact ?? 0,
      },

      lineups: {
  available:
    Array.isArray(lineups) &&
    lineups.length > 0,

  count:
    Array.isArray(lineups)
      ? lineups.length
      : 0,

  items:
    Array.isArray(lineups)
      ? lineups
      : [],

  homeFormation:
    lineups?.[0]?.formation ||
    null,

  awayFormation:
    lineups?.[1]?.formation ||
    null,

  homeConfirmed:
    Boolean(
      lineups?.[0]
    ),

  awayConfirmed:
    Boolean(
      lineups?.[1]
    ),

  impact:
    phaseTwoContext?.lineupImpact ??
    0,
},

      fatigue: {
  available:
    phaseTwoContext?.fatigue
      ?.homeRestDays != null ||
    phaseTwoContext?.fatigue
      ?.awayRestDays != null,

  homeRestDays:
    phaseTwoContext?.fatigue
      ?.homeRestDays ??
    null,

  awayRestDays:
    phaseTwoContext?.fatigue
      ?.awayRestDays ??
    null,

  homePenalty:
    phaseTwoContext?.fatigue
      ?.homePenalty ??
    0,

  awayPenalty:
    phaseTwoContext?.fatigue
      ?.awayPenalty ??
    0,

  impact:
    phaseTwoContext?.fatigueImpact ??
    0,
},
      motivation: {
        impact:
          phaseTwoContext?.motivationImpact ?? 0,
      },

      phaseTwoContext:
        phaseTwoContext || null,
    },

    monteCarloAgreement,
    footballBrain,
    footballBrainDecision,
    footballBrainRating,
    footballBrainPickScore,
  },
};
          


console.log("CONTEXT DEBUG", {
  keys: Object.keys(result.analysis || {}),
  injuries:
    result.analysis?.injuries ||
    result.analysis?.injuriesSummary ||
    result.analysis?.context?.injuries ||
    null,
  lineups:
    result.analysis?.lineups ||
    result.analysis?.lineupsSummary ||
    result.analysis?.context?.lineups ||
    null,
  fatigue:
    result.analysis?.fatigue ||
    result.analysis?.fatigueSummary ||
    result.analysis?.context?.fatigue ||
    null,
});
await savePredictionToDatabase(
  result.analysis
);

analysisCache.set(fixtureId, {
  createdAt: Date.now(),
  data: result,
});

return res.json({
  ...result,
  cached: false,
});

  } catch (error) {
    console.error(
      "ERREUR /internal/analyze :",
      error
    );

    return res
      .status(error.response?.status || 500)
      .json({
        ok: false,
        debugCatch: "ANALYZE_CATCH_ACTIF",
        message:
          error.message ||
          "Erreur inconnue",
        code:
          error.code || null,
        status:
          error.response?.status || null,
        endpoint:
          error.config?.url || null,
        apiData:
          error.response?.data ?? null,
        apiDataType:
          typeof error.response?.data,
      });
  }
});

function computeFootballBrainScore(
  homeRecent,
  awayRecent
) {
  const scoreMap = {
    W: 3,
    D: 1,
    L: 0,
  };

  const getScore = (matches) =>
    matches.reduce((sum, match) => {
      return sum + scoreMap[match.result];
    }, 0);

  const homeScore = getScore(homeRecent);
  const awayScore = getScore(awayRecent);

  return {
    homeScore,
    awayScore,
    advantage: homeScore - awayScore,
  };
}
function summarizeMatchWinnerOdds(oddsData) {
  const homeOdds = [];
  const drawOdds = [];
  const awayOdds = [];

  for (const fixtureOdds of oddsData) {
    for (const bookmaker of fixtureOdds.bookmakers || []) {
      const matchWinner = (bookmaker.bets || []).find(
        (bet) => bet.name === "Match Winner"
      );

      if (!matchWinner) continue;

      for (const item of matchWinner.values || []) {
        const odd = Number(item.odd);

        if (!Number.isFinite(odd)) continue;

        if (item.value === "Home") homeOdds.push(odd);
        if (item.value === "Draw") drawOdds.push(odd);
        if (item.value === "Away") awayOdds.push(odd);
      }
    }
  }

  const average = (values) => {
    if (values.length === 0) return null;

    return Number(
      (
        values.reduce((sum, value) => sum + value, 0) /
        values.length
      ).toFixed(2)
    );
  };

  const home = average(homeOdds);
  const draw = average(drawOdds);
  const away = average(awayOdds);

  const availableOdds = [
    { key: "home", odd: home },
    { key: "draw", odd: draw },
    { key: "away", odd: away },
  ].filter((item) => item.odd !== null);

  const favorite =
    availableOdds.length > 0
      ? availableOdds.reduce((best, current) =>
          current.odd < best.odd ? current : best
        ).key
      : null;

  return {
    homeAverageOdd: home,
    drawAverageOdd: draw,
    awayAverageOdd: away,
    marketFavorite: favorite,
    bookmakersUsed: homeOdds.length,
  };
}

app.get("/internal/lineups/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    const response = await callApiFootball(
      "/fixtures/lineups",
      {
        fixture: fixtureId,
      }
    );

    res.json({
      ok: true,
      count: response.data.results,
      lineups: response.data.response,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/internal/predictions/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    const fixture = await callApiFootball("/fixtures", {
      id: fixtureId,
    });

    const match = fixture.data.response?.[0];

    const response = await callApiFootball(
      "/predictions",
      {
        fixture: fixtureId,
      }
    );

    res.json({
      ok: true,
      prediction:
        response.data.response?.[0] || null,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

function computeFootballBrainDecision(
  footballBrain,
  market,
  monteCarloModel,
  xgConfidence
) {
    const xgConfidenceLevel =
  xgConfidence?.level || "LOW";

let monteCarloWeight = 0.05;

if (xgConfidenceLevel === "HIGH") {
  monteCarloWeight = 0.25;
} else if (xgConfidenceLevel === "MEDIUM") {
  monteCarloWeight = 0.15;
}

const remainingWeight =
  1 - monteCarloWeight;

const formWeight =
  remainingWeight * (35 / 75);

const marketWeight =
  remainingWeight * (40 / 75);
  const homeFormScore = footballBrain.homeScore || 0;
  const awayFormScore = footballBrain.awayScore || 0;

  const totalFormScore = homeFormScore + awayFormScore;

  let homeFormProbability =
    totalFormScore > 0
      ? homeFormScore / totalFormScore
      : 0.5;

  let awayFormProbability =
    totalFormScore > 0
      ? awayFormScore / totalFormScore
      : 0.5;
const drawFormProbability =
  Math.max(
    0.1,
    1 -
      Math.abs(
        homeFormProbability -
        awayFormProbability
      )
  );
  const homeOdd = market?.homeAverageOdd;
  const drawOdd = market?.drawAverageOdd;
  const awayOdd = market?.awayAverageOdd;

  let homeMarketProbability =
    homeOdd && homeOdd > 0
      ? 1 / homeOdd
      : 0.33;

  let drawMarketProbability =
    drawOdd && drawOdd > 0
      ? 1 / drawOdd
      : 0.33;

  let awayMarketProbability =
    awayOdd && awayOdd > 0
      ? 1 / awayOdd
      : 0.33;

  const marketTotal =
    homeMarketProbability +
    drawMarketProbability +
    awayMarketProbability;

  homeMarketProbability /= marketTotal;
  drawMarketProbability /= marketTotal;
  awayMarketProbability /= marketTotal;
const monteCarloHome =
  Number(monteCarloModel?.homeWin);

const monteCarloDraw =
  Number(monteCarloModel?.draw);

const monteCarloAway =
  Number(monteCarloModel?.awayWin);

const monteCarloAvailable =
  Number.isFinite(monteCarloHome) &&
  Number.isFinite(monteCarloDraw) &&
  Number.isFinite(monteCarloAway);

const monteCarloHomeProbability =
  monteCarloAvailable
    ? monteCarloHome / 100
    : homeMarketProbability;

const monteCarloDrawProbability =
  monteCarloAvailable
    ? monteCarloDraw / 100
    : drawMarketProbability;

const monteCarloAwayProbability =
  monteCarloAvailable
    ? monteCarloAway / 100
    : awayMarketProbability;
  const homeProbability =
  homeFormProbability * formWeight +
  homeMarketProbability * marketWeight +
  monteCarloHomeProbability *
    monteCarloWeight;

const awayProbability =
  awayFormProbability * formWeight +
  awayMarketProbability * marketWeight +
  monteCarloAwayProbability *
    monteCarloWeight;

const drawProbability =
  drawFormProbability * formWeight +
  drawMarketProbability * marketWeight +
  monteCarloDrawProbability *
    monteCarloWeight;
  const probabilityTotal =
    homeProbability +
    drawProbability +
    awayProbability;

  const probabilities = {
    home: Number(
      ((homeProbability / probabilityTotal) * 100).toFixed(1)
    ),
    draw: Number(
      ((drawProbability / probabilityTotal) * 100).toFixed(1)
    ),
    away: Number(
      ((awayProbability / probabilityTotal) * 100).toFixed(1)
    ),
  };

  const options = [
    {
      key: "home",
      probability: probabilities.home,
      odd: homeOdd,
    },
    {
      key: "draw",
      probability: probabilities.draw,
      odd: drawOdd,
    },
    {
      key: "away",
      probability: probabilities.away,
      odd: awayOdd,
    },
  ];

  const bestOption = options.reduce((best, current) =>
    current.probability > best.probability
      ? current
      : best
  );

  const secondProbability = options
    .map((item) => item.probability)
    .sort((a, b) => b - a)[1];

  const probabilityGap =
    bestOption.probability - secondProbability;

  const confidence = Math.min(
    90,
    Math.max(
      40,
      Math.round(
        bestOption.probability +
        probabilityGap * 1.5
      )
    )
  );

  let risk = "élevé";

  if (confidence >= 75) {
    risk = "faible";
  } else if (confidence >= 60) {
    risk = "modéré";
  }

  const fairOdd =
    bestOption.probability > 0
      ? Number(
          (100 / bestOption.probability).toFixed(2)
        )
      : null;

  const value =
    bestOption.odd && fairOdd
      ? Number(
          (
            ((bestOption.odd / fairOdd) - 1) *
            100
          ).toFixed(1)
        )
      : null;

  const labelMap = {
    home: "Victoire domicile",
    draw: "Match nul",
    away: "Victoire extérieur",
  };

let decision = labelMap[bestOption.key];
let reason = "Issue la plus probable selon FootballBrain";
let valueLevel = "aucune";
let betStatus = "NO_BET";

if (value !== null) {
  if (value >= 10) {
    valueLevel = "forte";
    betStatus = "VALUE_BET";
  } else if (value >= 5) {
    valueLevel = "intéressante";
    betStatus = "VALUE_BET";
  } else if (value >= 3) {
    valueLevel = "faible";
    betStatus = "À_SURVEILLER";
  }
}



if (value === null || value < 3) {
  decision = "Pas de pari";
  reason =
    "La cote proposée n'offre pas suffisamment de value selon FootballBrain";
  betStatus = "NO_BET";
}

const selectedLabel = labelMap[bestOption.key]; 

const explanation =
  decision === "Pas de pari"
    ? `${selectedLabel} est actuellement le scénario le plus probable à ${bestOption.probability} %, mais la cote de ${bestOption.odd ?? "N/A"} est inférieure à la cote juste estimée à ${fairOdd ?? "N/A"}. FootballBrain ne détecte donc pas de value suffisante.`
    : `FootballBrain recommande ${decision}. La probabilité estimée est de ${bestOption.probability} %, avec une cote juste de ${fairOdd ?? "N/A"} et une value de ${value ?? "N/A"} %.`;
const monteCarloFavorite = [
  {
    key: "home",
    probability: monteCarloHome,
  },
  {
    key: "draw",
    probability: monteCarloDraw,
  },
  {
    key: "away",
    probability: monteCarloAway,
  },
]
  .filter((item) =>
    Number.isFinite(item.probability)
  )
  .sort(
    (a, b) =>
      b.probability - a.probability
  )[0] || null;

const monteCarloAgreement =
  monteCarloFavorite
    ? monteCarloFavorite.key ===
      bestOption.key
    : null;
const decisionTrace = [
  `xgConfidence = ${xgConfidenceLevel}`,

  `Poids forme = ${Number(
    (formWeight * 100).toFixed(1)
  )}%`,

  `Poids marché = ${Number(
    (marketWeight * 100).toFixed(1)
  )}%`,

  `Poids Monte Carlo = ${Number(
    (monteCarloWeight * 100).toFixed(1)
  )}%`,

  `Monte Carlo favorise ${
    monteCarloFavorite?.key || "inconnu"
  } à ${
    monteCarloFavorite?.probability ?? "N/A"
  }%`,

  `FootballBrain favorise ${
    bestOption.key
  } à ${
    bestOption.probability
  }%`,

  `Cote marché = ${
    bestOption.odd ?? "N/A"
  }`,

  `Cote juste = ${
    fairOdd ?? "N/A"
  }`,

  `Value = ${
    value ?? "N/A"
  }%`,

  `Décision finale = ${betStatus}`,

];

const explainability =
  createDecisionExplainability({
    selectedOutcome: bestOption.key,
    selectedProbability:
      bestOption.probability,
    probabilities,
    weights: {
      form: formWeight,
      market: marketWeight,
      monteCarlo: monteCarloWeight,
    },
    modelInputs: {
      form: {
        home: homeFormProbability,
        draw: drawFormProbability,
        away: awayFormProbability,
      },
      market: {
        home: homeMarketProbability,
        draw: drawMarketProbability,
        away: awayMarketProbability,
      },
      monteCarlo: {
        home: monteCarloHomeProbability,
        draw: monteCarloDrawProbability,
        away: monteCarloAwayProbability,
      },
    },
    monteCarlo: {
      available: monteCarloAvailable,
      favorite:
        monteCarloFavorite?.key || null,
      probability:
        monteCarloFavorite?.probability || null,
      agrees: monteCarloAgreement,
    },
    confidence,
    risk,
    fairOdd,
    marketOdd: bestOption.odd || null,
    value,
    betStatus,
    probabilityGap,
  });

return {
  probabilities,
  decision,
  reason,
  explanation,
  betStatus,
  valueLevel,
  confidence,
  risk,
  fairOdd,
  marketOdd: bestOption.odd || null,
  value,
  selectedOutcome: bestOption.key,

  weights: {
    form: Number(formWeight.toFixed(3)),
    market: Number(marketWeight.toFixed(3)),
    monteCarlo: Number(
      monteCarloWeight.toFixed(3)
    ),
    xgConfidenceLevel,
  },
modelInputs: {
  form: {
    home: Number(
      homeFormProbability.toFixed(4)
    ),
    draw: Number(
      drawFormProbability.toFixed(4)
    ),
    away: Number(
      awayFormProbability.toFixed(4)
    ),
  },

  market: {
    home: Number(
      homeMarketProbability.toFixed(4)
    ),
    draw: Number(
      drawMarketProbability.toFixed(4)
    ),
    away: Number(
      awayMarketProbability.toFixed(4)
    ),
  },

  monteCarlo: {
    home: Number(
      monteCarloHomeProbability.toFixed(4)
    ),
    draw: Number(
      monteCarloDrawProbability.toFixed(4)
    ),
    away: Number(
      monteCarloAwayProbability.toFixed(4)
    ),
  },
},

decisionTrace,
explainability,

monteCarlo: {
  available: monteCarloAvailable,
  favorite:
    monteCarloFavorite?.key || null,
  probability:
    monteCarloFavorite?.probability || null,
  agrees:
    monteCarloAgreement,
},
};
}
function computeFootballBrainRating({
  footballBrain,
  footballBrainDecision,
  market,
  headToHead,
}) {
  const homeScore = footballBrain?.homeScore || 0;
  const awayScore = footballBrain?.awayScore || 0;
  const totalFormScore = homeScore + awayScore;

  const formScore =
    totalFormScore > 0
      ? Math.round(
          (Math.max(homeScore, awayScore) /
            totalFormScore) *
            100
        )
      : 50;

  const marketScore =
    footballBrainDecision?.selectedOutcome ===
    market?.marketFavorite
      ? 80
      : 45;

  let h2hScore = 50;

  if (Array.isArray(headToHead) && headToHead.length > 0) {
    const draws = headToHead.filter(
      (match) =>
        match.goals?.home === match.goals?.away
    ).length;

    h2hScore = Math.round(
      (draws / headToHead.length) * 100
    );
  }

  const valueScore =
    footballBrainDecision?.value === null
      ? 50
      : Math.max(
          0,
          Math.min(
            100,
            Math.round(
              50 + footballBrainDecision.value * 2
            )
          )
        );

  const confidenceScore =
    footballBrainDecision?.confidence || 50;

  const globalScore = Math.round(
    formScore * 0.3 +
      marketScore * 0.25 +
      h2hScore * 0.15 +
      valueScore * 0.15 +
      confidenceScore * 0.15
  );

  return {
    form: formScore,
    market: marketScore,
    h2h: h2hScore,
    value: valueScore,
    confidence: confidenceScore,
    global: globalScore,
  };
}
function readPredictionHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return [];
    }

    const content = fs.readFileSync(HISTORY_FILE, "utf8");

    return content ? JSON.parse(content) : [];
  } catch (error) {
    console.error("Erreur lecture historique :", error.message);
    return [];
  }
}

function savePredictionHistory(history) {
  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(history, null, 2),
    "utf8"
  );
}

function saveFootballBrainPrediction(analysis) {
  const history = readPredictionHistory();

  const alreadyExists = history.some(
    (item) => item.fixtureId === analysis.fixtureId
  );

  if (alreadyExists) {
    return false;
  }

  history.push({
    fixtureId: analysis.fixtureId,
    createdAt: new Date().toISOString(),

    match: {
      date: analysis.match?.date,
      homeTeam: analysis.match?.homeTeam?.name,
      awayTeam: analysis.match?.awayTeam?.name,
      league: analysis.match?.league?.name,
    },

    prediction: {
      probabilities:
        analysis.footballBrainDecision?.probabilities,

      decision:
        analysis.footballBrainDecision?.decision,

      selectedOutcome:
        analysis.footballBrainDecision?.selectedOutcome,

      confidence:
        analysis.footballBrainDecision?.confidence,

      risk:
        analysis.footballBrainDecision?.risk,

      fairOdd:
        analysis.footballBrainDecision?.fairOdd,

      marketOdd:
        analysis.footballBrainDecision?.marketOdd,

      value:
        analysis.footballBrainDecision?.value,

      betStatus:
        analysis.footballBrainDecision?.betStatus,

      explanation:
        analysis.footballBrainDecision?.explanation,

      explainability:
        analysis.footballBrainDecision?.explainability,
    },

    result: {
      status: "PENDING",
      homeGoals: null,
      awayGoals: null,
      won: null,
      profit: null,
    },
  });

  savePredictionHistory(history);

  return true;
}
function computeHistoryStats(history) {
  const totalPredictions = history.length;

  const completed = history.filter(
    (item) => item.result?.status === "COMPLETED"
  );

  const noBet = history.filter(
    (item) => item.prediction?.betStatus === "NO_BET"
  ).length;

  const settledBets = completed.filter(
    (item) =>
      item.prediction?.betStatus !== "NO_BET" &&
      typeof item.result?.won === "boolean"
  );

  const wins = settledBets.filter(
    (item) => item.result.won === true
  ).length;

  const losses = settledBets.filter(
    (item) => item.result.won === false
  ).length;

  const totalProfit = settledBets.reduce(
    (sum, item) =>
      sum + Number(item.result?.profit || 0),
    0
  );

  const totalStake = settledBets.length;

  const winRate =
    settledBets.length > 0
      ? Number(
          (
            (wins / settledBets.length) *
            100
          ).toFixed(1)
        )
      : 0;

  const roi =
    totalStake > 0
      ? Number(
          (
            (totalProfit / totalStake) *
            100
          ).toFixed(1)
        )
      : 0;

  const averageConfidence =
    totalPredictions > 0
      ? Number(
          (
            history.reduce(
              (sum, item) =>
                sum +
                Number(
                  item.prediction?.confidence || 0
                ),
              0
            ) / totalPredictions
          ).toFixed(1)
        )
      : 0;

  const decisions = history.reduce(
    (acc, item) => {
      const decision =
        item.prediction?.decision || "Inconnue";

      acc[decision] =
        (acc[decision] || 0) + 1;

      return acc;
    },
    {}
  );

  return {
    totalPredictions,
    completedPredictions: completed.length,
    pendingPredictions:
      totalPredictions - completed.length,
    noBet,
    settledBets: settledBets.length,
    wins,
    losses,
    winRate,
    totalProfit: Number(totalProfit.toFixed(2)),
    roi,
    averageConfidence,
    decisions,
  };
}
app.get("/internal/history", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM predictions
      ORDER BY fixture_date DESC NULLS LAST,
               created_at DESC
    `);

    return res.json({
      ok: true,
      count: result.rows.length,
      history: result.rows,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/internal/stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::INTEGER AS total_predictions,

        COUNT(*) FILTER (
          WHERE result_status = 'COMPLETED'
        )::INTEGER AS completed_predictions,

        COUNT(*) FILTER (
          WHERE result_status = 'PENDING'
        )::INTEGER AS pending_predictions,

        COUNT(*) FILTER (
          WHERE bet_status = 'NO_BET'
        )::INTEGER AS no_bet,

        COUNT(*) FILTER (
          WHERE result_status = 'COMPLETED'
            AND bet_status <> 'NO_BET'
            AND won IS NOT NULL
        )::INTEGER AS settled_bets,

        COUNT(*) FILTER (
          WHERE won = TRUE
        )::INTEGER AS wins,

        COUNT(*) FILTER (
          WHERE won = FALSE
        )::INTEGER AS losses,

        COALESCE(
          SUM(profit) FILTER (
            WHERE result_status = 'COMPLETED'
              AND bet_status <> 'NO_BET'
          ),
          0
        )::NUMERIC AS total_profit,

        COALESCE(
          AVG(confidence),
          0
        )::NUMERIC AS average_confidence
      FROM predictions
    `);

    const row = result.rows[0];

    const settledBets =
      Number(row.settled_bets);

    const wins = Number(row.wins);
    const totalProfit =
      Number(row.total_profit);

    const winRate =
      settledBets > 0
        ? Number(
            (
              (wins / settledBets) *
              100
            ).toFixed(1)
          )
        : 0;

    // Chaque pari réglé représente une mise de 1 unité.
    const roi =
      settledBets > 0
        ? Number(
            (
              (totalProfit / settledBets) *
              100
            ).toFixed(1)
          )
        : 0;

    const decisionsResult =
      await pool.query(`
        SELECT
          decision,
          COUNT(*)::INTEGER AS count
        FROM predictions
        GROUP BY decision
        ORDER BY count DESC
      `);

    const decisions = {};

    for (const item of decisionsResult.rows) {
      decisions[
        item.decision || "Inconnue"
      ] = Number(item.count);
    }

    return res.json({
      ok: true,
      stats: {
        totalPredictions:
          Number(row.total_predictions),
        completedPredictions:
          Number(row.completed_predictions),
        pendingPredictions:
          Number(row.pending_predictions),
        noBet:
          Number(row.no_bet),
        settledBets,
        wins,
        losses:
          Number(row.losses),
        winRate,
        totalProfit:
          Number(totalProfit.toFixed(2)),
        roi,
        averageConfidence:
          Number(
            Number(
              row.average_confidence
            ).toFixed(1)
          ),
        decisions,
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
function computePhaseOneContext({
  match,
  homeResults,
  awayResults,
  market,
  baseScore,
}) {
  // Avantage fixe pour l'équipe à domicile
  const homeAdvantageBonus = 2;

  function countWinningStreak(results) {
    let streak = 0;

    for (const result of results) {
      if (result !== "W") break;
      streak += 1;
    }

    return streak;
  }

  const homeWinningStreak =
    countWinningStreak(homeResults);

  const awayWinningStreak =
    countWinningStreak(awayResults);

  // Bonus limité à 3 points
  const homeStreakBonus =
    Math.min(homeWinningStreak, 3);

  const awayStreakBonus =
    Math.min(awayWinningStreak, 3);

  const leagueName =
    match?.league?.name || "";

  const round =
    match?.league?.round || "";

  let matchImportance = "normale";
  let importanceScore = 1;

  if (
    leagueName.includes("Champions League") ||
    leagueName.includes("Europa League")
  ) {
    matchImportance = "élevée";
    importanceScore = 2;
  }

  if (
    round.includes("Final") ||
    round.includes("Semi") ||
    round.includes("Quarter")
  ) {
    matchImportance = "très élevée";
    importanceScore = 3;
  }

  if (leagueName.includes("Friendlies")) {
    matchImportance = "faible";
    importanceScore = 0;
  }

  const adjustedHomeScore =
    baseScore.homeScore +
    homeAdvantageBonus +
    homeStreakBonus;

  const adjustedAwayScore =
    baseScore.awayScore +
    awayStreakBonus;

  let footballBrainFavorite = "draw";

  if (adjustedHomeScore > adjustedAwayScore) {
    footballBrainFavorite = "home";
  }

  if (adjustedAwayScore > adjustedHomeScore) {
    footballBrainFavorite = "away";
  }

  const marketFavorite =
    market?.marketFavorite || null;

  const marketAgreement =
    marketFavorite !== null &&
    footballBrainFavorite === marketFavorite;

  return {
    adjustedHomeScore,
    adjustedAwayScore,
    adjustedAdvantage:
      adjustedHomeScore - adjustedAwayScore,

    homeAdvantageBonus,

    winningStreaks: {
      home: homeWinningStreak,
      away: awayWinningStreak,
    },

    streakBonuses: {
      home: homeStreakBonus,
      away: awayStreakBonus,
    },

    matchImportance,
    importanceScore,

    marketAgreement: {
      agrees: marketAgreement,
      marketFavorite,
      footballBrainFavorite,
    },
  };
}
function computePhaseTwoContext({
  fixture,
  homeRecentForm,
  awayRecentForm,
  injuries,
  lineups,
}) {
  const homeTeamId = fixture.teams?.home?.id;
  const awayTeamId = fixture.teams?.away?.id;

  const homeInjuries = injuries.filter(
    (item) => item.team?.id === homeTeamId
  );

  const awayInjuries = injuries.filter(
    (item) => item.team?.id === awayTeamId
  );

  function injuryWeight(item) {
    const type = String(item.player?.type || "").toLowerCase();
    const reason = String(
      item.player?.reason || item.player?.type || ""
    ).toLowerCase();

    if (type.includes("suspension")) return 2;

    if (
      reason.includes("knee") ||
      reason.includes("hamstring") ||
      reason.includes("fracture")
    ) {
      return 2;
    }

    return 1;
  }

  const homeInjuryPenalty = Math.min(
    6,
    homeInjuries.reduce(
      (sum, item) => sum + injuryWeight(item),
      0
    )
  );

  const awayInjuryPenalty = Math.min(
    6,
    awayInjuries.reduce(
      (sum, item) => sum + injuryWeight(item),
      0
    )
  );

  function getRestDays(recentMatches, kickoffDate) {
    const latestFinishedMatch = recentMatches.find(
      (item) =>
        item.fixture?.status?.short === "FT" &&
        item.fixture?.date
    );

    if (!latestFinishedMatch) return null;

    const kickoff = new Date(kickoffDate);
    const previousMatch = new Date(
      latestFinishedMatch.fixture.date
    );

    const difference =
      kickoff.getTime() - previousMatch.getTime();

    return Math.max(
      0,
      Math.floor(difference / (1000 * 60 * 60 * 24))
    );
  }

  const homeRestDays = getRestDays(
    homeRecentForm,
    fixture.fixture?.date
  );

  const awayRestDays = getRestDays(
    awayRecentForm,
    fixture.fixture?.date
  );

  function fatiguePenalty(restDays) {
    if (restDays === null) return 0;
    if (restDays <= 2) return 3;
    if (restDays <= 4) return 2;
    if (restDays <= 6) return 1;
    return 0;
  }

  const homeFatiguePenalty =
    fatiguePenalty(homeRestDays);

  const awayFatiguePenalty =
    fatiguePenalty(awayRestDays);

  const homeLineup = lineups.find(
    (item) => item.team?.id === homeTeamId
  );

  const awayLineup = lineups.find(
    (item) => item.team?.id === awayTeamId
  );

  const homeLineupConfirmed =
    Array.isArray(homeLineup?.startXI) &&
    homeLineup.startXI.length >= 11;

  const awayLineupConfirmed =
    Array.isArray(awayLineup?.startXI) &&
    awayLineup.startXI.length >= 11;

  return {
    injuries: {
      homeCount: homeInjuries.length,
      awayCount: awayInjuries.length,
      homePenalty: homeInjuryPenalty,
      awayPenalty: awayInjuryPenalty,
    },

    fatigue: {
      homeRestDays,
      awayRestDays,
      homePenalty: homeFatiguePenalty,
      awayPenalty: awayFatiguePenalty,
    },

    lineups: {
      homeConfirmed: homeLineupConfirmed,
      awayConfirmed: awayLineupConfirmed,
      homeFormation: homeLineup?.formation || null,
      awayFormation: awayLineup?.formation || null,
    },

    scoreAdjustment: {
      home:
        -homeInjuryPenalty -
        homeFatiguePenalty,

      away:
        -awayInjuryPenalty -
        awayFatiguePenalty,
    },
  };
}

app.get("/internal/db-test", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT NOW() AS current_time"
    );

    return res.json({
      ok: true,
      database: "connected",
      time: result.rows[0].current_time,
    });
  } catch (error) {
    console.error("ERREUR DB TEST :", error);

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Erreur inconnue",
      code:
        error.code || null,
      host:
        error.address || null,
      port:
        error.port || null,
    });
  }
});


async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      api_team_id INTEGER UNIQUE NOT NULL,
      name TEXT NOT NULL,
      country TEXT,
      logo TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS elo_ratings (
      id SERIAL PRIMARY KEY,
      team_id INTEGER UNIQUE NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      rating NUMERIC(8,2) NOT NULL DEFAULT 1500,
      matches_played INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS elo_history (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      fixture_id INTEGER NOT NULL,
      rating_before NUMERIC(8,2) NOT NULL,
      rating_after NUMERIC(8,2) NOT NULL,
      rating_change NUMERIC(8,2) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
CREATE UNIQUE INDEX IF NOT EXISTS elo_history_team_fixture_unique
ON elo_history (team_id, fixture_id);
    CREATE TABLE IF NOT EXISTS predictions (
      id SERIAL PRIMARY KEY,
      fixture_id INTEGER UNIQUE NOT NULL,
      fixture_date TIMESTAMPTZ,
      league_id INTEGER,
      league_name TEXT,
      home_team_id INTEGER,
      home_team_name TEXT,
      away_team_id INTEGER,
      away_team_name TEXT,

      decision TEXT,
      selected_outcome TEXT,
      bet_status TEXT,
      confidence NUMERIC(5,2),
      risk TEXT,

      home_probability NUMERIC(5,2),
      draw_probability NUMERIC(5,2),
      away_probability NUMERIC(5,2),

      fair_odd NUMERIC(8,2),
      market_odd NUMERIC(8,2),
      value_percentage NUMERIC(8,2),

      explanation TEXT,

      result_status TEXT DEFAULT 'PENDING',
      home_goals INTEGER,
      away_goals INTEGER,
      won BOOLEAN,
      profit NUMERIC(10,2),

      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS official_xg_home NUMERIC(8,3);

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS official_xg_away NUMERIC(8,3);

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS xg_source TEXT;

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS xg_confidence_score NUMERIC(5,2);

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS xg_confidence_level TEXT;

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS form_weight NUMERIC(6,4);

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS market_weight NUMERIC(6,4);

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS monte_carlo_weight NUMERIC(6,4);

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS decision_trace JSONB;

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS model_inputs JSONB;
 ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS monte_carlo_model JSONB;
      `);
}
app.get("/internal/db-init", async (req, res) => {
  try {
    await initializeDatabase();

    return res.json({
      ok: true,
      message: "Tables FootballBrain créées",
      tables: [
        "teams",
        "elo_ratings",
        "elo_history",
        "predictions",
      ],
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
async function savePredictionToDatabase(
  analysis
) {
  const decision =
    analysis.footballBrainDecision ||
    {};

  const probabilities =
    decision.probabilities || {};

  const weights =
    decision.weights || {};

  const xgConfidence =
    analysis.xgConfidence || {};

  const decisionTrace =
    Array.isArray(
      decision.decisionTrace
    )
      ? decision.decisionTrace
      : [];

  const modelInputs =
    decision.modelInputs || {};

  const monteCarloModel =
    analysis.monteCarloModel || {};

  const analysisContext =
    analysis.context || {};

  /*
   * Snapshot Brain Studio.
   *
   * Plusieurs emplacements sont acceptés
   * afin de rester compatible avec les
   * différentes versions du moteur.
   */
  const studioSnapshot =
    analysis.studioSnapshot ||
    analysis.brainStudioSnapshot ||
    analysis.studio_snapshot ||
    analysis.studio ||
    null;

  const primaryMarket =
    studioSnapshot?.primaryMarket ||
    analysis.primaryMarket ||
    decision.primaryMarket ||
    {};

  const studioDecision =
    primaryMarket?.decision ||
    studioSnapshot?.decision ||
    {};

  const studioMarketKey =
    analysis.studioMarketKey ||
    analysis.studio_market_key ||
    primaryMarket.key ||
    primaryMarket.marketKey ||
    null;

  const studioMarketLabel =
    analysis.studioMarketLabel ||
    analysis.studio_market_label ||
    primaryMarket.label ||
    primaryMarket.marketLabel ||
    null;

  const studioProbability =
    analysis.studioProbability ??
    analysis.studio_probability ??
    primaryMarket.probability ??
    primaryMarket?.fairOdds
      ?.calibratedProbability ??
    null;

  const studioDecisionScore =
    analysis.studioDecisionScore ??
    analysis.studio_decision_score ??
    studioDecision.score ??
    primaryMarket.decisionScore ??
    primaryMarket.score ??
    null;

  const studioDecisionType =
    analysis.studioDecisionType ||
    analysis.studio_decision_type ||
    studioDecision.type ||
    primaryMarket.decisionType ||
    null;

  const studioDecisionGrade =
    analysis.studioDecisionGrade ||
    analysis.studio_decision_grade ||
    studioDecision.grade ||
    primaryMarket.decisionGrade ||
    null;

  const studioAnalysisVersion =
    analysis.studioAnalysisVersion ||
    analysis.studio_analysis_version ||
    studioSnapshot?.analysisVersion ||
    studioSnapshot?.version ||
    null;

  const hasStudioData =
    Boolean(
      studioMarketKey ||
      studioMarketLabel ||
      studioDecisionType ||
      studioSnapshot
    );

  const studioSavedAt =
    hasStudioData
      ? new Date().toISOString()
      : null;

  const savedPrediction =
    await pool.query(
      `
        INSERT INTO predictions (
          fixture_id,
          fixture_date,

          league_id,
          league_name,

          home_team_id,
          home_team_name,

          away_team_id,
          away_team_name,

          decision,
          selected_outcome,
          bet_status,

          confidence,
          risk,

          home_probability,
          draw_probability,
          away_probability,

          fair_odd,
          market_odd,
          value_percentage,

          explanation,

          studio_market_key,
          studio_market_label,
          studio_probability,
          studio_decision_score,
          studio_decision_type,
          studio_decision_grade,
          studio_analysis_version,
          studio_snapshot,
          studio_saved_at,

          official_xg_home,
          official_xg_away,
          xg_source,
          xg_confidence_score,
          xg_confidence_level,

          form_weight,
          market_weight,
          monte_carlo_weight,

          decision_trace,
          model_inputs,
          monte_carlo_model,
          analysis_context
        )

        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25,
          $26, $27, $28, $29, $30,
          $31, $32, $33, $34, $35,
          $36, $37, $38, $39, $40,
          $41
        )

        ON CONFLICT (fixture_id)
        DO UPDATE SET
          fixture_date =
            EXCLUDED.fixture_date,

          league_id =
            EXCLUDED.league_id,

          league_name =
            EXCLUDED.league_name,

          home_team_id =
            EXCLUDED.home_team_id,

          home_team_name =
            EXCLUDED.home_team_name,

          away_team_id =
            EXCLUDED.away_team_id,

          away_team_name =
            EXCLUDED.away_team_name,

          decision =
            EXCLUDED.decision,

          selected_outcome =
            EXCLUDED.selected_outcome,

          bet_status =
            EXCLUDED.bet_status,

          confidence =
            EXCLUDED.confidence,

          risk =
            EXCLUDED.risk,

          home_probability =
            EXCLUDED.home_probability,

          draw_probability =
            EXCLUDED.draw_probability,

          away_probability =
            EXCLUDED.away_probability,

          fair_odd =
            EXCLUDED.fair_odd,

          market_odd =
            EXCLUDED.market_odd,

          value_percentage =
            EXCLUDED.value_percentage,

          explanation =
            EXCLUDED.explanation,

          /*
           * Une valeur vide ne doit jamais
           * effacer un snapshot Brain Studio
           * déjà enregistré.
           */
          studio_market_key =
            COALESCE(
              EXCLUDED.studio_market_key,
              predictions.studio_market_key
            ),

          studio_market_label =
            COALESCE(
              EXCLUDED.studio_market_label,
              predictions.studio_market_label
            ),

          studio_probability =
            COALESCE(
              EXCLUDED.studio_probability,
              predictions.studio_probability
            ),

          studio_decision_score =
            COALESCE(
              EXCLUDED.studio_decision_score,
              predictions.studio_decision_score
            ),

          studio_decision_type =
            COALESCE(
              EXCLUDED.studio_decision_type,
              predictions.studio_decision_type
            ),

          studio_decision_grade =
            COALESCE(
              EXCLUDED.studio_decision_grade,
              predictions.studio_decision_grade
            ),

          studio_analysis_version =
            COALESCE(
              EXCLUDED.studio_analysis_version,
              predictions.studio_analysis_version
            ),

          studio_snapshot =
            COALESCE(
              EXCLUDED.studio_snapshot,
              predictions.studio_snapshot
            ),

          studio_saved_at =
            COALESCE(
              EXCLUDED.studio_saved_at,
              predictions.studio_saved_at
            ),

          official_xg_home =
            EXCLUDED.official_xg_home,

          official_xg_away =
            EXCLUDED.official_xg_away,

          xg_source =
            EXCLUDED.xg_source,

          xg_confidence_score =
            EXCLUDED.xg_confidence_score,

          xg_confidence_level =
            EXCLUDED.xg_confidence_level,

          form_weight =
            EXCLUDED.form_weight,

          market_weight =
            EXCLUDED.market_weight,

          monte_carlo_weight =
            EXCLUDED.monte_carlo_weight,

          decision_trace =
            EXCLUDED.decision_trace,

          model_inputs =
            EXCLUDED.model_inputs,

          monte_carlo_model =
            EXCLUDED.monte_carlo_model,

          analysis_context =
            EXCLUDED.analysis_context,

          updated_at = NOW()

        RETURNING
          fixture_id,

          studio_market_key,
          studio_market_label,
          studio_probability,
          studio_decision_score,
          studio_decision_type,
          studio_decision_grade,
          studio_analysis_version,
          studio_saved_at,

          official_xg_home,
          official_xg_away,

          monte_carlo_model,
          analysis_context,
          decision_trace,

          updated_at
      `,
      [
        analysis.fixtureId,

        analysis.match?.date ||
          null,

        analysis.match?.league?.id ||
          null,

        analysis.match?.league?.name ||
          null,

        analysis.match?.homeTeam?.id ||
          null,

        analysis.match?.homeTeam?.name ||
          null,

        analysis.match?.awayTeam?.id ||
          null,

        analysis.match?.awayTeam?.name ||
          null,

        decision.decision ||
          null,

        decision.selectedOutcome ||
          null,

        decision.betStatus ||
          null,

        decision.confidence ??
          null,

        decision.risk ||
          null,

        probabilities.home ??
          null,

        probabilities.draw ??
          null,

        probabilities.away ??
          null,

        decision.fairOdd ??
          null,

        decision.marketOdd ??
          null,

        decision.value ??
          null,

        decision.explanation ||
          null,

        studioMarketKey,

        studioMarketLabel,

        studioProbability,

        studioDecisionScore,

        studioDecisionType,

        studioDecisionGrade,

        studioAnalysisVersion,

        studioSnapshot
          ? JSON.stringify(
              studioSnapshot
            )
          : null,

        studioSavedAt,

        analysis.officialXgHome ??
          null,

        analysis.officialXgAway ??
          null,

        analysis.officialXgSource ||
          null,

        xgConfidence.score ??
          null,

        xgConfidence.level ||
          null,

        weights.form ??
          null,

        weights.market ??
          null,

        weights.monteCarlo ??
          null,

        JSON.stringify(
          decisionTrace
        ),

        JSON.stringify(
          modelInputs
        ),

        JSON.stringify(
          monteCarloModel
        ),

        JSON.stringify(
          analysisContext
        ),
      ]
    );

  return savedPrediction.rows[0];
}
async function upsertTeam(
  team,
  country = null
) {
  const result =
    await pool.query(
      `
        INSERT INTO teams (
          api_team_id,
          name,
          country,
          logo,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          NOW()
        )

        ON CONFLICT (api_team_id)
        DO UPDATE SET
          name =
            EXCLUDED.name,

          country =
            COALESCE(
              EXCLUDED.country,
              teams.country
            ),

          logo =
            EXCLUDED.logo,

          updated_at =
            NOW()

        RETURNING *
      `,
      [
        team.id,
        team.name,
        country,
        team.logo || null,
      ]
    );

  return result.rows[0];
}

async function getOrCreateTeamElo(
  teamDatabaseId
) {
  const result =
    await pool.query(
      `
        INSERT INTO elo_ratings (
          team_id,
          rating,
          matches_played
        )
        VALUES (
          $1,
          1500,
          0
        )

        ON CONFLICT (team_id)
        DO UPDATE SET
          team_id =
            EXCLUDED.team_id

        RETURNING *
      `,
      [teamDatabaseId]
    );

  return result.rows[0];
} 

function calculateExpectedElo(ratingA, ratingB) {
  return 1 / (
    1 + Math.pow(10, (ratingB - ratingA) / 400)
  );
}

function calculateEloResult(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) {
    return {
      homeResult: 1,
      awayResult: 0,
    };
  }

  if (homeGoals < awayGoals) {
    return {
      homeResult: 0,
      awayResult: 1,
    };
  }

  return {
    homeResult: 0.5,
    awayResult: 0.5,
  };
}

async function updateEloFromFinishedFixture(fixture) {
  const status = fixture.fixture?.status?.short;

  if (!["FT", "AET", "PEN"].includes(status)) {
    throw new Error(
      "Le match n'est pas encore terminé"
    );
  }

  const fixtureId = fixture.fixture.id;

  const homeApiTeam = fixture.teams.home;
  const awayApiTeam = fixture.teams.away;

  const homeGoals = fixture.goals?.home;
  const awayGoals = fixture.goals?.away;

  if (
    !Number.isFinite(homeGoals) ||
    !Number.isFinite(awayGoals)
  ) {
    throw new Error(
      "Le score final du match est indisponible"
    );
  }

  const homeTeam = await upsertTeam(
    homeApiTeam,
    fixture.league?.country || null
  );

  const awayTeam = await upsertTeam(
    awayApiTeam,
    fixture.league?.country || null
  );

  const homeElo = await getOrCreateTeamElo(
    homeTeam.id
  );

  const awayElo = await getOrCreateTeamElo(
    awayTeam.id
  );

  const alreadyProcessed = await pool.query(
    `
      SELECT id
      FROM elo_history
      WHERE fixture_id = $1
      LIMIT 1
    `,
    [fixtureId]
  );

  if (alreadyProcessed.rows.length > 0) {
    return {
      alreadyProcessed: true,

      home: {
        team: homeTeam.name,
        rating: Number(homeElo.rating),
      },

      away: {
        team: awayTeam.name,
        rating: Number(awayElo.rating),
      },
    };
  }

  const homeRatingBefore =
    Number(homeElo.rating);

  const awayRatingBefore =
    Number(awayElo.rating);

  const expectedHome = calculateExpectedElo(
    homeRatingBefore + 60,
    awayRatingBefore
  );

  const expectedAway = 1 - expectedHome;

  const {
    homeResult,
    awayResult,
  } = calculateEloResult(
    homeGoals,
    awayGoals
  );

  const K_FACTOR = 32;

  const homeChange = Number(
    (
      K_FACTOR *
      (homeResult - expectedHome)
    ).toFixed(2)
  );

  const awayChange = Number(
    (
      K_FACTOR *
      (awayResult - expectedAway)
    ).toFixed(2)
  );

  const homeRatingAfter = Number(
    (homeRatingBefore + homeChange).toFixed(2)
  );

  const awayRatingAfter = Number(
    (awayRatingBefore + awayChange).toFixed(2)
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        UPDATE elo_ratings
        SET
          rating = $1,
          matches_played = matches_played + 1,
          updated_at = NOW()
        WHERE team_id = $2
      `,
      [
        homeRatingAfter,
        homeTeam.id,
      ]
    );

    await client.query(
      `
        UPDATE elo_ratings
        SET
          rating = $1,
          matches_played = matches_played + 1,
          updated_at = NOW()
        WHERE team_id = $2
      `,
      [
        awayRatingAfter,
        awayTeam.id,
      ]
    );

    await client.query(
      `
        INSERT INTO elo_history (
          team_id,
          fixture_id,
          rating_before,
          rating_after,
          rating_change
        )
        VALUES
          ($1, $2, $3, $4, $5),
          ($6, $2, $7, $8, $9)
      `,
      [
        homeTeam.id,
        fixtureId,
        homeRatingBefore,
        homeRatingAfter,
        homeChange,

        awayTeam.id,
        awayRatingBefore,
        awayRatingAfter,
        awayChange,
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    alreadyProcessed: false,

    fixtureId,

    score: {
      home: homeGoals,
      away: awayGoals,
    },

    home: {
      teamId: homeApiTeam.id,
      team: homeTeam.name,
      ratingBefore: homeRatingBefore,
      ratingAfter: homeRatingAfter,
      change: homeChange,
    },

    away: {
      teamId: awayApiTeam.id,
      team: awayTeam.name,
      ratingBefore: awayRatingBefore,
      ratingAfter: awayRatingAfter,
      change: awayChange,
    },
  };
}
app.get(
  "/internal/elo/process/:fixtureId",
  async (req, res) => {
    try {
      const fixtureId =
        Number(req.params.fixtureId);

      if (
        !Number.isInteger(fixtureId) ||
        fixtureId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "fixtureId invalide",
        });
      }

      const response =
        await callApiFootball(
          "/fixtures",
          {
            id: fixtureId,
            timezone: "Europe/Paris",
          }
        );

      const fixture =
        response.data?.response?.[0];

      if (!fixture) {
        return res.status(404).json({
          ok: false,
          error: "Match introuvable",
        });
      }

      const eloResult =
        await updateEloFromFinishedFixture(
          fixture
        );

      return res.json({
        ok: true,
        elo: eloResult,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
app.get(
  "/internal/team/:apiTeamId",
  async (req, res) => {
    try {
      const apiTeamId =
        Number(req.params.apiTeamId);

      const result = await pool.query(
        `
          SELECT
            t.api_team_id,
            t.name,
            t.country,
            t.logo,
            e.rating,
            e.matches_played,
            e.updated_at
          FROM teams t
          LEFT JOIN elo_ratings e
            ON e.team_id = t.id
          WHERE t.api_team_id = $1
        `,
        [apiTeamId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error:
            "Équipe absente du classement Elo",
        });
      }

      return res.json({
        ok: true,
        team: result.rows[0],
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
app.get(
  "/internal/team/:apiTeamId",
  async (req, res) => {
    try {
      const apiTeamId =
        Number(req.params.apiTeamId);

      const result = await pool.query(
        `
          SELECT
            t.api_team_id,
            t.name,
            t.country,
            t.logo,
            e.rating,
            e.matches_played,
            e.updated_at
          FROM teams t
          LEFT JOIN elo_ratings e
            ON e.team_id = t.id
          WHERE t.api_team_id = $1
        `,
        [apiTeamId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error:
            "Équipe absente du classement Elo",
        });
      }

      return res.json({
        ok: true,
        team: result.rows[0],
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
app.get(
  "/internal/elo-rankings",
  async (req, res) => {
    try {
      const limit = Math.min(
        100,
        Math.max(
          1,
          Number(req.query.limit) || 50
        )
      );

      const result = await pool.query(
        `
          SELECT
            t.api_team_id,
            t.name,
            t.country,
            t.logo,
            e.rating,
            e.matches_played,
            e.updated_at
          FROM elo_ratings e
          JOIN teams t
            ON t.id = e.team_id
          ORDER BY e.rating DESC
          LIMIT $1
        `,
        [limit]
      );

      return res.json({
        ok: true,
        count: result.rows.length,
        rankings: result.rows.map(
          (team, index) => ({
            rank: index + 1,
            ...team,
          })
        ),
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

function formatDateForApi(date) {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  ).format(date);
}

function getResultSyncDates() {
  const now = new Date();
  const dates = [];

  /*
   * Aujourd’hui + les 6 jours précédents.
   * Cela permet de rattraper les anciennes
   * prédictions restées bloquées.
   */
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(
      now.getTime() -
        offset *
          24 *
          60 *
          60 *
          1000
    );

    dates.push(
      formatDateForApi(date)
    );
  }

  return dates;
}

async function fetchFixturesByDate(date) {
  const response =
    await callApiFootball(
      "/fixtures",
      {
        date,
        timezone: "Europe/Paris",
      }
    );

  return Array.isArray(
    response.data?.response
  )
    ? response.data.response
    : [];
}

async function synchronizeFinishedPredictionsByDate() {
  const dates = getResultSyncDates();

  const summary = {
    dates,
    apiCalls: 0,
    fixturesReceived: 0,
    pendingPredictions: 0,
    matchedPredictions: 0,
    completed: 0,
    stillPending: 0,
    fixtureNotFound: 0,
    notFinished: 0,
    errors: 0,
    items: [],
  };

  /*
   * 1. Récupération groupée des fixtures
   *
   * Un seul appel API-Football par date.
   */
  const fixtureMap = new Map();

  for (const date of dates) {
    try {
      const fixtures =
        await fetchFixturesByDate(date);

      summary.apiCalls += 1;
      summary.fixturesReceived +=
        fixtures.length;

      for (const fixture of fixtures) {
        const fixtureId = Number(
          fixture?.fixture?.id
        );

        if (
          !Number.isInteger(fixtureId) ||
          fixtureId <= 0
        ) {
          continue;
        }

        fixtureMap.set(
          fixtureId,
          fixture
        );
      }
    } catch (error) {
      summary.apiCalls += 1;
      summary.errors += 1;

      summary.items.push({
        date,
        type: "API_DATE_ERROR",
        updated: false,
        error:
          error?.message ||
          "Erreur API-Football",
      });

      console.error(
        `RESULT SYNC : erreur pour la date ${date}`,
        error?.message || error
      );
    }
  }

  /*
   * 2. Sélection des prédictions anciennes
   * d’au moins 105 minutes.
   *
   * Fenêtre temporaire de 7 jours pour
   * rattraper les anciens matchs bloqués.
   */
  const pendingResult =
    await pool.query(
      `
        SELECT *
        FROM predictions
        WHERE
          (
            result_status = 'PENDING'
            OR result_status IS NULL
          )
          AND fixture_date >=
            NOW() - INTERVAL '7 days'
          AND fixture_date <=
            NOW() - INTERVAL '105 minutes'
        ORDER BY
          fixture_date DESC,
          created_at DESC
      `
    );

  const pendingPredictions =
    pendingResult.rows;

  summary.pendingPredictions =
    pendingPredictions.length;

  /*
   * 3. Comparaison locale entre PostgreSQL
   * et les fixtures récupérées.
   */
  for (
    const prediction
    of pendingPredictions
  ) {
    const fixtureId = Number(
      prediction.fixture_id
    );

    if (
      !Number.isInteger(fixtureId) ||
      fixtureId <= 0
    ) {
      summary.errors += 1;

      summary.items.push({
        fixtureId:
          prediction.fixture_id,
        type: "INVALID_FIXTURE_ID",
        updated: false,
        error: "fixture_id invalide",
      });

      continue;
    }

    const fixture =
      fixtureMap.get(fixtureId);

    /*
     * IMPORTANT :
     * on vérifie l’existence de fixture
     * avant de déclarer et d’utiliser status.
     */
    if (!fixture) {
      summary.stillPending += 1;
      summary.fixtureNotFound += 1;

      summary.items.push({
        fixtureId,
        fixtureDate:
          prediction.fixture_date,
        home:
          prediction.home_team_name,
        away:
          prediction.away_team_name,
        type:
          "FIXTURE_NOT_FOUND_IN_DATE_BATCH",
        updated: false,
      });

      continue;
    }

    summary.matchedPredictions += 1;

    const status = String(
      fixture?.fixture?.status?.short ||
        ""
    ).toUpperCase();

    /*
     * Le match existe, mais API-Football
     * ne le considère pas encore terminé.
     */
    if (
      !FINISHED_FIXTURE_STATUSES.has(
        status
      )
    ) {
      summary.stillPending += 1;
      summary.notFinished += 1;

      summary.items.push({
        fixtureId,
        fixtureDate:
          prediction.fixture_date,
        home:
          prediction.home_team_name,
        away:
          prediction.away_team_name,
        status:
          status || "UNKNOWN",
        type: "MATCH_NOT_FINISHED",
        updated: false,
      });

      continue;
    }

    /*
     * 4. Règlement de la prédiction.
     */
    try {
      const settlement =
        settlePrediction(
          prediction,
          fixture
        );

      const updateResult =
        await pool.query(
          `
            UPDATE predictions
            SET
              result_status = 'COMPLETED',
              home_goals = $1,
              away_goals = $2,
              won = $3,
              profit = $4,
              updated_at = NOW()
            WHERE fixture_id = $5
              AND (
                result_status = 'PENDING'
                OR result_status IS NULL
              )
            RETURNING
              fixture_id,
              result_status,
              home_goals,
              away_goals,
              won,
              profit
          `,
          [
            settlement.homeGoals,
            settlement.awayGoals,
            settlement.won,
            settlement.profit,
            fixtureId,
          ]
        );

      /*
       * Une autre synchronisation a peut-être
       * déjà terminé le match entre-temps.
       */
      if (
        updateResult.rows.length === 0
      ) {
        continue;
      }

      summary.completed += 1;

      summary.items.push({
        fixtureId,
        fixtureDate:
          prediction.fixture_date,
        home:
          prediction.home_team_name,
        away:
          prediction.away_team_name,
        status,
        score: {
          home:
            settlement.homeGoals,
          away:
            settlement.awayGoals,
        },
        selectedOutcome:
          prediction.selected_outcome,
        actualOutcome:
          settlement.actualOutcome,
        betStatus:
          prediction.bet_status,
        won:
          settlement.won,
        profit:
          settlement.profit,
        type: "COMPLETED",
        updated: true,
      });

      /*
       * La mise à jour ELO est secondaire.
       * Son éventuelle erreur ne doit jamais
       * remettre le match en PENDING.
       */
      try {
        await updateEloFromFinishedFixture(
          fixture
        );
      } catch (eloError) {
        console.warn(
          `RESULT SYNC : ELO non mis à jour pour ${fixtureId}`,
          eloError?.message ||
            eloError
        );
      }
    } catch (error) {
      summary.errors += 1;

      summary.items.push({
        fixtureId,
        fixtureDate:
          prediction.fixture_date,
        home:
          prediction.home_team_name,
        away:
          prediction.away_team_name,
        status,
        type: "SETTLEMENT_ERROR",
        updated: false,
        error:
          error?.message ||
          "Erreur de règlement",
      });

      console.error(
        `RESULT SYNC : erreur fixture ${fixtureId}`,
        error?.message || error
      );
    }
  }

  return summary;
}

app.get(
  "/internal/cron/update-results",
  async (req, res) => {
    const secret = req.query.secret;

    if (
      !process.env
        .INTERNAL_CRON_SECRET ||
      secret !==
        process.env
          .INTERNAL_CRON_SECRET
    ) {
      return res.status(401).json({
        ok: false,
        error: "Accès refusé",
      });
    }

    try {
      const summary =
        await synchronizeFinishedPredictionsByDate();

      return res.json({
        ok: true,
        summary,
      });
    } catch (error) {
      console.error(
        "ERREUR RESULT SYNC :",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Erreur inconnue",
      });
    }
  }
);

app.get("/public/analysis/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    const result = await pool.query(
      `
        SELECT
          fixture_id,
          fixture_date,
          league_name,
          home_team_name,
          away_team_name,
          decision,
          bet_status,
          confidence,
          risk,
          home_probability,
          draw_probability,
          away_probability,
          value_percentage,
          explanation,
          result_status
        FROM predictions
        WHERE fixture_id = $1
        LIMIT 1
      `,
      [fixtureId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Analyse indisponible",
      });
    }

    const item = result.rows[0];

    return res.json({
      ok: true,

      match: {
        fixtureId: item.fixture_id,
        date: item.fixture_date,
        league: item.league_name,
        homeTeam: item.home_team_name,
        awayTeam: item.away_team_name,
      },

      analysis: {
        decision: item.decision,
        betStatus: item.bet_status,

        probabilities: {
          home: Number(item.home_probability),
          draw: Number(item.draw_probability),
          away: Number(item.away_probability),
        },

        confidence: Number(item.confidence),
        risk: item.risk,
        value: Number(item.value_percentage),
        explanation: item.explanation,
      },

      status: item.result_status,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

   
function computeXgConfidence({
  homeRecentForm,
  awayRecentForm,
  injuries,
  lineups,
}) {
  let score = 0;

  const reasons = [];

  if (
    homeRecentForm.length >= 5 &&
    awayRecentForm.length >= 5
  ) {
    score += 40;
    reasons.push(
      "5 matchs récents disponibles"
    );
  }

  if (
    Array.isArray(lineups) &&
    lineups.length >= 2
  ) {
    score += 30;
    reasons.push(
      "Compositions disponibles"
    );
  }

  if (
    Array.isArray(injuries) &&
    injuries.length <= 4
  ) {
    score += 20;
    reasons.push(
      "Impact des blessures limité"
    );
  }

  score += 10;

  let level = "LOW";

  if (score >= 80) {
    level = "HIGH";
  } else if (score >= 60) {
    level = "MEDIUM";
  }

  return {
    score,
    level,
    reasons,
  };
}

function computeFootballBrainPickScore({
  decision,
  market,
  footballBrain,
}) {
  const confidence =
    Number(decision?.confidence || 0);

  const value =
    Number(decision?.value || 0);

  const phaseOne =
    footballBrain?.context?.phaseOne || {};

  const phaseTwo =
    footballBrain?.context?.phaseTwo || {};

  // 30 points maximum pour la confiance
  const confidencePoints = Math.min(
    30,
    Math.max(0, confidence * 0.3)
  );

  // 25 points maximum pour la value
  let valuePoints = 0;

  if (value >= 15) {
    valuePoints = 25;
  } else if (value >= 10) {
    valuePoints = 20;
  } else if (value >= 5) {
    valuePoints = 15;
  } else if (value >= 3) {
    valuePoints = 8;
  }

  // 15 points si les cotes sont disponibles
  const hasOdds =
    Number.isFinite(
      Number(market?.homeAverageOdd)
    ) ||
    Number.isFinite(
      Number(market?.drawAverageOdd)
    ) ||
    Number.isFinite(
      Number(market?.awayAverageOdd)
    );

  const oddsPoints = hasOdds ? 15 : 0;

  // 10 points selon l’accord avec le marché
  const marketAgreement =
    phaseOne?.marketAgreement?.agrees;

  const marketAgreementPoints =
    marketAgreement === true ? 10 : 5;

  // 10 points pour la qualité des données
  let dataQualityPoints = 0;

  if (
    phaseTwo?.fatigue?.homeRestDays !== null &&
    phaseTwo?.fatigue?.awayRestDays !== null
  ) {
    dataQualityPoints += 4;
  }

  if (
    typeof phaseTwo?.injuries?.homeCount ===
      "number" &&
    typeof phaseTwo?.injuries?.awayCount ===
      "number"
  ) {
    dataQualityPoints += 3;
  }

  if (
    phaseTwo?.lineups?.homeConfirmed &&
    phaseTwo?.lineups?.awayConfirmed
  ) {
    dataQualityPoints += 3;
  }

  // 10 points liés au statut final
  let decisionPoints = 0;

  if (decision?.betStatus === "VALUE_BET") {
    decisionPoints = 10;
  } else if (
    decision?.betStatus === "À_SURVEILLER"
  ) {
    decisionPoints = 5;
  }
const monteCarlo =
  decision?.monteCarlo || {};

let monteCarloPoints = 0;

if (monteCarlo.available) {
  if (monteCarlo.agrees === true) {
    monteCarloPoints = 10;
  } else if (monteCarlo.agrees === false) {
    monteCarloPoints = -5;
  }

  if (
    Number(monteCarlo.probability) >= 70 &&
    monteCarlo.agrees === true
  ) {
    monteCarloPoints = 15;
  }
}
  const rawScore = Math.round(
  confidencePoints +
    valuePoints +
    oddsPoints +
    marketAgreementPoints +
    dataQualityPoints +
    decisionPoints +
    monteCarloPoints
);

const score = Math.max(
  0,
  Math.min(100, rawScore)
);

  let level = "PAS DE PARI";

  if (score >= 90) {
    level = "EXCELLENT";
  } else if (score >= 80) {
    level = "TRÈS FORT";
  } else if (score >= 70) {
    level = "INTÉRESSANT";
  } else if (score >= 60) {
    level = "À SURVEILLER";
  }

  // Sécurité : aucun pari recommandé sans cotes
  if (!hasOdds) {
    level = "DONNÉES INCOMPLÈTES";
  }

  // Sécurité : une value insuffisante reste un NO BET
  if (
    decision?.betStatus === "NO_BET"
  ) {
    level = "PAS DE PARI";
  }

  return {
    score,
    level,

    breakdown: {
      confidence:
        Number(confidencePoints.toFixed(1)),
      value: valuePoints,
      odds: oddsPoints,
      marketAgreement:
        marketAgreementPoints,
      dataQuality:
        dataQualityPoints,
      decision:
        decisionPoints,
    monteCarlo: monteCarloPoints,
},

    hasOdds,
  };
}
function computePoissonModel({
  homeRecentForm,
  awayRecentForm,
  homeTeamId,
  awayTeamId,
}) {
  function computeTeamAverages(matches, teamId) {
    if (!Array.isArray(matches) || matches.length === 0) {
      return {
        goalsForAverage: 1,
        goalsAgainstAverage: 1,
      };
    }

    let goalsForTotal = 0;
    let goalsAgainstTotal = 0;
    let validMatches = 0;

    for (const match of matches) {
      const isHome =
        match.teams?.home?.id === teamId;

      const goalsFor = isHome
        ? match.goals?.home
        : match.goals?.away;

      const goalsAgainst = isHome
        ? match.goals?.away
        : match.goals?.home;

      if (
        !Number.isFinite(goalsFor) ||
        !Number.isFinite(goalsAgainst)
      ) {
        continue;
      }

      goalsForTotal += goalsFor;
      goalsAgainstTotal += goalsAgainst;
      validMatches += 1;
    }

    if (validMatches === 0) {
      return {
        goalsForAverage: 1,
        goalsAgainstAverage: 1,
      };
    }

    return {
      goalsForAverage:
        goalsForTotal / validMatches,

      goalsAgainstAverage:
        goalsAgainstTotal / validMatches,
    };
  }

  const homeAverages =
    computeTeamAverages(
      homeRecentForm,
      homeTeamId
    );

  const awayAverages =
    computeTeamAverages(
      awayRecentForm,
      awayTeamId
    );

  const expectedHomeGoals = Number(
    (
      (
        homeAverages.goalsForAverage +
        awayAverages.goalsAgainstAverage
      ) / 2
    ).toFixed(2)
  );

  const expectedAwayGoals = Number(
    (
      (
        awayAverages.goalsForAverage +
        homeAverages.goalsAgainstAverage
      ) / 2
    ).toFixed(2)
  );

  return {
    expectedGoals: {
      home: Math.max(0.05, expectedHomeGoals),
      away: Math.max(0.05, expectedAwayGoals),
      total: Number(
        (
          expectedHomeGoals +
          expectedAwayGoals
        ).toFixed(2)
      ),
    },

    source: "recent-form-goals",
    quality:
      homeRecentForm.length >= 5 &&
      awayRecentForm.length >= 5
        ? "medium"
        : "low",
  };
}
app.get("/test-fixtures", async (req, res) => {
  try {
    const response = await callApiFootball(
      "/fixtures",
      {
        date: "2026-07-19",
        timezone: "Europe/Paris",
      }
    );

    const fixtures =
      response.data?.response || [];

    res.json({
      ok: true,
      count: fixtures.length,
      fixtures: fixtures.map((item) => ({
        fixtureId: item.fixture?.id,
        date: item.fixture?.date,
        home: item.teams?.home?.name,
        away: item.teams?.away?.name,
        status: item.fixture?.status?.short,
      })),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
  }
});




function getApiKey() {
  const apiKey =
    process.env.API_FOOTBALL_KEY;

  if (!apiKey) {
    throw new Error(
      "API_FOOTBALL_KEY manquante"
    );
  }

  return apiKey.trim();
}

async function callApiFootball(
  endpoint,
  params = {}
) {
  const response = await axios.get(
    `${API_BASE_URL}${endpoint}`,
    {
      headers: {
        "x-apisports-key":
          getApiKey(),
      },
      params,
      timeout: 15000,
    }
  );

  return response;
}
function isFriendlyFixture(
  fixture = {}
) {
  const leagueName = String(
    fixture?.league?.name ||
    fixture?.league_name ||
    ""
  )
    .trim()
    .toLowerCase();

  return (
    leagueName.includes("friendl") ||
    leagueName.includes("amical")
  );
}

function isFriendlyLeagueName(
  leagueName = ""
) {
  const normalized = String(
    leagueName
  )
    .trim()
    .toLowerCase();

  return (
    normalized.includes("friendl") ||
    normalized.includes("amical")
  );
}
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service:
      "FootballBrain API",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service:
      "FootballBrain API",
    apiKeyConfigured:
      Boolean(
        process.env
          .API_FOOTBALL_KEY
      ),
  });
});

app.get(
  "/timezone",
  async (req, res) => {
    try {
      const response =
        await callApiFootball(
          "/timezone"
        );

      return res.json({
        ok: true,
        httpStatus:
          response.status,
        data:
          response.data,
      });
   

} catch (error) {
  console.error("ERREUR ANALYSE COMPLÈTE :", error);

  return res
    .status(error.response?.status || 500)
    .json({
      ok: false,

      message:
        error.message ||
        "Erreur inconnue",

      code:
        error.code || null,

      status:
        error.response?.status || null,

      endpoint:
        error.config?.url || null,

      apiData:
        error.response?.data || null,

      stack:
        process.env.NODE_ENV === "production"
          ? undefined
          : error.stack,
    });
}

  }
);

app.get(
  "/fixtures",
  async (req, res) => {
    try {
      const date =
        req.query.date;

      if (!date) {
        return res.status(400).json({
          ok: false,
          error:
            "Le paramètre date est obligatoire. Exemple : /fixtures?date=2026-07-22",
        });
      }

      const dateFormat =
        /^\d{4}-\d{2}-\d{2}$/;

      if (
        !dateFormat.test(date)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "La date doit être au format YYYY-MM-DD.",
        });
      }

      const response =
        await callApiFootball(
          "/fixtures",
          {
  date,
  league: 2,
  season: 2026,
  timezone: "Europe/Paris",
}
        );

      const fixtures =
        Array.isArray(
          response.data?.response
        )
          ? response.data.response
          : [];

      const matches =
        fixtures.map((item) => ({
          fixtureId:
            item.fixture?.id,
          date:
            item.fixture?.date,
          timestamp:
            item.fixture
              ?.timestamp,
          status:
            item.fixture?.status,
          venue:
            item.fixture?.venue,

          league: {
            id:
              item.league?.id,
            name:
              item.league?.name,
            country:
              item.league?.country,
            season:
              item.league?.season,
            round:
              item.league?.round,
            logo:
              item.league?.logo,
          },

          homeTeam: {
            id:
              item.teams?.home
                ?.id,
            name:
              item.teams?.home
                ?.name,
            logo:
              item.teams?.home
                ?.logo,
          },

          awayTeam: {
            id:
              item.teams?.away
                ?.id,
            name:
              item.teams?.away
                ?.name,
            logo:
              item.teams?.away
                ?.logo,
          },
        }));

      return res.json({
        ok: true,
        date,
        count:
          matches.length,
        matches,
      });
    } catch (error) {
      return res.status(
        error.response?.status ||
          500
      ).json({
        ok: false,
        error:
          error.response?.data ||
          error.message,
      });
    }
  }
);
app.get("/fixtures-test", async (req, res) => {
  try {
    const response =
      await callApiFootball(
        "/fixtures",
        {
          live: "all",
        }
      );

    res.json(response.data);
  } catch (error) {
    res.json(
      error.response?.data
    );
  }
});
app.get("/leagues", async (req, res) => {
  try {
    const response = await callApiFootball("/leagues");

    res.json({
      count: response.data.response.length,
      data: response.data.response.slice(0, 20),
    });
  } catch (error) {
    res.status(500).json({
      error: error.response?.data || error.message,
    });
  }
});
app.get("/status", async (req, res) => {
  try {
    const response = await axios.get(
      "https://v3.football.api-sports.io/status",
      {
        headers: {
          "x-apisports-key":
            process.env.API_FOOTBALL_KEY,
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    res.json(
      error.response?.data ||
      error.message
    );
  }
});
app.get("/internal/match/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    const response = await callApiFootball("/fixtures", {
      id: fixtureId,
      timezone: "Europe/Paris",
    });

    const apiData = response.data;

    if (
      apiData.errors &&
      Object.keys(apiData.errors).length > 0
    ) {
      return res.status(502).json({
        ok: false,
        error: apiData.errors,
      });
    }

    const item = apiData.response?.[0];

    if (!item) {
      return res.status(404).json({
        ok: false,
        error: "Match introuvable",
      });
    }

    return res.json({
      ok: true,
      match: {
        fixtureId: item.fixture?.id,
        date: item.fixture?.date,
        timestamp: item.fixture?.timestamp,
        status: item.fixture?.status,
        venue: item.fixture?.venue,

        league: {
          id: item.league?.id,
          name: item.league?.name,
          season: item.league?.season,
          round: item.league?.round,
          logo: item.league?.logo,
        },

        homeTeam: {
          id: item.teams?.home?.id,
          name: item.teams?.home?.name,
          logo: item.teams?.home?.logo,
        },

        awayTeam: {
          id: item.teams?.away?.id,
          name: item.teams?.away?.name,
          logo: item.teams?.away?.logo,
        },

        goals: item.goals,
        score: item.score,
      },
    });
  } catch (error) {
    return res.status(error.response?.status || 500).json({
      ok: false,
      error:
        error.response?.data ||
        error.message,
    });
  }
});
app.get("/internal/match/:fixtureId/context", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    const fixtureResponse = await callApiFootball("/fixtures", {
      id: fixtureId,
      timezone: "Europe/Paris",
    });

    const fixture = fixtureResponse.data?.response?.[0];

    if (!fixture) {
      return res.status(404).json({
        ok: false,
        error: "Match introuvable",
      });
    }

    const leagueId = fixture.league?.id;
    const season = fixture.league?.season;
    const homeTeamId = fixture.teams?.home?.id;
    const awayTeamId = fixture.teams?.away?.id;

    const [
  homeStatsResponse,
  awayStatsResponse,
  homeRecentResponse,
  awayRecentResponse,
  h2hResponse,
] = await Promise.all([
      callApiFootball("/teams/statistics", {
        league: leagueId,
        season,
        team: homeTeamId,
      }),

      callApiFootball("/teams/statistics", {
        league: leagueId,
        season,
        team: awayTeamId,
      }),

      callApiFootball("/fixtures", {
        team: homeTeamId,
        last: 5,
        timezone: "Europe/Paris",
      }),

      callApiFootball("/fixtures", {
        team: awayTeamId,
        last: 5,
        timezone: "Europe/Paris",
      }),
    callApiFootball("/fixtures/headtohead", {
  h2h: `${homeTeamId}-${awayTeamId}`,
  last: 10,
  timezone: "Europe/Paris",
}),

      ]);

    function simplifyRecentMatch(item, teamId) {
      const isHome = item.teams?.home?.id === teamId;

      const goalsFor = isHome
        ? item.goals?.home
        : item.goals?.away;

      const goalsAgainst = isHome
        ? item.goals?.away
        : item.goals?.home;

      let result = "D";

      if (goalsFor > goalsAgainst) {
        result = "W";
      } else if (goalsFor < goalsAgainst) {
        result = "L";
      }

      return {
        fixtureId: item.fixture?.id,
        date: item.fixture?.date,
        competition: item.league?.name,
        opponent: isHome
          ? item.teams?.away?.name
          : item.teams?.home?.name,
        location: isHome ? "home" : "away",
        goalsFor,
        goalsAgainst,
        result,
      };
    }

    const homeRecentMatches =
      homeRecentResponse.data?.response || [];

    const awayRecentMatches =
      awayRecentResponse.data?.response || [];
const h2hMatches =
  h2hResponse.data?.response || [];

const headToHead = h2hMatches.map((item) => ({
  fixtureId: item.fixture?.id,
  date: item.fixture?.date,
  competition: item.league?.name,

  homeTeam: {
    id: item.teams?.home?.id,
    name: item.teams?.home?.name,
  },

  awayTeam: {
    id: item.teams?.away?.id,
    name: item.teams?.away?.name,
  },

  goals: {
    home: item.goals?.home,
    away: item.goals?.away,
  },
}));
    return res.json({
      ok: true,

      match: {
        fixtureId,
        date: fixture.fixture?.date,
        league: fixture.league,
        homeTeam: fixture.teams?.home,
        awayTeam: fixture.teams?.away,
      },

      internalContext: {
        homeTeamStatistics:
          homeStatsResponse.data?.response || null,

        awayTeamStatistics:
          awayStatsResponse.data?.response || null,

        homeRecentForm: homeRecentMatches.map((item) =>
          simplifyRecentMatch(item, homeTeamId)
        ),

        awayRecentForm: awayRecentMatches.map((item) =>
          simplifyRecentMatch(item, awayTeamId)
        ),
     headToHead,
 },
    });


} catch (error) {
  console.error("DEBUG CATCH ANALYSE :", error);

  return res.status(error.response?.status || 500).json({
    ok: false,
    debugCatch: "NOUVEAU_CATCH_ACTIF",
    message: error.message || "Erreur inconnue",
    code: error.code || null,
    status: error.response?.status || null,
    endpoint: error.config?.url || null,
    apiData: error.response?.data ?? null,
  });
}

});

function computeFootballBrainScore(
  homeRecent,
  awayRecent
) {
  const scoreMap = {
    W: 3,
    D: 1,
    L: 0,
  };

  const getScore = (matches) =>
    matches.reduce((sum, match) => {
      return sum + scoreMap[match.result];
    }, 0);

  const homeScore = getScore(homeRecent);
  const awayScore = getScore(awayRecent);

  return {
    homeScore,
    awayScore,
    advantage: homeScore - awayScore,
  };
}
        
app.get("/internal/injuries/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    const fixture = await callApiFootball("/fixtures", {
      id: fixtureId,
    });

    const match = fixture.data.response?.[0];

    if (!match) {
      return res.status(404).json({
        ok: false,
        error: "Match introuvable",
      });
    }

    const [home, away] = await Promise.all([
      callApiFootball("/injuries", {
        team: match.teams.home.id,
        season: match.league.season,
      }),
      callApiFootball("/injuries", {
        team: match.teams.away.id,
        season: match.league.season,
      }),
    ]);

    res.json({
      ok: true,
      home: home.data.response,
      away: away.data.response,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/internal/lineups/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    const response = await callApiFootball(
      "/fixtures/lineups",
      {
        fixture: fixtureId,
      }
    );

    res.json({
      ok: true,
      count: response.data.results,
      lineups: response.data.response,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/internal/predictions/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    const fixture = await callApiFootball("/fixtures", {
      id: fixtureId,
    });

    const match = fixture.data.response?.[0];

    const response = await callApiFootball(
      "/predictions",
      {
        fixture: fixtureId,
      }
    );

    res.json({
      ok: true,
      prediction:
        response.data.response?.[0] || null,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

function computeFootballBrainRating({
  footballBrain,
  footballBrainDecision,
  market,
  headToHead,
}) {
  const homeScore = footballBrain?.homeScore || 0;
  const awayScore = footballBrain?.awayScore || 0;
  const totalFormScore = homeScore + awayScore;

  const formScore =
    totalFormScore > 0
      ? Math.round(
          (Math.max(homeScore, awayScore) /
            totalFormScore) *
            100
        )
      : 50;

  const marketScore =
    footballBrainDecision?.selectedOutcome ===
    market?.marketFavorite
      ? 80
      : 45;

  let h2hScore = 50;

  if (Array.isArray(headToHead) && headToHead.length > 0) {
    const draws = headToHead.filter(
      (match) =>
        match.goals?.home === match.goals?.away
    ).length;

    h2hScore = Math.round(
      (draws / headToHead.length) * 100
    );
  }

  const valueScore =
    footballBrainDecision?.value === null
      ? 50
      : Math.max(
          0,
          Math.min(
            100,
            Math.round(
              50 + footballBrainDecision.value * 2
            )
          )
        );

  const confidenceScore =
    footballBrainDecision?.confidence || 50;

  const globalScore = Math.round(
    formScore * 0.3 +
      marketScore * 0.25 +
      h2hScore * 0.15 +
      valueScore * 0.15 +
      confidenceScore * 0.15
  );

  return {
    form: formScore,
    market: marketScore,
    h2h: h2hScore,
    value: valueScore,
    confidence: confidenceScore,
    global: globalScore,
  };
}
function readPredictionHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return [];
    }

    const content = fs.readFileSync(HISTORY_FILE, "utf8");

    return content ? JSON.parse(content) : [];
  } catch (error) {
    console.error("Erreur lecture historique :", error.message);
    return [];
  }
}

function savePredictionHistory(history) {
  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(history, null, 2),
    "utf8"
  );
}

function saveFootballBrainPrediction(analysis) {
  const history = readPredictionHistory();

  const alreadyExists = history.some(
    (item) => item.fixtureId === analysis.fixtureId
  );

  if (alreadyExists) {
    return false;
  }

  history.push({
    fixtureId: analysis.fixtureId,
    createdAt: new Date().toISOString(),

    match: {
      date: analysis.match?.date,
      homeTeam: analysis.match?.homeTeam?.name,
      awayTeam: analysis.match?.awayTeam?.name,
      league: analysis.match?.league?.name,
    },

    prediction: {
      probabilities:
        analysis.footballBrainDecision?.probabilities,

      decision:
        analysis.footballBrainDecision?.decision,

      selectedOutcome:
        analysis.footballBrainDecision?.selectedOutcome,

      confidence:
        analysis.footballBrainDecision?.confidence,

      risk:
        analysis.footballBrainDecision?.risk,

      fairOdd:
        analysis.footballBrainDecision?.fairOdd,

      marketOdd:
        analysis.footballBrainDecision?.marketOdd,

      value:
        analysis.footballBrainDecision?.value,

      betStatus:
        analysis.footballBrainDecision?.betStatus,

      explanation:
        analysis.footballBrainDecision?.explanation,
    },

    result: {
      status: "PENDING",
      homeGoals: null,
      awayGoals: null,
      won: null,
      profit: null,
    },
  });

  savePredictionHistory(history);

  return true;
}
function computeHistoryStats(history) {
  const totalPredictions = history.length;

  const completed = history.filter(
    (item) => item.result?.status === "COMPLETED"
  );

  const noBet = history.filter(
    (item) => item.prediction?.betStatus === "NO_BET"
  ).length;

  const settledBets = completed.filter(
    (item) =>
      item.prediction?.betStatus !== "NO_BET" &&
      typeof item.result?.won === "boolean"
  );

  const wins = settledBets.filter(
    (item) => item.result.won === true
  ).length;

  const losses = settledBets.filter(
    (item) => item.result.won === false
  ).length;

  const totalProfit = settledBets.reduce(
    (sum, item) =>
      sum + Number(item.result?.profit || 0),
    0
  );

  const totalStake = settledBets.length;

  const winRate =
    settledBets.length > 0
      ? Number(
          (
            (wins / settledBets.length) *
            100
          ).toFixed(1)
        )
      : 0;

  const roi =
    totalStake > 0
      ? Number(
          (
            (totalProfit / totalStake) *
            100
          ).toFixed(1)
        )
      : 0;

  const averageConfidence =
    totalPredictions > 0
      ? Number(
          (
            history.reduce(
              (sum, item) =>
                sum +
                Number(
                  item.prediction?.confidence || 0
                ),
              0
            ) / totalPredictions
          ).toFixed(1)
        )
      : 0;

  const decisions = history.reduce(
    (acc, item) => {
      const decision =
        item.prediction?.decision || "Inconnue";

      acc[decision] =
        (acc[decision] || 0) + 1;

      return acc;
    },
    {}
  );

  return {
    totalPredictions,
    completedPredictions: completed.length,
    pendingPredictions:
      totalPredictions - completed.length,
    noBet,
    settledBets: settledBets.length,
    wins,
    losses,
    winRate,
    totalProfit: Number(totalProfit.toFixed(2)),
    roi,
    averageConfidence,
    decisions,
  };
}
app.get("/internal/history", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM predictions
      ORDER BY fixture_date DESC NULLS LAST,
               created_at DESC
    `);

    return res.json({
      ok: true,
      count: result.rows.length,
      history: result.rows,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/internal/stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::INTEGER AS total_predictions,

        COUNT(*) FILTER (
          WHERE result_status = 'COMPLETED'
        )::INTEGER AS completed_predictions,

        COUNT(*) FILTER (
          WHERE result_status = 'PENDING'
        )::INTEGER AS pending_predictions,

        COUNT(*) FILTER (
          WHERE bet_status = 'NO_BET'
        )::INTEGER AS no_bet,

        COUNT(*) FILTER (
          WHERE result_status = 'COMPLETED'
            AND bet_status <> 'NO_BET'
            AND won IS NOT NULL
        )::INTEGER AS settled_bets,

        COUNT(*) FILTER (
          WHERE won = TRUE
        )::INTEGER AS wins,

        COUNT(*) FILTER (
          WHERE won = FALSE
        )::INTEGER AS losses,

        COALESCE(
          SUM(profit) FILTER (
            WHERE result_status = 'COMPLETED'
              AND bet_status <> 'NO_BET'
          ),
          0
        )::NUMERIC AS total_profit,

        COALESCE(
          AVG(confidence),
          0
        )::NUMERIC AS average_confidence
      FROM predictions
    `);

    const row = result.rows[0];

    const settledBets =
      Number(row.settled_bets);

    const wins = Number(row.wins);
    const totalProfit =
      Number(row.total_profit);

    const winRate =
      settledBets > 0
        ? Number(
            (
              (wins / settledBets) *
              100
            ).toFixed(1)
          )
        : 0;

    // Chaque pari réglé représente une mise de 1 unité.
    const roi =
      settledBets > 0
        ? Number(
            (
              (totalProfit / settledBets) *
              100
            ).toFixed(1)
          )
        : 0;

    const decisionsResult =
      await pool.query(`
        SELECT
          decision,
          COUNT(*)::INTEGER AS count
        FROM predictions
        GROUP BY decision
        ORDER BY count DESC
      `);

    const decisions = {};

    for (const item of decisionsResult.rows) {
      decisions[
        item.decision || "Inconnue"
      ] = Number(item.count);
    }

    return res.json({
      ok: true,
      stats: {
        totalPredictions:
          Number(row.total_predictions),
        completedPredictions:
          Number(row.completed_predictions),
        pendingPredictions:
          Number(row.pending_predictions),
        noBet:
          Number(row.no_bet),
        settledBets,
        wins,
        losses:
          Number(row.losses),
        winRate,
        totalProfit:
          Number(totalProfit.toFixed(2)),
        roi,
        averageConfidence:
          Number(
            Number(
              row.average_confidence
            ).toFixed(1)
          ),
        decisions,
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
function computePhaseOneContext({
  match,
  homeResults,
  awayResults,
  market,
  baseScore,
}) {
  // Avantage fixe pour l'équipe à domicile
  const homeAdvantageBonus = 2;

  function countWinningStreak(results) {
    let streak = 0;

    for (const result of results) {
      if (result !== "W") break;
      streak += 1;
    }

    return streak;
  }

  const homeWinningStreak =
    countWinningStreak(homeResults);

  const awayWinningStreak =
    countWinningStreak(awayResults);

  // Bonus limité à 3 points
  const homeStreakBonus =
    Math.min(homeWinningStreak, 3);

  const awayStreakBonus =
    Math.min(awayWinningStreak, 3);

  const leagueName =
    match?.league?.name || "";

  const round =
    match?.league?.round || "";

  let matchImportance = "normale";
  let importanceScore = 1;

  if (
    leagueName.includes("Champions League") ||
    leagueName.includes("Europa League")
  ) {
    matchImportance = "élevée";
    importanceScore = 2;
  }

  if (
    round.includes("Final") ||
    round.includes("Semi") ||
    round.includes("Quarter")
  ) {
    matchImportance = "très élevée";
    importanceScore = 3;
  }

  if (leagueName.includes("Friendlies")) {
    matchImportance = "faible";
    importanceScore = 0;
  }

  const adjustedHomeScore =
    baseScore.homeScore +
    homeAdvantageBonus +
    homeStreakBonus;

  const adjustedAwayScore =
    baseScore.awayScore +
    awayStreakBonus;

  let footballBrainFavorite = "draw";

  if (adjustedHomeScore > adjustedAwayScore) {
    footballBrainFavorite = "home";
  }

  if (adjustedAwayScore > adjustedHomeScore) {
    footballBrainFavorite = "away";
  }

  const marketFavorite =
    market?.marketFavorite || null;

  const marketAgreement =
    marketFavorite !== null &&
    footballBrainFavorite === marketFavorite;

  return {
    adjustedHomeScore,
    adjustedAwayScore,
    adjustedAdvantage:
      adjustedHomeScore - adjustedAwayScore,

    homeAdvantageBonus,

    winningStreaks: {
      home: homeWinningStreak,
      away: awayWinningStreak,
    },

    streakBonuses: {
      home: homeStreakBonus,
      away: awayStreakBonus,
    },

    matchImportance,
    importanceScore,

    marketAgreement: {
      agrees: marketAgreement,
      marketFavorite,
      footballBrainFavorite,
    },
  };
}
function computePhaseTwoContext({
  fixture,
  homeRecentForm,
  awayRecentForm,
  injuries,
  lineups,
}) {
  const homeTeamId = fixture.teams?.home?.id;
  const awayTeamId = fixture.teams?.away?.id;

  const homeInjuries = injuries.filter(
    (item) => item.team?.id === homeTeamId
  );

  const awayInjuries = injuries.filter(
    (item) => item.team?.id === awayTeamId
  );

  function injuryWeight(item) {
    const type = String(item.player?.type || "").toLowerCase();
    const reason = String(
      item.player?.reason || item.player?.type || ""
    ).toLowerCase();

    if (type.includes("suspension")) return 2;

    if (
      reason.includes("knee") ||
      reason.includes("hamstring") ||
      reason.includes("fracture")
    ) {
      return 2;
    }

    return 1;
  }
function getParisDateString() {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  ).format(new Date());
}
  const homeInjuryPenalty = Math.min(
    6,
    homeInjuries.reduce(
      (sum, item) => sum + injuryWeight(item),
      0
    )
  );

  const awayInjuryPenalty = Math.min(
    6,
    awayInjuries.reduce(
      (sum, item) => sum + injuryWeight(item),
      0
    )
  );

  function getRestDays(recentMatches, kickoffDate) {
    const latestFinishedMatch = recentMatches.find(
      (item) =>
        item.fixture?.status?.short === "FT" &&
        item.fixture?.date
    );

    if (!latestFinishedMatch) return null;

    const kickoff = new Date(kickoffDate);
    const previousMatch = new Date(
      latestFinishedMatch.fixture.date
    );

    const difference =
      kickoff.getTime() - previousMatch.getTime();

    return Math.max(
      0,
      Math.floor(difference / (1000 * 60 * 60 * 24))
    );
  }

  const homeRestDays = getRestDays(
    homeRecentForm,
    fixture.fixture?.date
  );

  const awayRestDays = getRestDays(
    awayRecentForm,
    fixture.fixture?.date
  );

  function fatiguePenalty(restDays) {
    if (restDays === null) return 0;
    if (restDays <= 2) return 3;
    if (restDays <= 4) return 2;
    if (restDays <= 6) return 1;
    return 0;
  }

  const homeFatiguePenalty =
    fatiguePenalty(homeRestDays);

  const awayFatiguePenalty =
    fatiguePenalty(awayRestDays);

  const homeLineup = lineups.find(
    (item) => item.team?.id === homeTeamId
  );

  const awayLineup = lineups.find(
    (item) => item.team?.id === awayTeamId
  );

  const homeLineupConfirmed =
    Array.isArray(homeLineup?.startXI) &&
    homeLineup.startXI.length >= 11;

  const awayLineupConfirmed =
    Array.isArray(awayLineup?.startXI) &&
    awayLineup.startXI.length >= 11;

  return {
    injuries: {
      homeCount: homeInjuries.length,
      awayCount: awayInjuries.length,
      homePenalty: homeInjuryPenalty,
      awayPenalty: awayInjuryPenalty,
    },

    fatigue: {
      homeRestDays,
      awayRestDays,
      homePenalty: homeFatiguePenalty,
      awayPenalty: awayFatiguePenalty,
    },

    lineups: {
      homeConfirmed: homeLineupConfirmed,
      awayConfirmed: awayLineupConfirmed,
      homeFormation: homeLineup?.formation || null,
      awayFormation: awayLineup?.formation || null,
    },

    scoreAdjustment: {
      home:
        -homeInjuryPenalty -
        homeFatiguePenalty,

      away:
        -awayInjuryPenalty -
        awayFatiguePenalty,
    },
  };
}
function hasCompleteMonteCarlo(model) {
  return Boolean(
    model &&
      Number(model.simulations) > 0 &&
      Array.isArray(model.topScores) &&
      model.topScores.length > 0 &&
      Number.isFinite(Number(model.btts)) &&
      Number.isFinite(Number(model.over25))
  );
}
app.get("/internal/db-test", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT NOW() AS current_time"
    );

    return res.json({
      ok: true,
      database: "connected",
      time: result.rows[0].current_time,
    });
  } catch (error) {
    console.error("ERREUR DB TEST :", error);

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Erreur inconnue",
      code:
        error.code || null,
      host:
        error.address || null,
      port:
        error.port || null,
    });
  }
});

app.get("/internal/db-init", async (req, res) => {
  try {
    await initializeDatabase();

    return res.json({
      ok: true,
      message: "Tables FootballBrain créées",
      tables: [
        "teams",
        "elo_ratings",
        "elo_history",
        "predictions",
      ],
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

async function upsertTeam(team, country = null) {
  const result = await pool.query(
    `
      INSERT INTO teams (
        api_team_id,
        name,
        country,
        logo,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW())

      ON CONFLICT (api_team_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        country = COALESCE(EXCLUDED.country, teams.country),
        logo = EXCLUDED.logo,
        updated_at = NOW()

      RETURNING *
    `,
    [
      team.id,
      team.name,
      country,
      team.logo || null,
    ]
  );

  return result.rows[0];
}

async function getOrCreateTeamElo(teamDatabaseId) {
  const result = await pool.query(
    `
      INSERT INTO elo_ratings (
        team_id,
        rating,
        matches_played
      )
      VALUES ($1, 1500, 0)

      ON CONFLICT (team_id)
      DO UPDATE SET
        team_id = EXCLUDED.team_id

      RETURNING *
    `,
    [teamDatabaseId]
  );

  return result.rows[0];
}

function calculateExpectedElo(ratingA, ratingB) {
  return 1 / (
    1 + Math.pow(10, (ratingB - ratingA) / 400)
  );
}

function calculateEloResult(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) {
    return {
      homeResult: 1,
      awayResult: 0,
    };
  }

  if (homeGoals < awayGoals) {
    return {
      homeResult: 0,
      awayResult: 1,
    };
  }

  return {
    homeResult: 0.5,
    awayResult: 0.5,
  };
}

async function updateEloFromFinishedFixture(fixture) {
  const status = fixture.fixture?.status?.short;

  if (!["FT", "AET", "PEN"].includes(status)) {
    throw new Error(
      "Le match n'est pas encore terminé"
    );
  }

  const fixtureId = fixture.fixture.id;

  const homeApiTeam = fixture.teams.home;
  const awayApiTeam = fixture.teams.away;

  const homeGoals = fixture.goals?.home;
  const awayGoals = fixture.goals?.away;

  if (
    !Number.isFinite(homeGoals) ||
    !Number.isFinite(awayGoals)
  ) {
    throw new Error(
      "Le score final du match est indisponible"
    );
  }

  const homeTeam = await upsertTeam(
    homeApiTeam,
    fixture.league?.country || null
  );

  const awayTeam = await upsertTeam(
    awayApiTeam,
    fixture.league?.country || null
  );

  const homeElo = await getOrCreateTeamElo(
    homeTeam.id
  );

  const awayElo = await getOrCreateTeamElo(
    awayTeam.id
  );

  const alreadyProcessed = await pool.query(
    `
      SELECT id
      FROM elo_history
      WHERE fixture_id = $1
      LIMIT 1
    `,
    [fixtureId]
  );

  if (alreadyProcessed.rows.length > 0) {
    return {
      alreadyProcessed: true,

      home: {
        team: homeTeam.name,
        rating: Number(homeElo.rating),
      },

      away: {
        team: awayTeam.name,
        rating: Number(awayElo.rating),
      },
    };
  }

  const homeRatingBefore =
    Number(homeElo.rating);

  const awayRatingBefore =
    Number(awayElo.rating);

  const expectedHome = calculateExpectedElo(
    homeRatingBefore + 60,
    awayRatingBefore
  );

  const expectedAway = 1 - expectedHome;

  const {
    homeResult,
    awayResult,
  } = calculateEloResult(
    homeGoals,
    awayGoals
  );

  const K_FACTOR = 32;

  const homeChange = Number(
    (
      K_FACTOR *
      (homeResult - expectedHome)
    ).toFixed(2)
  );

  const awayChange = Number(
    (
      K_FACTOR *
      (awayResult - expectedAway)
    ).toFixed(2)
  );

  const homeRatingAfter = Number(
    (homeRatingBefore + homeChange).toFixed(2)
  );

  const awayRatingAfter = Number(
    (awayRatingBefore + awayChange).toFixed(2)
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        UPDATE elo_ratings
        SET
          rating = $1,
          matches_played = matches_played + 1,
          updated_at = NOW()
        WHERE team_id = $2
      `,
      [
        homeRatingAfter,
        homeTeam.id,
      ]
    );

    await client.query(
      `
        UPDATE elo_ratings
        SET
          rating = $1,
          matches_played = matches_played + 1,
          updated_at = NOW()
        WHERE team_id = $2
      `,
      [
        awayRatingAfter,
        awayTeam.id,
      ]
    );

    await client.query(
      `
        INSERT INTO elo_history (
          team_id,
          fixture_id,
          rating_before,
          rating_after,
          rating_change
        )
        VALUES
          ($1, $2, $3, $4, $5),
          ($6, $2, $7, $8, $9)
      `,
      [
        homeTeam.id,
        fixtureId,
        homeRatingBefore,
        homeRatingAfter,
        homeChange,

        awayTeam.id,
        awayRatingBefore,
        awayRatingAfter,
        awayChange,
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    alreadyProcessed: false,

    fixtureId,

    score: {
      home: homeGoals,
      away: awayGoals,
    },

    home: {
      teamId: homeApiTeam.id,
      team: homeTeam.name,
      ratingBefore: homeRatingBefore,
      ratingAfter: homeRatingAfter,
      change: homeChange,
    },

    away: {
      teamId: awayApiTeam.id,
      team: awayTeam.name,
      ratingBefore: awayRatingBefore,
      ratingAfter: awayRatingAfter,
      change: awayChange,
    },
  };
}
app.get(
  "/internal/elo/process/:fixtureId",
  async (req, res) => {
    try {
      const fixtureId =
        Number(req.params.fixtureId);

      if (
        !Number.isInteger(fixtureId) ||
        fixtureId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "fixtureId invalide",
        });
      }

      const response =
        await callApiFootball(
          "/fixtures",
          {
            id: fixtureId,
            timezone: "Europe/Paris",
          }
        );

      const fixture =
        response.data?.response?.[0];

      if (!fixture) {
        return res.status(404).json({
          ok: false,
          error: "Match introuvable",
        });
      }

      const eloResult =
        await updateEloFromFinishedFixture(
          fixture
        );

      return res.json({
        ok: true,
        elo: eloResult,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
app.get(
  "/internal/team/:apiTeamId",
  async (req, res) => {
    try {
      const apiTeamId =
        Number(req.params.apiTeamId);

      const result = await pool.query(
        `
          SELECT
            t.api_team_id,
            t.name,
            t.country,
            t.logo,
            e.rating,
            e.matches_played,
            e.updated_at
          FROM teams t
          LEFT JOIN elo_ratings e
            ON e.team_id = t.id
          WHERE t.api_team_id = $1
        `,
        [apiTeamId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error:
            "Équipe absente du classement Elo",
        });
      }

      return res.json({
        ok: true,
        team: result.rows[0],
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
app.get(
  "/internal/team/:apiTeamId",
  async (req, res) => {
    try {
      const apiTeamId =
        Number(req.params.apiTeamId);

      const result = await pool.query(
        `
          SELECT
            t.api_team_id,
            t.name,
            t.country,
            t.logo,
            e.rating,
            e.matches_played,
            e.updated_at
          FROM teams t
          LEFT JOIN elo_ratings e
            ON e.team_id = t.id
          WHERE t.api_team_id = $1
        `,
        [apiTeamId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          ok: false,
          error:
            "Équipe absente du classement Elo",
        });
      }

      return res.json({
        ok: true,
        team: result.rows[0],
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
app.get(
  "/internal/elo-rankings",
  async (req, res) => {
    try {
      const limit = Math.min(
        100,
        Math.max(
          1,
          Number(req.query.limit) || 50
        )
      );

      const result = await pool.query(
        `
          SELECT
            t.api_team_id,
            t.name,
            t.country,
            t.logo,
            e.rating,
            e.matches_played,
            e.updated_at
          FROM elo_ratings e
          JOIN teams t
            ON t.id = e.team_id
          ORDER BY e.rating DESC
          LIMIT $1
        `,
        [limit]
      );

      return res.json({
        ok: true,
        count: result.rows.length,
        rankings: result.rows.map(
          (team, index) => ({
            rank: index + 1,
            ...team,
          })
        ),
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
function normalizeSettlementMarket(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[ÀÁÂÃÄÅ]/g, "A")
    .replace(/[ÈÉÊË]/g, "E")
    .replace(/[ÌÍÎÏ]/g, "I")
    .replace(/[ÒÓÔÕÖ]/g, "O")
    .replace(/[ÙÚÛÜ]/g, "U")
    .replace(/Ç/g, "C")
    .replace(/[\s./-]+/g, "_")
    .replace(/__+/g, "_");
}

function resolveSettlementMarket(
  prediction = {}
) {
  const rawMarket =
    prediction.studio_market_key ||
    prediction.selected_outcome ||
    prediction.decision ||
    "";

  const normalized =
    normalizeSettlementMarket(
      rawMarket
    );

  const aliases = {
    /*
     * 1N2
     */
    "1": "HOME",
    HOME: "HOME",
    HOME_WIN: "HOME",
    DOMICILE: "HOME",
    VICTOIRE_DOMICILE: "HOME",

    X: "DRAW",
    N: "DRAW",
    DRAW: "DRAW",
    MATCH_NUL: "DRAW",

    "2": "AWAY",
    AWAY: "AWAY",
    AWAY_WIN: "AWAY",
    EXTERIEUR: "AWAY",
    VICTOIRE_EXTERIEUR: "AWAY",

    /*
     * Over / Under
     */
    OVER15: "OVER15",
    OVER_15: "OVER15",
    OVER_1_5: "OVER15",
    PLUS_DE_1_5_BUTS: "OVER15",

    UNDER15: "UNDER15",
    UNDER_15: "UNDER15",
    UNDER_1_5: "UNDER15",
    MOINS_DE_1_5_BUTS: "UNDER15",

    OVER25: "OVER25",
    OVER_25: "OVER25",
    OVER_2_5: "OVER25",
    PLUS_DE_2_5_BUTS: "OVER25",

    UNDER25: "UNDER25",
    UNDER_25: "UNDER25",
    UNDER_2_5: "UNDER25",
    MOINS_DE_2_5_BUTS: "UNDER25",

    OVER35: "OVER35",
    OVER_35: "OVER35",
    OVER_3_5: "OVER35",
    PLUS_DE_3_5_BUTS: "OVER35",

    UNDER35: "UNDER35",
    UNDER_35: "UNDER35",
    UNDER_3_5: "UNDER35",
    MOINS_DE_3_5_BUTS: "UNDER35",

    OVER45: "OVER45",
    OVER_45: "OVER45",
    OVER_4_5: "OVER45",
    PLUS_DE_4_5_BUTS: "OVER45",

    UNDER45: "UNDER45",
    UNDER_45: "UNDER45",
    UNDER_4_5: "UNDER45",
    MOINS_DE_4_5_BUTS: "UNDER45",

    /*
     * Les deux équipes marquent
     */
    BTTS: "BTTS_YES",
    BTTS_YES: "BTTS_YES",
    BOTH_TEAMS_TO_SCORE: "BTTS_YES",
    OUI: "BTTS_YES",
    LES_DEUX_EQUIPES_MARQUENT: "BTTS_YES",

    BTTS_NO: "BTTS_NO",
    NO_BTTS: "BTTS_NO",
    NON: "BTTS_NO",
    LES_DEUX_EQUIPES_NE_MARQUENT_PAS:
      "BTTS_NO",

    /*
     * Double chance
     */
    "1X": "1X",
    HOME_OR_DRAW: "1X",
    DOMICILE_OU_NUL: "1X",

    X2: "X2",
    DRAW_OR_AWAY: "X2",
    NUL_OU_EXTERIEUR: "X2",

    "12": "12",
    HOME_OR_AWAY: "12",
    PAS_DE_NUL: "12",

    /*
     * Draw No Bet
     */
    HOME_DNB: "HOME_DNB",
    DNB_HOME: "HOME_DNB",
    DOMICILE_REMBOURSE_SI_NUL:
      "HOME_DNB",

    AWAY_DNB: "AWAY_DNB",
    DNB_AWAY: "AWAY_DNB",
    EXTERIEUR_REMBOURSE_SI_NUL:
      "AWAY_DNB",
  };

  return aliases[normalized] ||
    normalized;
}

function getActualMatchOutcome(
  homeGoals,
  awayGoals
) {
  if (homeGoals > awayGoals) {
    return "HOME";
  }

  if (awayGoals > homeGoals) {
    return "AWAY";
  }

  return "DRAW";
}

function getSettlementProfit({
  outcome,
  marketOdd,
}) {
  if (
    outcome === "NO_BET" ||
    outcome === "PUSH"
  ) {
    return 0;
  }

  if (outcome === "LOSS") {
    return -1;
  }

  const odd =
    Number(marketOdd);

  if (
    !Number.isFinite(odd) ||
    odd <= 1
  ) {
    /*
     * Le résultat sportif est gagné,
     * mais le profit ne peut pas être
     * calculé sans cote exploitable.
     */
    return 0;
  }

  return Number(
    (odd - 1).toFixed(2)
  );
}
function settlePrediction(
  prediction,
  fixture
) {
  const homeGoals =
    Number(fixture.goals?.home);

  const awayGoals =
    Number(fixture.goals?.away);

  if (
    !Number.isFinite(homeGoals) ||
    !Number.isFinite(awayGoals)
  ) {
    throw new Error(
      "Score final indisponible"
    );
  }

  const totalGoals =
    homeGoals + awayGoals;

  const bothTeamsScored =
    homeGoals > 0 &&
    awayGoals > 0;

  const actualOutcome =
    getActualMatchOutcome(
      homeGoals,
      awayGoals
    );

  const market =
    resolveSettlementMarket(
      prediction
    );

  const isNoBet =
    String(
      prediction.bet_status || ""
    ).toUpperCase() === "NO_BET";

  if (isNoBet) {
    return {
      homeGoals,
      awayGoals,
      totalGoals,

      market,
      actualOutcome,

      outcome: "NO_BET",
      won: null,
      profit: 0,

      explanation:
        "Analyse classée NO_BET : aucun pari simulé.",

      settledBy:
        market || "NO_BET",
    };
  }

  let outcome = null;
  let explanation = "";

  switch (market) {
    /*
     * 1N2
     */
    case "HOME":
      outcome =
        actualOutcome === "HOME"
          ? "WIN"
          : "LOSS";

      explanation =
        actualOutcome === "HOME"
          ? `Victoire à domicile confirmée (${homeGoals}-${awayGoals}).`
          : `L'équipe à domicile n'a pas gagné (${homeGoals}-${awayGoals}).`;
      break;

    case "DRAW":
      outcome =
        actualOutcome === "DRAW"
          ? "WIN"
          : "LOSS";

      explanation =
        actualOutcome === "DRAW"
          ? `Match nul confirmé (${homeGoals}-${awayGoals}).`
          : `Le match ne s'est pas terminé sur un nul (${homeGoals}-${awayGoals}).`;
      break;

    case "AWAY":
      outcome =
        actualOutcome === "AWAY"
          ? "WIN"
          : "LOSS";

      explanation =
        actualOutcome === "AWAY"
          ? `Victoire à l'extérieur confirmée (${homeGoals}-${awayGoals}).`
          : `L'équipe à l'extérieur n'a pas gagné (${homeGoals}-${awayGoals}).`;
      break;

    /*
     * Plus de buts
     */
    case "OVER15":
      outcome =
        totalGoals > 1.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "plus" : "pas plus"} de 1,5 but.`;
      break;

    case "OVER25":
      outcome =
        totalGoals > 2.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "plus" : "pas plus"} de 2,5 buts.`;
      break;

    case "OVER35":
      outcome =
        totalGoals > 3.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "plus" : "pas plus"} de 3,5 buts.`;
      break;

    case "OVER45":
      outcome =
        totalGoals > 4.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "plus" : "pas plus"} de 4,5 buts.`;
      break;

    /*
     * Moins de buts
     */
    case "UNDER15":
      outcome =
        totalGoals < 1.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "moins" : "pas moins"} de 1,5 but.`;
      break;

    case "UNDER25":
      outcome =
        totalGoals < 2.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "moins" : "pas moins"} de 2,5 buts.`;
      break;

    case "UNDER35":
      outcome =
        totalGoals < 3.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "moins" : "pas moins"} de 3,5 buts.`;
      break;

    case "UNDER45":
      outcome =
        totalGoals < 4.5
          ? "WIN"
          : "LOSS";

      explanation =
        `${totalGoals} but(s) inscrit(s) : ` +
        `${outcome === "WIN" ? "moins" : "pas moins"} de 4,5 buts.`;
      break;

    /*
     * BTTS
     */
    case "BTTS_YES":
      outcome =
        bothTeamsScored
          ? "WIN"
          : "LOSS";

      explanation =
        bothTeamsScored
          ? `Les deux équipes ont marqué (${homeGoals}-${awayGoals}).`
          : `Au moins une équipe n'a pas marqué (${homeGoals}-${awayGoals}).`;
      break;

    case "BTTS_NO":
      outcome =
        !bothTeamsScored
          ? "WIN"
          : "LOSS";

      explanation =
        !bothTeamsScored
          ? `Au moins une équipe n'a pas marqué (${homeGoals}-${awayGoals}).`
          : `Les deux équipes ont marqué (${homeGoals}-${awayGoals}).`;
      break;

    /*
     * Double chance
     */
    case "1X":
      outcome =
        actualOutcome === "HOME" ||
        actualOutcome === "DRAW"
          ? "WIN"
          : "LOSS";

      explanation =
        outcome === "WIN"
          ? `Domicile ou nul validé (${homeGoals}-${awayGoals}).`
          : `Victoire extérieure : double chance 1X perdue (${homeGoals}-${awayGoals}).`;
      break;

    case "X2":
      outcome =
        actualOutcome === "DRAW" ||
        actualOutcome === "AWAY"
          ? "WIN"
          : "LOSS";

      explanation =
        outcome === "WIN"
          ? `Nul ou extérieur validé (${homeGoals}-${awayGoals}).`
          : `Victoire à domicile : double chance X2 perdue (${homeGoals}-${awayGoals}).`;
      break;

    case "12":
      outcome =
        actualOutcome !== "DRAW"
          ? "WIN"
          : "LOSS";

      explanation =
        outcome === "WIN"
          ? `Le match possède un vainqueur (${homeGoals}-${awayGoals}).`
          : `Le match s'est terminé sur un nul (${homeGoals}-${awayGoals}).`;
      break;

    /*
     * Draw No Bet
     */
    case "HOME_DNB":
      if (actualOutcome === "DRAW") {
        outcome = "PUSH";
        explanation =
          `Match nul (${homeGoals}-${awayGoals}) : mise remboursée.`;
      } else if (
        actualOutcome === "HOME"
      ) {
        outcome = "WIN";
        explanation =
          `Victoire à domicile (${homeGoals}-${awayGoals}).`;
      } else {
        outcome = "LOSS";
        explanation =
          `Défaite à domicile (${homeGoals}-${awayGoals}).`;
      }
      break;

    case "AWAY_DNB":
      if (actualOutcome === "DRAW") {
        outcome = "PUSH";
        explanation =
          `Match nul (${homeGoals}-${awayGoals}) : mise remboursée.`;
      } else if (
        actualOutcome === "AWAY"
      ) {
        outcome = "WIN";
        explanation =
          `Victoire à l'extérieur (${homeGoals}-${awayGoals}).`;
      } else {
        outcome = "LOSS";
        explanation =
          `Défaite de l'équipe extérieure (${homeGoals}-${awayGoals}).`;
      }
      break;

    default:
      /*
       * Sécurité :
       * on ne marque jamais automatiquement
       * un marché inconnu comme perdu.
       */
      outcome = "UNSUPPORTED";

      explanation =
        `Marché non pris en charge : ${
          market || "inconnu"
        }.`;
      break;
  }

  const won =
    outcome === "WIN"
      ? true
      : outcome === "LOSS"
      ? false
      : null;

  const profit =
    getSettlementProfit({
      outcome,
      marketOdd:
        prediction.market_odd,
    });

  return {
    homeGoals,
    awayGoals,
    totalGoals,

    market,
    actualOutcome,

    outcome,
    won,
    profit,

    explanation,

    settledBy:
      market,
  };
}
function getApiFootballErrorText(
  value
) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(getApiFootballErrorText)
      .filter(Boolean)
      .join(" ");
  }

  if (typeof value === "object") {
    return Object.values(value)
      .map(getApiFootballErrorText)
      .filter(Boolean)
      .join(" ");
  }

  return String(value);
}

function isApiFootballQuotaMessage(
  value
) {
  const message =
    getApiFootballErrorText(value)
      .toLowerCase();

  return (
    message.includes("request limit") ||
    message.includes("requests limit") ||
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("too many requests") ||
    message.includes("limit for the day") ||
    message.includes("daily limit")
  );
}

function isApiFootballQuotaError(
  error
) {
  if (
    error?.code ===
    "API_FOOTBALL_QUOTA_REACHED"
  ) {
    return true;
  }

  const status =
    error?.response?.status ||
    error?.status ||
    null;

  if (status === 429) {
    return true;
  }

  return isApiFootballQuotaMessage([
    error?.message,
    error?.response?.data,
    error?.response?.data?.errors,
  ]);
}

function createApiFootballQuotaError(
  details
) {
  const error = new Error(
    "Quota API-Football atteint"
  );

  error.code =
    "API_FOOTBALL_QUOTA_REACHED";

  error.details =
    getApiFootballErrorText(details);

  return error;
}
async function updatePendingPredictions(limit = 20) {
  const pendingResult = await pool.query(
    `
      SELECT *
      FROM predictions
      WHERE result_status = 'PENDING'
        AND fixture_date <= NOW()
      ORDER BY fixture_date ASC
      LIMIT $1
    `,
    [limit]
  );

  const summary = {
  checked: 0,
  completed: 0,
  stillPending: 0,
  errors: 0,

  quotaReached: false,
  stoppedEarly: false,
  stopReason: null,

  items: [],
};

  for (const prediction of pendingResult.rows) {
    summary.checked += 1;

    try {
     const response =
  await callApiFootball(
    "/fixtures",
    {
      id:
        prediction.fixture_id,

      timezone:
        "Europe/Paris",
    }
  );

const apiErrors =
  response?.data?.errors;

if (
  apiErrors &&
  Object.keys(apiErrors).length > 0
) {
  if (
    isApiFootballQuotaMessage(
      apiErrors
    )
  ) {
    throw createApiFootballQuotaError(
      apiErrors
    );
  }

  throw new Error(
    `Erreur API-Football : ${
      getApiFootballErrorText(
        apiErrors
      )
    }`
  );
}

const fixture =
  response?.data?.response?.[0];

      if (!fixture) {
        throw new Error("Match introuvable");
      }

      const status =
        fixture.fixture?.status?.short;

      const finishedStatuses = [
        "FT",
        "AET",
        "PEN",
      ];

      if (!finishedStatuses.includes(status)) {
        summary.stillPending += 1;

        summary.items.push({
          fixtureId: prediction.fixture_id,
          status,
          updated: false,
        });

        continue;
      }

      const settlement = settlePrediction(
        prediction,
        fixture
      );
        if (
  settlement.outcome ===
  "UNSUPPORTED"
) {
  summary.errors += 1;

  summary.items.push({
    fixtureId:
      prediction.fixture_id,

    market:
      settlement.market,

    updated: false,

    error:
      settlement.explanation,
  });

  continue;
}

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        await client.query(
          `
            UPDATE predictions
            SET
              result_status = 'COMPLETED',
              home_goals = $1,
              away_goals = $2,
              won = $3,
              profit = $4,
              updated_at = NOW()
            WHERE fixture_id = $5
              AND result_status = 'PENDING'
          `,
          [
            settlement.homeGoals,
            settlement.awayGoals,
            settlement.won,
            settlement.profit,
            prediction.fixture_id,
          ]
        );

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      // Cette fonction possède déjà une protection
      // contre le double traitement d'un même match.
      const elo =
        await updateEloFromFinishedFixture(
          fixture
        );

      summary.completed += 1;

     summary.items.push({
  fixtureId:
    prediction.fixture_id,

  status,

  score: {
    home:
      settlement.homeGoals,

    away:
      settlement.awayGoals,
  },

  totalGoals:
    settlement.totalGoals,

  market:
    settlement.market,

  actualOutcome:
    settlement.actualOutcome,

  settlementOutcome:
    settlement.outcome,

  betStatus:
    prediction.bet_status,

  won:
    settlement.won,

  profit:
    settlement.profit,

  explanation:
    settlement.explanation,

  settledBy:
    settlement.settledBy,

  eloProcessed:
    !elo.alreadyProcessed,

  updated: true,
});
   } catch (error) {
  if (
    isApiFootballQuotaError(
      error
    )
  ) {
    summary.quotaReached = true;
    summary.stoppedEarly = true;
    summary.stopReason =
      "API_FOOTBALL_QUOTA_REACHED";

    summary.items.push({
      fixtureId:
        prediction.fixture_id,

      updated: false,

      error:
        "Quota API-Football atteint. Synchronisation suspendue.",

      details:
        error.details ||
        error.message,
    });

    console.warn(
      [
        "⚠️ Quota API-Football atteint.",
        "Arrêt immédiat de la synchronisation.",
        "Les prédictions restent en PENDING.",
        "Elles seront reprises automatiquement lors de la prochaine exécution disponible.",
      ].join(" ")
    );

    /*
     * Très important :
     * on arrête la boucle pour éviter
     * tous les appels API suivants.
     */
    break;
  }

  summary.errors += 1;

  summary.items.push({
    fixtureId:
      prediction.fixture_id,

    updated: false,

    error:
      error.message,
  });

  console.error(
    `Erreur de règlement du match ${prediction.fixture_id} :`,
    error.message
  );
}
  }

  return summary;
}
app.get(
  "/internal/cron/update-results",
  async (req, res) => {
    const secret = req.query.secret;

if (
  !process.env.INTERNAL_CRON_SECRET ||
  secret !== process.env.INTERNAL_CRON_SECRET
) {
  return res.status(401).json({
    ok: false,
    error: "Accès refusé",
  });
}
try {
      const limit = Math.min(
        50,
        Math.max(
          1,
          Number(req.query.limit) || 20
        )
      );

      const summary =
        await updatePendingPredictions(limit);

      return res.json({
        ok: true,
        summary,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);
app.get("/public/analysis/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    const result = await pool.query(
      `
        SELECT
          fixture_id,
          fixture_date,
          league_name,
          home_team_name,
          away_team_name,
          decision,
          bet_status,
          confidence,
          risk,
          home_probability,
          draw_probability,
          away_probability,
          value_percentage,
          explanation,
          result_status
        FROM predictions
        WHERE fixture_id = $1
        LIMIT 1
      `,
      [fixtureId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Analyse indisponible",
      });
    }

    const item = result.rows[0];

    return res.json({
      ok: true,

      match: {
        fixtureId: item.fixture_id,
        date: item.fixture_date,
        league: item.league_name,
        homeTeam: item.home_team_name,
        awayTeam: item.away_team_name,
      },

      analysis: {
        decision: item.decision,
        betStatus: item.bet_status,
        probabilities: {
          home: Number(item.home_probability),
          draw: Number(item.draw_probability),
          away: Number(item.away_probability),
        },
        confidence: Number(item.confidence),
        risk: item.risk,
        value: Number(item.value_percentage),
        explanation: item.explanation,
      },

      status: item.result_status,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/public/analysis/:fixtureId", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixtureId);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "fixtureId invalide",
      });
    }

    const result = await pool.query(
      `
        SELECT
          fixture_id,
          fixture_date,
          league_name,
          home_team_name,
          away_team_name,
          decision,
          bet_status,
          confidence,
          risk,
          home_probability,
          draw_probability,
          away_probability,
          value_percentage,
          explanation,
          result_status
        FROM predictions
        WHERE fixture_id = $1
        LIMIT 1
      `,
      [fixtureId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Analyse indisponible",
      });
    }

    const item = result.rows[0];

    return res.json({
      ok: true,

      match: {
        fixtureId: item.fixture_id,
        date: item.fixture_date,
        league: item.league_name,
        homeTeam: item.home_team_name,
        awayTeam: item.away_team_name,
      },

      analysis: {
        decision: item.decision,
        betStatus: item.bet_status,

        probabilities: {
          home: Number(item.home_probability),
          draw: Number(item.draw_probability),
          away: Number(item.away_probability),
        },

        confidence: Number(item.confidence),
        risk: item.risk,
        value: Number(item.value_percentage),
        explanation: item.explanation,
      },

      status: item.result_status,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get(
  "/internal/cron/analyze-daily",
  async (req, res) => {
    const secret = req.query.secret;

    if (
      !process.env.INTERNAL_CRON_SECRET ||
      secret !== process.env.INTERNAL_CRON_SECRET
    ) {
      return res.status(401).json({
        ok: false,
        error: "Accès refusé",
      });
    }

    try {
      const requestedDate =
        req.query.date ||
        new Date().toISOString().slice(0, 10);

      const dateFormat = /^\d{4}-\d{2}-\d{2}$/;

      if (!dateFormat.test(requestedDate)) {
        return res.status(400).json({
          ok: false,
          error:
            "La date doit être au format YYYY-MM-DD",
        });
      }

      const fixturesResponse =
        await callApiFootball("/fixtures", {
          date: requestedDate,
          timezone: "Europe/Paris",
        });

      const fixtures =
        fixturesResponse.data?.response || [];

      const limit = Math.min(
        20,
        Math.max(
          1,
          Number(req.query.limit) || 10
        )
      );
const priorityLeagueIds = [
  2,   // UEFA Champions League
  3,   // UEFA Europa League
  848, // UEFA Conference League
  39,  // Premier League
  140, // La Liga
  135, // Serie A
  78,  // Bundesliga
  61,  // Ligue 1
  94,  // Primeira Liga
  88,  // Eredivisie
  203, // Süper Lig
  253, // MLS
];
     function getFixturePriorityScore(fixture) {
  const leagueId = fixture.league?.id;
  const round = String(
    fixture.league?.round || ""
  ).toLowerCase();

  let score = 0;

  // Priorité par compétition
  const leaguePriority = {
    2: 100,   // Champions League
    3: 90,    // Europa League
    848: 80,  // Conference League
    39: 75,   // Premier League
    140: 75,  // La Liga
    135: 75,  // Serie A
    78: 75,   // Bundesliga
    61: 75,   // Ligue 1
    94: 65,   // Primeira Liga
    88: 65,   // Eredivisie
    203: 60,  // Süper Lig
    253: 55,  // MLS
  };

  score += leaguePriority[leagueId] || 0;

  // Bonus selon le tour
  if (round.includes("final")) {
    score += 30;
  } else if (round.includes("semi")) {
    score += 25;
  } else if (round.includes("quarter")) {
    score += 20;
  } else if (round.includes("play-off")) {
    score += 15;
  } else if (round.includes("qualifying")) {
    score += 10;
  }

  // Bonus si les équipes sont bien identifiées
  if (
    fixture.teams?.home?.id &&
    fixture.teams?.away?.id
  ) {
    score += 5;
  }

  // Bonus si le stade est connu
  if (fixture.fixture?.venue?.name) {
    score += 2;
  }

  // Bonus si l'heure du match est disponible
  if (fixture.fixture?.date) {
    score += 2;
  }

  return score;
}

const priorityFixtures = fixtures
  .filter((fixture) =>
    priorityLeagueIds.includes(
      fixture.league?.id
    )
  )
  .map((fixture) => ({
    fixture,
    priorityScore:
      getFixturePriorityScore(fixture),
  }))
  .sort(
    (a, b) =>
      b.priorityScore - a.priorityScore
  );

const selectedFixtures =
  priorityFixtures
    .slice(0, limit)
    .map((item) => item.fixture);

      const summary = {
        date: requestedDate,
        fixturesFound: fixtures.length,
        priorityFixturesFound: priorityFixtures.length,
selected: selectedFixtures.length,
        analyzed: 0,
        failed: 0,
        items: [],
      };

      const baseUrl =
        process.env.PUBLIC_API_URL ||
        `http://127.0.0.1:${PORT}`;

      for (const fixture of selectedFixtures) {
        const fixtureId =
          fixture.fixture?.id;

        if (!fixtureId) {
          continue;
        }

        try {
          const response = await axios.get(
            `${baseUrl}/internal/analyze/${fixtureId}`,
            {
              timeout: 120000,
            }
          );

          summary.analyzed += 1;

         

const priorityItem =
  priorityFixtures.find(
    (item) =>
      item.fixture.fixture?.id === fixtureId
  );

const analysis =
  response.data?.analysis || {};

const decision =
  analysis.footballBrainDecision || {};

const market =
  analysis.market || {};
const pickScore =
  analysis.footballBrainPickScore || {};

summary.items.push({
  fixtureId,

  homeTeam:
    fixture.teams?.home?.name,

  awayTeam:
    fixture.teams?.away?.name,

  league:
    fixture.league?.name,

  round:
    fixture.league?.round,

  kickoff:
    fixture.fixture?.date,

  priorityScore:
    priorityItem?.priorityScore || 0,

  hasOdds:
    market.homeAverageOdd !== null &&
    market.homeAverageOdd !== undefined,

  confidence:
    Number(decision.confidence || 0),

  value:
    decision.value === null ||
    decision.value === undefined
      ? -999
      : Number(decision.value),
footballBrainScore:
  Number(pickScore.score || 0),

footballBrainLevel:
  pickScore.level || null,
  decision:
    decision.decision || null,

  success: true,
});
        } catch (error) {
          summary.failed += 1;

          summary.items.push({
            fixtureId,
            homeTeam:
              fixture.teams?.home?.name,
            awayTeam:
              fixture.teams?.away?.name,
            success: false,
            error:
              error.response?.data ||
              error.message,
          });
        }
      }
summary.items.sort((a, b) => {
  if (b.priorityScore !== a.priorityScore) {
    return b.priorityScore - a.priorityScore;
  }

  if (b.hasOdds !== a.hasOdds) {
    return Number(b.hasOdds) - Number(a.hasOdds);
  }
if (
  b.footballBrainScore !==
  a.footballBrainScore
) {
  return (
    b.footballBrainScore -
    a.footballBrainScore
  );
}
  if (b.confidence !== a.confidence) {
    return b.confidence - a.confidence;
  }

  if (b.value !== a.value) {
    return b.value - a.value;
  }

  return new Date(a.kickoff) - new Date(b.kickoff);
});
      return res.json({
        ok: true,
        summary,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error:
          error.response?.data ||
          error.message,
      });
    }
  }
);
function computeFootballBrainPickScore({
  decision,
  market,
  footballBrain,
}) {
  const confidence =
    Number(decision?.confidence || 0);

  const value =
    Number(decision?.value || 0);

  const phaseOne =
    footballBrain?.context?.phaseOne || {};

  const phaseTwo =
    footballBrain?.context?.phaseTwo || {};

  // 30 points maximum pour la confiance
  const confidencePoints = Math.min(
    30,
    Math.max(0, confidence * 0.3)
  );

  // 25 points maximum pour la value
  let valuePoints = 0;

  if (value >= 15) {
    valuePoints = 25;
  } else if (value >= 10) {
    valuePoints = 20;
  } else if (value >= 5) {
    valuePoints = 15;
  } else if (value >= 3) {
    valuePoints = 8;
  }

  // 15 points si les cotes sont disponibles
  const hasOdds =
    Number.isFinite(
      Number(market?.homeAverageOdd)
    ) ||
    Number.isFinite(
      Number(market?.drawAverageOdd)
    ) ||
    Number.isFinite(
      Number(market?.awayAverageOdd)
    );

  const oddsPoints = hasOdds ? 15 : 0;

  // 10 points selon l’accord avec le marché
  const marketAgreement =
    phaseOne?.marketAgreement?.agrees;

  const marketAgreementPoints =
    marketAgreement === true ? 10 : 5;

  // 10 points pour la qualité des données
  let dataQualityPoints = 0;

  if (
    phaseTwo?.fatigue?.homeRestDays !== null &&
    phaseTwo?.fatigue?.awayRestDays !== null
  ) {
    dataQualityPoints += 4;
  }

  if (
    typeof phaseTwo?.injuries?.homeCount ===
      "number" &&
    typeof phaseTwo?.injuries?.awayCount ===
      "number"
  ) {
    dataQualityPoints += 3;
  }

  if (
    phaseTwo?.lineups?.homeConfirmed &&
    phaseTwo?.lineups?.awayConfirmed
  ) {
    dataQualityPoints += 3;
  }

  // 10 points liés au statut final
  let decisionPoints = 0;

  if (decision?.betStatus === "VALUE_BET") {
    decisionPoints = 10;
  } else if (
    decision?.betStatus === "À_SURVEILLER"
  ) {
    decisionPoints = 5;
  }
const monteCarlo =
  decision?.monteCarlo || {};

let monteCarloPoints = 0;

if (monteCarlo.available) {
  if (monteCarlo.agrees === true) {
    monteCarloPoints = 10;
  } else if (monteCarlo.agrees === false) {
    monteCarloPoints = -5;
  }

  if (
    Number(monteCarlo.probability) >= 70 &&
    monteCarlo.agrees === true
  ) {
    monteCarloPoints = 15;
  }
}
  const rawScore = Math.round(
  confidencePoints +
    valuePoints +
    oddsPoints +
    marketAgreementPoints +
    dataQualityPoints +
    decisionPoints +
    monteCarloPoints
);

const score = Math.max(
  0,
  Math.min(100, rawScore)
);

  let level = "PAS DE PARI";

  if (score >= 90) {
    level = "EXCELLENT";
  } else if (score >= 80) {
    level = "TRÈS FORT";
  } else if (score >= 70) {
    level = "INTÉRESSANT";
  } else if (score >= 60) {
    level = "À SURVEILLER";
  }

  // Sécurité : aucun pari recommandé sans cotes
  if (!hasOdds) {
    level = "DONNÉES INCOMPLÈTES";
  }

  // Sécurité : une value insuffisante reste un NO BET
  if (
    decision?.betStatus === "NO_BET"
  ) {
    level = "PAS DE PARI";
  }

  return {
    score,
    level,

    breakdown: {
      confidence:
        Number(confidencePoints.toFixed(1)),
      value: valuePoints,
      odds: oddsPoints,
      marketAgreement:
        marketAgreementPoints,
      dataQuality:
        dataQualityPoints,
      decision:
        decisionPoints,
    monteCarlo: monteCarloPoints,
},

    hasOdds,
  };
}
function computePoissonModel({
  homeRecentForm,
  awayRecentForm,
  homeTeamId,
  awayTeamId,
}) {
  function computeTeamAverages(matches, teamId) {
    if (!Array.isArray(matches) || matches.length === 0) {
      return {
        goalsForAverage: 1,
        goalsAgainstAverage: 1,
      };
    }

    let goalsForTotal = 0;
    let goalsAgainstTotal = 0;
    let validMatches = 0;

    for (const match of matches) {
      const isHome =
        match.teams?.home?.id === teamId;

      const goalsFor = isHome
        ? match.goals?.home
        : match.goals?.away;

      const goalsAgainst = isHome
        ? match.goals?.away
        : match.goals?.home;

      if (
        !Number.isFinite(goalsFor) ||
        !Number.isFinite(goalsAgainst)
      ) {
        continue;
      }

      goalsForTotal += goalsFor;
      goalsAgainstTotal += goalsAgainst;
      validMatches += 1;
    }

    if (validMatches === 0) {
      return {
        goalsForAverage: 1,
        goalsAgainstAverage: 1,
      };
    }

    return {
      goalsForAverage:
        goalsForTotal / validMatches,

      goalsAgainstAverage:
        goalsAgainstTotal / validMatches,
    };
  }

  const homeAverages =
    computeTeamAverages(
      homeRecentForm,
      homeTeamId
    );

  const awayAverages =
    computeTeamAverages(
      awayRecentForm,
      awayTeamId
    );

  const expectedHomeGoals = Number(
    (
      (
        homeAverages.goalsForAverage +
        awayAverages.goalsAgainstAverage
      ) / 2
    ).toFixed(2)
  );

  const expectedAwayGoals = Number(
    (
      (
        awayAverages.goalsForAverage +
        homeAverages.goalsAgainstAverage
      ) / 2
    ).toFixed(2)
  );

  return {
    expectedGoals: {
      home: Math.max(0.05, expectedHomeGoals),
      away: Math.max(0.05, expectedAwayGoals),
      total: Number(
        (
          expectedHomeGoals +
          expectedAwayGoals
        ).toFixed(2)
      ),
    },

    source: "recent-form-goals",
    quality:
      homeRecentForm.length >= 5 &&
      awayRecentForm.length >= 5
        ? "medium"
        : "low",
  };
}
app.get("/test-fixtures", async (req, res) => {
  try {
    const response = await callApiFootball(
      "/fixtures",
      {
        date: "2026-07-19",
        timezone: "Europe/Paris",
      }
    );

    const fixtures =
      response.data?.response || [];

    res.json({
      ok: true,
      count: fixtures.length,
      fixtures: fixtures.map((item) => ({
        fixtureId: item.fixture?.id,
        date: item.fixture?.date,
        home: item.teams?.home?.name,
        away: item.teams?.away?.name,
        status: item.fixture?.status?.short,
      })),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
  }
});
app.get(
  "/internal/prediction/:fixtureId",
  async (req, res) => {
    const result = await pool.query(
      `
      SELECT *
      FROM predictions
      WHERE fixture_id = $1
      `,
      [req.params.fixtureId]
    );

    return res.json({
      ok: true,
      prediction:
        result.rows[0] || null,
    });
  }
);
app.get("/internal/db-columns", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        column_name,
        data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'predictions'
      ORDER BY ordinal_position
    `);

    return res.json({
      ok: true,
      count: result.rows.length,
      columns: result.rows,
    });
  } catch (error) {
    console.error(
      "ERREUR DB COLUMNS :",
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Erreur inconnue",
      code:
        error.code || null,
    });
  }
});
app.get("/internal/db-migrate-xg", async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS official_xg_home NUMERIC(8,3);

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS official_xg_away NUMERIC(8,3);

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS xg_source TEXT;

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS xg_confidence_score NUMERIC(5,2);

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS xg_confidence_level TEXT;

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS form_weight NUMERIC(6,4);

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS market_weight NUMERIC(6,4);

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS monte_carlo_weight NUMERIC(6,4);

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS decision_trace JSONB;

      ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS model_inputs JSONB;
    `);

    return res.json({
      ok: true,
      message:
        "Migration xG/explicabilité appliquée",
    });
  } catch (error) {
    console.error(
      "ERREUR MIGRATION XG :",
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Erreur inconnue",
      code:
        error.code || null,
    });
  }
});

function buildStoredPredictionExplainability(
  prediction
) {
  const studioPrimaryMarket =
    prediction.studio_snapshot?.primaryMarket ||
    prediction.studio_snapshot?.bestDecision ||
    null;

  const studioMarketKey =
    prediction.studio_market_key ||
    studioPrimaryMarket?.key ||
    null;

  const studioMarketLabel =
    prediction.studio_market_label ||
    studioPrimaryMarket?.label ||
    null;

  const studioProbability =
    prediction.studio_probability ??
    studioPrimaryMarket?.probability ??
    studioPrimaryMarket?.fairOdds?.calibratedProbability ??
    null;

  const studioDecisionScore =
    prediction.studio_decision_score ??
    studioPrimaryMarket?.decision?.score ??
    studioPrimaryMarket?.score ??
    null;

  const studioDecisionType =
    prediction.studio_decision_type ||
    studioPrimaryMarket?.decision?.type ||
    null;

  if (
    studioMarketLabel &&
    studioProbability !== null
  ) {
    const monteCarloMarketKeys =
      new Set([
        "OVER25",
        "UNDER25",
        "BTTS",
      ]);

    return createMarketExplainability({
      marketKey: studioMarketKey,
      marketLabel: studioMarketLabel,
      probability: studioProbability,
      decisionScore: studioDecisionScore,
      decisionGrade:
        prediction.studio_decision_grade ||
        studioPrimaryMarket?.decision?.grade ||
        null,
      decisionType: studioDecisionType,
      confidence: prediction.confidence,
      risk: prediction.risk,
      fairOdd:
        studioPrimaryMarket?.fairOdds?.fairOdds ??
        studioPrimaryMarket?.rawFairOdds ??
        prediction.fair_odd,
      marketOdd:
        studioPrimaryMarket?.fairOdds?.bookmakerOdds ??
        studioPrimaryMarket?.bookmakerOdds ??
        prediction.market_odd,
      value:
        studioPrimaryMarket?.fairOdds?.valueEdge ??
        studioPrimaryMarket?.valueEdge ??
        prediction.value_percentage,
      monteCarloAvailable:
        monteCarloMarketKeys.has(
          String(studioMarketKey || "").toUpperCase()
        ) ||
        Boolean(
          prediction.monte_carlo_model?.simulations
        ),
    });
  }

  const probabilities = {
    home:
      Number(
        prediction.home_probability
      ) || 0,

    draw:
      Number(
        prediction.draw_probability
      ) || 0,

    away:
      Number(
        prediction.away_probability
      ) || 0,
  };

  const selectedOutcome =
    String(
      prediction.selected_outcome ||
      Object.entries(probabilities)
        .sort(
          (a, b) =>
            b[1] - a[1]
        )[0]?.[0] ||
      "home"
    ).toLowerCase();

  const selectedProbability =
    probabilities[selectedOutcome] || 0;

  const sortedProbabilities =
    Object.values(probabilities)
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => b - a);

  const probabilityGap =
    sortedProbabilities.length >= 2
      ? Number(
          (
            sortedProbabilities[0] -
            sortedProbabilities[1]
          ).toFixed(2)
        )
      : 0;

  const modelInputs =
    prediction.model_inputs || {};

  const monteCarloInputs =
    modelInputs.monteCarlo ||
    modelInputs.monte_carlo ||
    {};

  const monteCarloEntries =
    Object.entries({
      home:
        Number(
          monteCarloInputs.home
        ) || 0,

      draw:
        Number(
          monteCarloInputs.draw
        ) || 0,

      away:
        Number(
          monteCarloInputs.away
        ) || 0,
    }).sort(
      (a, b) =>
        b[1] - a[1]
    );

  const monteCarloFavorite =
    monteCarloEntries[0]?.[0] ||
    null;

  const monteCarloProbability =
    monteCarloEntries[0]?.[1] ||
    null;

  const hasMonteCarlo =
    monteCarloEntries.some(
      ([, value]) =>
        Number(value) > 0
    );

  return createDecisionExplainability({
    selectedOutcome,
    selectedProbability,
    probabilities,

    weights: {
      form:
        Number(
          prediction.form_weight
        ) || 0,

      market:
        Number(
          prediction.market_weight
        ) || 0,

      monteCarlo:
        Number(
          prediction.monte_carlo_weight
        ) || 0,
    },

    modelInputs,

    monteCarlo: {
      available:
        hasMonteCarlo,

      favorite:
        monteCarloFavorite,

      probability:
        monteCarloProbability,

      agrees:
        monteCarloFavorite ===
        selectedOutcome,
    },

    confidence:
      Number(
        prediction.confidence
      ) || 0,

    risk:
      prediction.risk,

    fairOdd:
      prediction.fair_odd !== null
        ? Number(
            prediction.fair_odd
          )
        : null,

    marketOdd:
      prediction.market_odd !== null
        ? Number(
            prediction.market_odd
          )
        : null,

    value:
      prediction.value_percentage !==
      null
        ? Number(
            prediction.value_percentage
          )
        : null,

    betStatus:
      prediction.bet_status,

    probabilityGap,
  });
}

app.get(
  "/public/ai-lab/:fixtureId",
  async (req, res) => {
    try {
      const fixtureId = Number(
        req.params.fixtureId
      );

      if (
        !Number.isInteger(fixtureId) ||
        fixtureId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "fixtureId invalide",
        });
      }

      const result = await pool.query(
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

            decision,
            selected_outcome,
            bet_status,
            confidence,
            risk,

            home_probability,
            draw_probability,
            away_probability,

            fair_odd,
            market_odd,
            value_percentage,

            official_xg_home,
            official_xg_away,
            xg_source,

            xg_confidence_score,
            xg_confidence_level,

            form_weight,
            market_weight,
            monte_carlo_weight,

            decision_trace,
            model_inputs,
            monte_carlo_model,
            analysis_context,
            explanation,

            studio_market_key,
            studio_market_label,
            studio_probability,
            studio_decision_score,
            studio_decision_type,
            studio_decision_grade,
            studio_analysis_version,
            studio_snapshot,
            studio_saved_at,

            updated_at
          FROM predictions
          WHERE fixture_id = $1
          LIMIT 1
        `,
        [fixtureId]
      );

      const prediction =
        result.rows[0];

      if (!prediction) {
        return res.status(404).json({
          ok: false,
          error:
            "Analyse AI Lab introuvable",
        });
      }
if (
  isFriendlyLeagueName(
    prediction.league_name
  )
) {
  return res.status(404).json({
    ok: false,
    skipped: true,
    reason:
      "FRIENDLY_MATCH_EXCLUDED",
    error:
      "Cette analyse amicale est exclue de FootballBrain.",
  });
}
      return res.json({
        ok: true,

        fixtureId:
          prediction.fixture_id,

        match: {
          date:
            prediction.fixture_date,

          league: {
            id:
              prediction.league_id,
            name:
              prediction.league_name,
          },

          homeTeam: {
            id:
              prediction.home_team_id,
            name:
              prediction.home_team_name,
          },

          awayTeam: {
            id:
              prediction.away_team_id,
            name:
              prediction.away_team_name,
          },
        },

        prediction: {
          decision:
            prediction.decision,

          selectedOutcome:
            prediction.selected_outcome,

          betStatus:
            prediction.bet_status,

          confidence:
            Number(
              prediction.confidence
            ),

          risk:
            prediction.risk,

          probabilities: {
            home:
              Number(
                prediction.home_probability
              ),

            draw:
              Number(
                prediction.draw_probability
              ),

            away:
              Number(
                prediction.away_probability
              ),
          },

          fairOdd:
            prediction.fair_odd !== null
              ? Number(
                  prediction.fair_odd
                )
              : null,

          marketOdd:
            prediction.market_odd !== null
              ? Number(
                  prediction.market_odd
                )
              : null,

          value:
            prediction.value_percentage !==
            null
              ? Number(
                  prediction.value_percentage
                )
              : null,

          explanation:
            prediction.explanation,

          explainability:
            buildStoredPredictionExplainability(
              prediction
            ),
        },

        xg: {
          home:
            prediction.official_xg_home !==
            null
              ? Number(
                  prediction.official_xg_home
                )
              : null,

          away:
            prediction.official_xg_away !==
            null
              ? Number(
                  prediction.official_xg_away
                )
              : null,

          total:
            prediction.official_xg_home !==
              null &&
            prediction.official_xg_away !==
              null
              ? Number(
                  (
                    Number(
                      prediction
                        .official_xg_home
                    ) +
                    Number(
                      prediction
                        .official_xg_away
                    )
                  ).toFixed(3)
                )
              : null,

          source:
            prediction.xg_source,

          confidence: {
            score:
              prediction
                .xg_confidence_score !==
              null
                ? Number(
                    prediction
                      .xg_confidence_score
                  )
                : null,

            level:
              prediction
                .xg_confidence_level,
          },
        },

        weights: {
          form:
            prediction.form_weight !==
            null
              ? Number(
                  prediction.form_weight
                )
              : null,

          market:
            prediction.market_weight !==
            null
              ? Number(
                  prediction.market_weight
                )
              : null,

          monteCarlo:
            prediction
              .monte_carlo_weight !== null
              ? Number(
                  prediction
                    .monte_carlo_weight
                )
              : null,
        },

        modelInputs:
          prediction.model_inputs || {},
monteCarloModel:
  prediction.monte_carlo_model || null,
    context:
  prediction.analysis_context ||
  null,
    context:
  prediction.analysis_context ||
  {},
        decisionTrace:
          Array.isArray(
            prediction.decision_trace
          )
            ? prediction.decision_trace
            : [],

        updatedAt:
          prediction.updated_at,
      });
    } catch (error) {
      console.error(
        "ERREUR PUBLIC AI LAB :",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur inconnue",
      });
    }
  }
);
app.get(
  "/internal/db-migrate-montecarlo",
  async (req, res) => {
    try {
      await pool.query(`
        ALTER TABLE predictions
        ADD COLUMN IF NOT EXISTS
        monte_carlo_model JSONB;
      `);

      return res.json({
        ok: true,
        message:
          "Colonne monte_carlo_model créée",
      });
    } catch (error) {
      console.error(
        "ERREUR MIGRATION MONTE CARLO :",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur inconnue",
      });
    }
  }
);
app.get(
  "/public/daily-picks",
  async (req, res) => {
    try {
      const requestedDate =
        String(req.query.date || "").trim();

      const date =
        requestedDate || getParisDateString();

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Date invalide. Format attendu : YYYY-MM-DD",
        });
      }

      const fixturesResponse =
  await callApiFootball(
    "/fixtures",
    {
      date,
      timezone: "Europe/Paris",
    }
  );

const rawFixtures =
  fixturesResponse.data?.response || [];

const fixtures = rawFixtures
  .filter((item) => {
    const fixtureId =
      Number(item?.fixture?.id);

    const homeName =
      item?.teams?.home?.name;

    const awayName =
      item?.teams?.away?.name;

    return (
      Number.isInteger(fixtureId) &&
      fixtureId > 0 &&
      Boolean(homeName) &&
      Boolean(awayName) &&
      !isExcludedFixture(item)
    );
  })
  .sort((a, b) =>
    String(
      a?.fixture?.date || ""
    ).localeCompare(
      String(
        b?.fixture?.date || ""
      )
    )
  );
       
      const fixtureIds = fixtures.map(
        (item) =>
          Number(item.fixture.id)
      );

      let predictionRows = [];

      if (fixtureIds.length > 0) {
        const predictionsResult =
          await pool.query(
            `
              SELECT
                fixture_id,
                decision,
                selected_outcome,
                bet_status,
                confidence,
                risk,
                home_probability,
                draw_probability,
                away_probability,
                fair_odd,
                market_odd,
                value_percentage,
                explanation,
                official_xg_home,
                official_xg_away,
                xg_source,
                xg_confidence_score,
                xg_confidence_level,
                form_weight,
                market_weight,
                monte_carlo_weight,
                decision_trace,
                model_inputs,
                monte_carlo_model,
                updated_at
              FROM predictions
              WHERE fixture_id =
                ANY($1::bigint[])
            `,
            [fixtureIds]
          );

        predictionRows =
          predictionsResult.rows;
      }

      const predictionsByFixture =
        new Map(
          predictionRows.map(
            (prediction) => [
              Number(
                prediction.fixture_id
              ),
              prediction,
            ]
          )
        );

      const matches = fixtures.map(
        (item) => {
          const fixtureId =
            Number(item.fixture.id);

          const prediction =
            predictionsByFixture.get(
              fixtureId
            );

          return {
            fixtureId,
            fixture_id: fixtureId,

            date:
              item.fixture?.date || null,

            timestamp:
              item.fixture?.timestamp ||
              null,

            status: {
              long:
                item.fixture?.status
                  ?.long || null,
              short:
                item.fixture?.status
                  ?.short || null,
              elapsed:
                item.fixture?.status
                  ?.elapsed ?? null,
            },

            league: {
              id:
                item.league?.id || null,
              name:
                item.league?.name || null,
              country:
                item.league?.country ||
                null,
              logo:
                item.league?.logo || null,
              season:
                item.league?.season ||
                null,
              round:
                item.league?.round ||
                null,
            },

            homeTeam: {
              id:
                item.teams?.home?.id ||
                null,
              name:
                item.teams?.home?.name ||
                "Domicile",
              logo:
                item.teams?.home?.logo ||
                null,
            },

            awayTeam: {
              id:
                item.teams?.away?.id ||
                null,
              name:
                item.teams?.away?.name ||
                "Extérieur",
              logo:
                item.teams?.away?.logo ||
                null,
            },

            goals: {
              home:
                item.goals?.home ?? null,
              away:
                item.goals?.away ?? null,
            },

            analysisAvailable:
              Boolean(prediction),

            prediction: prediction
              ? {
                  decision:
                    prediction.decision,

                  selectedOutcome:
                    prediction.selected_outcome,

                  betStatus:
                    prediction.bet_status,

                  confidence:
                    Number(
                      prediction.confidence
                    ),

                  risk:
                    prediction.risk,

                  probabilities: {
                    home: Number(
                      prediction.home_probability
                    ),
                    draw: Number(
                      prediction.draw_probability
                    ),
                    away: Number(
                      prediction.away_probability
                    ),
                  },

                  fairOdd:
                    prediction.fair_odd ==
                    null
                      ? null
                      : Number(
                          prediction.fair_odd
                        ),

                  marketOdd:
                    prediction.market_odd ==
                    null
                      ? null
                      : Number(
                          prediction.market_odd
                        ),

                  value:
                    prediction.value_percentage ==
                    null
                      ? null
                      : Number(
                          prediction.value_percentage
                        ),

                  explanation:
                    prediction.explanation,
                }
              : null,

            xg: prediction
              ? {
                  home:
                    prediction.official_xg_home ==
                    null
                      ? null
                      : Number(
                          prediction.official_xg_home
                        ),

                  away:
                    prediction.official_xg_away ==
                    null
                      ? null
                      : Number(
                          prediction.official_xg_away
                        ),

                  source:
                    prediction.xg_source,

                  confidence: {
                    score:
                      prediction.xg_confidence_score ==
                      null
                        ? null
                        : Number(
                            prediction.xg_confidence_score
                          ),

                    level:
                      prediction.xg_confidence_level,
                  },
                }
              : null,

            weights: prediction
              ? {
                  form:
                    prediction.form_weight ==
                    null
                      ? null
                      : Number(
                          prediction.form_weight
                        ),

                  market:
                    prediction.market_weight ==
                    null
                      ? null
                      : Number(
                          prediction.market_weight
                        ),

                  monteCarlo:
                    prediction.monte_carlo_weight ==
                    null
                      ? null
                      : Number(
                          prediction.monte_carlo_weight
                        ),
                }
              : null,

            monteCarloModel:
              prediction?.monte_carlo_model ||
              null,

            decisionTrace:
              Array.isArray(
                prediction?.decision_trace
              )
                ? prediction.decision_trace
                : [],

            updatedAt:
              prediction?.updated_at ||
              null,
          };
        }
      );

      const analyzedMatches =
        matches.filter(
          (match) =>
            match.analysisAvailable
        );

      return res.json({
        ok: true,
        date,

        summary: {
          fixtures:
            matches.length,

          analyzed:
            analyzedMatches.length,

          pending:
            matches.length -
            analyzedMatches.length,
        },

        matches,
      });
    } catch (error) {
      console.error(
        "ERREUR /public/daily-picks :",
        error
      );

            return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur inconnue",
      });
     }
  }
);
                      function getParisDateString() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function hasCompleteMonteCarlo(model) {
  return Boolean(
    model &&
      Number(model.simulations) > 0 &&
      Array.isArray(model.topScores) &&
      model.topScores.length > 0 &&
      Number.isFinite(Number(model.btts)) &&
      Number.isFinite(Number(model.over25))
  );
}

app.get(
  "/internal/rebuild-daily-analysis",
  async (req, res) => {
    try {
      const requestedDate = String(
        req.query.date || ""
      ).trim();

      const date =
        requestedDate ||
        getParisDateString();

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Date invalide. Format attendu : YYYY-MM-DD",
        });
      }

      const requestedLimit = Number(
        req.query.limit
      );

      const limit = Math.min(
  300,
  Math.max(
    1,
    Number.isInteger(requestedLimit)
      ? requestedLimit
      : 200
  )
);

      const force =
        String(req.query.force || "") ===
        "1";

      /*
       * 1. Récupérer les fixtures du jour
       */
      const fixturesResponse =
        await callApiFootball(
          "/fixtures",
          {
            date,
            timezone: "Europe/Paris",
          }
        );

      const rawFixtures =
        fixturesResponse.data?.response ||
        [];

      const excludedStatuses = [
        "FT",
        "AET",
        "PEN",
        "CANC",
        "PST",
        "ABD",
        "AWD",
        "WO",
      ];

      const fixtures = rawFixtures
  .filter((item) => {
    const fixtureId = Number(
      item?.fixture?.id
    );

    const status = String(
      item?.fixture?.status?.short ||
        ""
    ).toUpperCase();

    return (
  Number.isInteger(fixtureId) &&
  fixtureId > 0 &&
  item?.teams?.home?.name &&
  item?.teams?.away?.name &&
  !excludedStatuses.includes(
    status
  ) &&
  !isExcludedFixture(item)
);
  });
        

      if (fixtures.length === 0) {
        return res.json({
          ok: true,
          date,
          summary: {
            fixturesFound: 0,
            alreadyComplete: 0,
            rebuilt: 0,
            failed: 0,
          },
          results: [],
        });
      }

      const fixtureIds = fixtures.map(
        (item) =>
          Number(item.fixture.id)
      );

      /*
       * 2. Lire les analyses existantes
       */
      const existingResult =
        await pool.query(
          `
            SELECT
              fixture_id,
              monte_carlo_model
            FROM predictions
            WHERE fixture_id =
              ANY($1::bigint[])
          `,
          [fixtureIds]
        );

      const existingByFixture =
        new Map(
          existingResult.rows.map(
            (row) => [
              Number(row.fixture_id),
              row.monte_carlo_model,
            ]
          )
        );

      const alreadyComplete = [];
      const fixturesToRebuild = [];

      for (const fixture of fixtures) {
        const fixtureId = Number(
          fixture.fixture.id
        );

        const storedMonteCarlo =
          existingByFixture.get(
            fixtureId
          );

        if (
          !force &&
          hasCompleteMonteCarlo(
            storedMonteCarlo
          )
        ) {
          alreadyComplete.push({
            fixtureId,
            homeTeam:
              fixture.teams.home.name,
            awayTeam:
              fixture.teams.away.name,
          });
        } else {
          fixturesToRebuild.push(
            fixture
          );
        }
      }
const selectedFixturesToRebuild =
  fixturesToRebuild.slice(0, limit);
      /*
       * 3. Relancer l’analyse complète
       */
      const baseUrl =
        `${req.protocol}://${req.get(
          "host"
        )}`;

      const results = [];

      for (
  const fixture of
    selectedFixturesToRebuild
) {
        const fixtureId = Number(
          fixture.fixture.id
        );

        const homeTeam =
          fixture.teams.home.name;

        const awayTeam =
          fixture.teams.away.name;

        try {
          const analysisUrl =
  `${baseUrl}/internal/analyze/${fixtureId}` +
  `${force ? "?refresh=1" : ""}`;

// Attendre 2 secondes entre chaque analyse
await wait(2000);

const response = await fetch(
  analysisUrl,
  {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  }
);
          const data =
            await response.json();

          if (
            !response.ok ||
            !data?.ok
          ) {
            throw new Error(
              data?.message ||
                data?.error ||
                "Analyse impossible"
            );
          }

          const monteCarloModel =
            data?.analysis
              ?.monteCarloModel ||
            null;

          const complete =
            hasCompleteMonteCarlo(
              monteCarloModel
            );

          if (!complete) {
            throw new Error(
              "L’analyse a réussi, mais le Monte Carlo complet est absent."
            );
          }

          results.push({
            fixtureId,
            homeTeam,
            awayTeam,
            ok: true,
            simulations:
              monteCarloModel
                .simulations,
            btts:
              monteCarloModel.btts,
            over25:
              monteCarloModel.over25,
            topScores:
              monteCarloModel.topScores,
          });
        } catch (error) {
          results.push({
            fixtureId,
            homeTeam,
            awayTeam,
            ok: false,
            error:
              error.message ||
              "Erreur inconnue",
          });
        }
      }

      const rebuilt =
        results.filter(
          (item) => item.ok
        );

      const failed =
        results.filter(
          (item) => !item.ok
        );

      return res.json({
        ok: true,
        date,
        force,

        summary: {
          fixturesFound:
            fixtures.length,
          alreadyComplete:
            alreadyComplete.length,
          rebuilt:
            rebuilt.length,
          failed:
            failed.length,
        },

        alreadyComplete,
        results,
      });
    } catch (error) {
      console.error(
        "ERREUR REBUILD DAILY ANALYSIS :",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur inconnue",
      });
    }
  }
);
let dailyAnalysisJobRunning = false;

async function runAutomaticDailyAnalysis() {
  if (dailyAnalysisJobRunning) {
    console.log(
      "ANALYSE QUOTIDIENNE : tâche déjà en cours"
    );
    return;
  }
let lastDailyFullAnalysisDate = null;

function getParisTimeParts() {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Europe/Paris",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }
    ).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] =
        part.value;
    }
  }

  return {
    date:
      `${values.year}-` +
      `${values.month}-` +
      `${values.day}`,

    hour:
      Number(values.hour),

    minute:
      Number(values.minute),
  };
}

  dailyAnalysisJobRunning = true;

  try {
    const url =
  `http://127.0.0.1:${PORT}` +
  `/internal/rebuild-daily-analysis` +
  `?limit=300`;

    console.log(
      "ANALYSE QUOTIDIENNE : démarrage"
    );

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    const data = await response.json();

    if (!response.ok || !data?.ok) {
      throw new Error(
        data?.error ||
          "Échec de l’analyse automatique"
      );
    }

    console.log(
      "ANALYSE QUOTIDIENNE : terminée",
      data.summary
    );
  } catch (error) {
    console.error(
      "ERREUR ANALYSE QUOTIDIENNE :",
      error.message
    );
  } finally {
    dailyAnalysisJobRunning = false;
  }
}
app.get(
  "/internal/daily-analysis-status",
  async (req, res) => {
    try {
      const requestedDate = String(
        req.query.date || ""
      ).trim();

      const date =
        requestedDate ||
        getParisDateString();

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({
          ok: false,
          error:
            "Date invalide. Format attendu : YYYY-MM-DD",
        });
      }

      const result = await pool.query(
        `
          SELECT
            fixture_id,
            home_team_name,
            away_team_name,

            official_xg_home,
            official_xg_away,

            monte_carlo_model,
            decision_trace,
            model_inputs,
            updated_at

          FROM predictions

          WHERE
            fixture_date >=
              $1::date

            AND fixture_date <
              $1::date +
              INTERVAL '1 day'

          ORDER BY fixture_date ASC
        `,
        [date]
      );

      const matches = result.rows.map(
        (row) => {
          const monteCarlo =
            row.monte_carlo_model;

          const hasXg =
            row.official_xg_home !== null &&
            row.official_xg_away !== null;

          const hasMonteCarlo =
            hasCompleteMonteCarlo(
              monteCarlo
            );

          const hasDecisionTrace =
            Array.isArray(
              row.decision_trace
            ) &&
            row.decision_trace.length > 0;

          const hasModelInputs =
            row.model_inputs &&
            typeof row.model_inputs ===
              "object" &&
            Object.keys(row.model_inputs)
              .length > 0;

          const complete =
            hasXg &&
            hasMonteCarlo &&
            hasDecisionTrace &&
            hasModelInputs;

          return {
            fixtureId:
              Number(row.fixture_id),

            homeTeam:
              row.home_team_name,

            awayTeam:
              row.away_team_name,

            complete,
            hasXg,
            hasMonteCarlo,
            hasDecisionTrace,
            hasModelInputs,

            simulations:
              Number(
                monteCarlo?.simulations
              ) || 0,

            updatedAt:
              row.updated_at,
          };
        }
      );

      const complete =
        matches.filter(
          (match) => match.complete
        );

      const incomplete =
        matches.filter(
          (match) => !match.complete
        );

      return res.json({
        ok: true,
        date,

        summary: {
          stored:
            matches.length,

          complete:
            complete.length,

          incomplete:
            incomplete.length,

          withXg:
            matches.filter(
              (match) => match.hasXg
            ).length,

          withMonteCarlo:
            matches.filter(
              (match) =>
                match.hasMonteCarlo
            ).length,

          with10000Simulations:
            matches.filter(
              (match) =>
                match.simulations ===
                10000
            ).length,
        },

        incomplete,
      });
    } catch (error) {
      console.error(
        "ERREUR DAILY ANALYSIS STATUS :",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur inconnue",
      });
    }
  }
);
app.get(
  "/internal/migrate-analysis-context",
  async (req, res) => {
    try {
      await pool.query(`
        ALTER TABLE predictions
        ADD COLUMN IF NOT EXISTS
          analysis_context JSONB;
      `);

      return res.json({
        ok: true,
        message:
          "Colonne analysis_context créée",
      });
    } catch (error) {
      console.error(
        "ERREUR MIGRATION CONTEXT :",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Erreur inconnue",
      });
    }
  }
);
app.get(
  "/internal/rebuild-daily-analyses",
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        getParisDateString();

      const limit =
        Math.max(
          1,
          Math.min(
            300,
            Number(req.query.limit) ||
              200
          )
        );

      const fixturesResponse =
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
          fixturesResponse
            .data?.response
        )
          ? fixturesResponse
              .data.response
          : [];

      const selectedFixtures =
        fixtures.slice(0, limit);

      const results = [];

      for (
        const fixture
        of selectedFixtures
      ) {
        const fixtureId =
          Number(
            fixture?.fixture?.id
          );

        if (
          !Number.isInteger(
            fixtureId
          )
        ) {
          continue;
        }

        try {
          analysisCache.delete(
            fixtureId
          );

          const baseUrl =
  process.env.PUBLIC_API_URL ||
  `http://127.0.0.1:${PORT}`;

const response = await axios.get(
  `${baseUrl}/internal/analyze/${fixtureId}?refresh=1`,
  {
    timeout: 120000,
  }
);

const analysis =
  response.data?.analysis ||
  response.data;

          results.push({
            fixtureId,
            ok: true,
            hasContext:
              Boolean(
                analysis?.context
              ),
            hasMonteCarlo:
              Number(
                analysis
                  ?.monteCarloModel
                  ?.simulations
              ) === 10000,
          });
        } catch (error) {
          results.push({
            fixtureId,
            ok: false,
            error:
              error.message ||
              "Erreur inconnue",
          });
        }
      }

      return res.json({
        ok: true,
        date,
        summary: {
          fixtures:
            selectedFixtures
              .length,

          rebuilt:
            results.filter(
              (item) =>
                item.ok
            ).length,

          failed:
            results.filter(
              (item) =>
                !item.ok
            ).length,
        },
        results,
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            "Erreur inconnue",
        });
    }
  }
);
let lineupWatcherRunning = false;

const lineupRebuiltFixtures =
  new Set();

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function runLineupWatcher() {
  if (lineupWatcherRunning) {
    console.log(
      "LINEUP WATCHER : contrôle déjà en cours"
    );

    return;
  }

  lineupWatcherRunning = true;

  try {
    const date =
      getParisDateString();

    console.log(
      `LINEUP WATCHER : contrôle du ${date}`
    );

    /*
     * On récupère les matchs du jour.
     */
    const fixturesResponse =
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
        fixturesResponse
          .data?.response
      )
        ? fixturesResponse
            .data.response
        : [];

    const now =
      Date.now();

    /*
     * On surveille uniquement les matchs :
     * - commençant dans moins de 2 heures ;
     * - ou commencés/terminés depuis moins de 3 heures.
     */
    const fixturesToCheck =
  fixtures.filter((item) => {
    if (
      isExcludedFixture(item)
    ) {
      return false;
    }

    const fixtureId =
      Number(
        item?.fixture?.id
      );

    const kickoff =
      new Date(
        item?.fixture?.date
      ).getTime();

        if (
          !Number.isInteger(
            fixtureId
          ) ||
          fixtureId <= 0 ||
          !Number.isFinite(kickoff)
        ) {
          return false;
        }

        const minutesUntilKickoff =
          (kickoff - now) /
          60000;

        return (
          minutesUntilKickoff <=
            120 &&
          minutesUntilKickoff >=
            -180
        );
      });

    const baseUrl =
      `http://127.0.0.1:${PORT}`;

    const results = [];

    for (
      const fixture
      of fixturesToCheck
    ) {
      const fixtureId =
        Number(
          fixture.fixture.id
        );

      const homeTeam =
        fixture.teams?.home
          ?.name ||
        "Domicile";

      const awayTeam =
        fixture.teams?.away
          ?.name ||
        "Extérieur";

      /*
       * Ce match a déjà été recalculé après
       * réception de ses compositions.
       */
      if (
        lineupRebuiltFixtures.has(
          fixtureId
        )
      ) {
        continue;
      }

      try {
        /*
         * Petit délai pour éviter les erreurs 429.
         */
        await wait(1200);

        const lineupResponse =
          await callApiFootball(
            "/fixtures/lineups",
            {
              fixture:
                fixtureId,
            }
          );

        const lineups =
          Array.isArray(
            lineupResponse
              .data?.response
          )
            ? lineupResponse
                .data.response
            : [];

        const homeFormation =
          lineups?.[0]
            ?.formation ||
          null;

        const awayFormation =
          lineups?.[1]
            ?.formation ||
          null;

        const lineupsAvailable =
          lineups.length >= 2 &&
          Boolean(
            homeFormation &&
            awayFormation
          );

        if (!lineupsAvailable) {
          results.push({
            fixtureId,
            homeTeam,
            awayTeam,
            status:
              "WAITING_LINEUPS",
          });

          continue;
        }

        console.log(
          "LINEUP WATCHER : compositions détectées",
          {
            fixtureId,
            homeTeam,
            awayTeam,
            homeFormation,
            awayFormation,
          }
        );

        /*
         * Recalcul complet sans utiliser le cache.
         */
        const analysisResponse =
          await fetch(
            `${baseUrl}/internal/analyze/${fixtureId}?refresh=1`,
            {
              method: "GET",
              headers: {
                Accept:
                  "application/json",
              },
            }
          );

        const analysisData =
          await analysisResponse
            .json();

        if (
          !analysisResponse.ok ||
          !analysisData?.ok
        ) {
          throw new Error(
            analysisData?.message ||
            analysisData?.error ||
            "Recalcul impossible"
          );
        }

        lineupRebuiltFixtures.add(
          fixtureId
        );

        results.push({
          fixtureId,
          homeTeam,
          awayTeam,
          status:
            "REBUILT_WITH_LINEUPS",
          homeFormation,
          awayFormation,
        });
      } catch (error) {
        const status =
          error.response?.status;

        results.push({
          fixtureId,
          homeTeam,
          awayTeam,
          status: "FAILED",
          error:
            error.message ||
            "Erreur inconnue",
        });

        /*
         * Si l’API ralentit les requêtes,
         * on attend avant le match suivant.
         */
        if (status === 429) {
          console.warn(
            "LINEUP WATCHER : limite API, pause de 60 secondes"
          );

          await wait(60000);
        }
      }
    }

    console.log(
      "LINEUP WATCHER : terminé",
      {
        checked:
          fixturesToCheck.length,

        rebuilt:
          results.filter(
            (item) =>
              item.status ===
              "REBUILT_WITH_LINEUPS"
          ).length,

        waiting:
          results.filter(
            (item) =>
              item.status ===
              "WAITING_LINEUPS"
          ).length,

        failed:
          results.filter(
            (item) =>
              item.status ===
              "FAILED"
          ).length,
      }
    );
  } catch (error) {
    console.error(
      "ERREUR LINEUP WATCHER :",
      error.message
    );
  } finally {
    lineupWatcherRunning =
      false;
  }
}
/*
 * Premier contrôle 45 secondes
 * après le démarrage du serveur.
 */
setTimeout(() => {
  runLineupWatcher();
}, 45_000);

/*
 * Nouveau contrôle toutes les 10 minutes.
 */
setInterval(() => {
  runLineupWatcher();
}, 10 * 60 * 1000);
let hourlyOddsWatcherRunning = false;

function normalizeSelectedOutcome(
  selectedOutcome = ""
) {
  const value = String(
    selectedOutcome
  )
    .trim()
    .toUpperCase();

  if (
    value === "HOME" ||
    value === "1" ||
    value === "DOMICILE"
  ) {
    return "HOME";
  }

  if (
    value === "DRAW" ||
    value === "X" ||
    value === "N" ||
    value === "NUL"
  ) {
    return "DRAW";
  }

  if (
    value === "AWAY" ||
    value === "2" ||
    value === "EXTÉRIEUR" ||
    value === "EXTERIEUR"
  ) {
    return "AWAY";
  }

  return null;
}

function getSelectedMarketOdd(
  market = {},
  selectedOutcome = ""
) {
  const normalized =
    normalizeSelectedOutcome(
      selectedOutcome
    );

  if (normalized === "HOME") {
    return Number(
      market.homeAverageOdd
    );
  }

  if (normalized === "DRAW") {
    return Number(
      market.drawAverageOdd
    );
  }

  if (normalized === "AWAY") {
    return Number(
      market.awayAverageOdd
    );
  }

  return null;
}

function getSelectedProbability(
  prediction = {}
) {
  const normalized =
    normalizeSelectedOutcome(
      prediction.selected_outcome
    );

  if (normalized === "HOME") {
    return Number(
      prediction.home_probability
    );
  }

  if (normalized === "DRAW") {
    return Number(
      prediction.draw_probability
    );
  }

  if (normalized === "AWAY") {
    return Number(
      prediction.away_probability
    );
  }

  return null;
}

async function runHourlyOddsWatcher() {
  if (hourlyOddsWatcherRunning) {
    console.log(
      "ODDS WATCHER : contrôle déjà en cours"
    );
    return;
  }

  hourlyOddsWatcherRunning = true;

  const summary = {
    checked: 0,
    updated: 0,
    rebuilt: 0,
    unavailable: 0,
    failed: 0,
  };

  try {
    const date =
      getParisDateString();

    console.log(
      `ODDS WATCHER : contrôle du ${date}`
    );

    /*
     * On sélectionne seulement les 20
     * prochains matchs déjà analysés.
     */
    const predictionsResult =
      await pool.query(
        `
          SELECT
            fixture_id,
            fixture_date,
            selected_outcome,
            home_probability,
            draw_probability,
            away_probability,
            market_odd
          FROM predictions
          WHERE
            fixture_date >= NOW()
            AND fixture_date <
              NOW() + INTERVAL '24 hours'
            AND result_status = 'PENDING'
          ORDER BY fixture_date ASC
          LIMIT 20
        `
      );

    const predictions =
      predictionsResult.rows;

    for (
      const prediction
      of predictions
    ) {
      const fixtureId =
        Number(
          prediction.fixture_id
        );

      try {
        summary.checked += 1;

        const oddsResponse =
          await callApiFootball(
            "/odds",
            {
              fixture: fixtureId,
            }
          );

        const rawOdds =
          oddsResponse.data?.response ||
          [];

        const market =
          summarizeMatchWinnerOdds(
            rawOdds
          );

        const newMarketOdd =
          getSelectedMarketOdd(
            market,
            prediction.selected_outcome
          );

        if (
          !Number.isFinite(
            newMarketOdd
          ) ||
          newMarketOdd <= 1
        ) {
          summary.unavailable += 1;
          continue;
        }

        const oldMarketOdd =
          Number(
            prediction.market_odd
          );

        const probability =
          getSelectedProbability(
            prediction
          );

        const valuePercentage =
          Number.isFinite(
            probability
          )
            ? Number(
                (
                  (
                    newMarketOdd *
                    (probability / 100)
                  ) -
                  1
                ).toFixed(4)
              ) * 100
            : null;

        /*
         * Variation relative entre
         * l’ancienne et la nouvelle cote.
         */
        const movementPercent =
          Number.isFinite(
            oldMarketOdd
          ) &&
          oldMarketOdd > 1
            ? Math.abs(
                (
                  (
                    newMarketOdd -
                    oldMarketOdd
                  ) /
                  oldMarketOdd
                ) *
                  100
              )
            : 0;

        /*
         * Mouvement d’au moins 10 % :
         * réanalyse complète du match.
         */
        if (
          movementPercent >= 10
        ) {
          console.log(
            "ODDS WATCHER : mouvement important",
            {
              fixtureId,
              oldMarketOdd,
              newMarketOdd,
              movementPercent:
                Number(
                  movementPercent.toFixed(
                    2
                  )
                ),
            }
          );

          analysisCache.delete(
            fixtureId
          );

          await processFixtureAnalysis(
            fixtureId,
            {
              forceRefresh: true,
            }
          );

          summary.rebuilt += 1;
        } else {
          /*
           * Petit mouvement :
           * simple actualisation SQL,
           * sans reconstruire les moteurs.
           */
          await pool.query(
            `
              UPDATE predictions
              SET
                market_odd = $1,
                value_percentage = $2,
                updated_at = NOW()
              WHERE fixture_id = $3
            `,
            [
              newMarketOdd,
              valuePercentage,
              fixtureId,
            ]
          );

          summary.updated += 1;
        }

        /*
         * Petite pause pour éviter
         * d’envoyer 20 appels simultanés.
         */
        await wait(750);
      } catch (error) {
        summary.failed += 1;

        console.error(
          "ODDS WATCHER : erreur",
          {
            fixtureId,
            error:
              error.message ||
              "Erreur inconnue",
          }
        );

        await wait(1500);
      }
    }

    console.log(
      "ODDS WATCHER : terminé",
      summary
    );
  } catch (error) {
    console.error(
      "ODDS WATCHER : erreur générale",
      error.message
    );
  } finally {
    hourlyOddsWatcherRunning =
      false;
  }
}
/*
 * PLANIFICATEUR DE L’ANALYSE COMPLÈTE
 *
 * Cette variable mémorise la dernière date
 * pour laquelle l’analyse quotidienne a été lancée.
 */
let lastDailyFullAnalysisDate = null;

/*
 * Retourne la date et l’heure actuelles
 * dans le fuseau horaire Europe/Paris.
 */
function getParisTimeParts() {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Europe/Paris",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }
    ).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] =
        part.value;
    }
  }

  return {
    date:
      `${values.year}-` +
      `${values.month}-` +
      `${values.day}`,

    hour:
      Number(values.hour),

    minute:
      Number(values.minute),
  };
}

/*
 * Vérifie si l’analyse complète doit être lancée.
 *
 * Elle s’exécute une seule fois par jour,
 * entre 03h00 et 03h09, heure de Paris.
 */
async function checkDailyFullAnalysisSchedule() {
  const paris =
    getParisTimeParts();

  const isScheduledWindow =
    paris.hour === 3 &&
    paris.minute < 10;

  const alreadyRunToday =
    lastDailyFullAnalysisDate ===
    paris.date;

  if (
    !isScheduledWindow ||
    alreadyRunToday
  ) {
    return;
  }

  /*
   * On mémorise immédiatement la date
   * pour empêcher deux lancements simultanés.
   */
  lastDailyFullAnalysisDate =
    paris.date;

  console.log(
    `ANALYSE COMPLÈTE PLANIFIÉE : ${paris.date}`
  );

  try {
    await runAutomaticDailyAnalysis();
  } catch (error) {
    /*
     * En cas d’échec, le prochain contrôle
     * pourra effectuer une nouvelle tentative.
     */
    lastDailyFullAnalysisDate =
      null;

    console.error(
      "ANALYSE COMPLÈTE PLANIFIÉE : erreur",
      error.message
    );
  }
}

/*
 * DÉMARRAGE DU SERVEUR
 */
/*
 * LEARNING — MATCHS TERMINÉS
 *
 * Retourne les prédictions terminées
 * enregistrées dans PostgreSQL.
 */
app.get(
  "/public/learning/finished",
  async (req, res) => {
    try {
      const requestedLimit =
        Number(req.query.limit);

      const limit =
        Number.isInteger(
          requestedLimit
        ) &&
        requestedLimit > 0
          ? Math.min(
              requestedLimit,
              1000
            )
          : 300;

      const result =
        await pool.query(
          `
            SELECT
              id,
              fixture_id,
              fixture_date,

              league_id,
              league_name,

              home_team_id,
              home_team_name,
              away_team_id,
              away_team_name,

              decision,
              selected_outcome,
              bet_status,

              confidence,
              risk,
studio_market_key,
studio_market_label,
studio_probability,
studio_decision_score,
studio_decision_type,
studio_decision_grade,
studio_analysis_version,
studio_snapshot,
studio_saved_at,
              home_probability,
              draw_probability,
              away_probability,

              fair_odd,
              market_odd,
              value_percentage,

              explanation,

              result_status,
              home_goals,
              away_goals,
              won,
              profit,

              official_xg_home,
              official_xg_away,
              xg_source,
              xg_confidence_score,
              xg_confidence_level,

              form_weight,
              market_weight,
              monte_carlo_weight,

              decision_trace,
              model_inputs,
              monte_carlo_model,
              analysis_context,

              created_at,
              updated_at
            FROM predictions
            WHERE
              result_status IS NOT NULL
              AND LOWER(result_status)
                IN (
                  'win',
                  'loss',
                  'won',
                  'lost',
                  'completed',
                  'finished'
                )
              AND home_goals IS NOT NULL
              AND away_goals IS NOT NULL
            ORDER BY
              fixture_date DESC
            LIMIT $1
          `,
          [limit]
        );

      return res.json({
        ok: true,

        count:
          result.rows.length,

        predictions:
          result.rows,
      });
    } catch (error) {
      console.error(
        "ERREUR /public/learning/finished :",
        error
      );

      return res.status(500).json({
        ok: false,
        predictions: [],
        count: 0,
        error:
          error.message ||
          "Impossible de charger les prédictions terminées.",
      });
    }
  }
);
let automaticResultSyncRunning =
  false;

async function runAutomaticResultSync() {
  if (automaticResultSyncRunning) {
    console.log(
      "RESULT SYNC : cycle déjà actif"
    );

    return {
      skipped: true,
      reason: "ALREADY_RUNNING",
    };
  }

  automaticResultSyncRunning = true;

  try {
    const summary =
      await synchronizeFinishedPredictionsByDate();

    console.log(
      "RESULT SYNC TERMINÉ :",
      {
        apiCalls:
          summary.apiCalls,

        fixturesReceived:
          summary.fixturesReceived,

        pendingPredictions:
          summary.pendingPredictions,

        completed:
          summary.completed,

        stillPending:
          summary.stillPending,

        errors:
          summary.errors,
      }
    );

    return summary;
  } catch (error) {
    console.error(
      "RESULT SYNC ERREUR :",
      error
    );

    return {
      apiCalls: 0,
      completed: 0,
      errors: 1,
      error:
        error?.message ||
        "Erreur inconnue",
    };
  } finally {
    automaticResultSyncRunning =
      false;
  }
}
          async function ensureStudioPredictionColumns() {
  await pool.query(`
    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_market_key TEXT;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_market_label TEXT;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_probability NUMERIC(6,2);

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_decision_score NUMERIC(6,2);

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_decision_type TEXT;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_decision_grade TEXT;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_analysis_version TEXT;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_snapshot JSONB;

    ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS
      studio_saved_at TIMESTAMPTZ;
  `);

  console.log(
    "✅ Colonnes Brain Studio vérifiées"
  );
}
          function clampStudioNumber(
  value,
  min = 0,
  max = 100
) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.max(
    min,
    Math.min(max, number)
  );
}

function normalizeStudioMarketKey(
  value
) {
  const normalized = String(
    value || ""
  )
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/\./g, "");

  const aliases = {
    HOME: "HOME",
    HOME_WIN: "HOME",
    "1": "HOME",

    DRAW: "DRAW",
    X: "DRAW",

    AWAY: "AWAY",
    AWAY_WIN: "AWAY",
    "2": "AWAY",

    OVER25: "OVER25",
    OVER_25: "OVER25",
    OVER_2_5: "OVER25",

    UNDER25: "UNDER25",
    UNDER_25: "UNDER25",
    UNDER_2_5: "UNDER25",

    BTTS: "BTTS",
    BTTS_YES: "BTTS",

    NO_BTTS: "NO_BTTS",
    BTTS_NO: "NO_BTTS",
  };

  return aliases[normalized] ||
    normalized ||
    null;
}

function normalizeStudioDecisionType(
  value
) {
  const normalized = String(
    value || "NO_BET"
  ).toUpperCase();

  if (
    normalized === "BET" ||
    normalized === "VALUE_BET"
  ) {
    return normalized;
  }

  return "NO_BET";
}
async function saveStudioSnapshot({
  fixtureId,
  marketKey,
  marketLabel,
  probability,
  decisionScore,
  decisionType,
  decisionGrade,
  analysisVersion,
  snapshot,
}) {
  const normalizedFixtureId =
    Number(fixtureId);

  if (
    !Number.isInteger(
      normalizedFixtureId
    ) ||
    normalizedFixtureId <= 0
  ) {
    throw new Error(
      "fixtureId invalide"
    );
  }

  const normalizedMarketKey =
    normalizeStudioMarketKey(
      marketKey
    );

  if (!normalizedMarketKey) {
    throw new Error(
      "Marché Brain Studio invalide"
    );
  }

  const normalizedProbability =
    clampStudioNumber(
      probability
    );

  const normalizedDecisionScore =
    clampStudioNumber(
      decisionScore
    );

  const normalizedDecisionType =
    normalizeStudioDecisionType(
      decisionType
    );

  const result = await pool.query(
    `
      UPDATE predictions
      SET
        studio_market_key = $1,
        studio_market_label = $2,
        studio_probability = $3,
        studio_decision_score = $4,
        studio_decision_type = $5,
        studio_decision_grade = $6,
        studio_analysis_version = $7,
        studio_snapshot = $8::jsonb,
        studio_saved_at = NOW(),
        updated_at = NOW()
      WHERE fixture_id = $9
      RETURNING
        fixture_id,
        studio_market_key,
        studio_market_label,
        studio_probability,
        studio_decision_score,
        studio_decision_type,
        studio_decision_grade,
        studio_analysis_version,
        studio_saved_at
    `,
    [
      normalizedMarketKey,

      String(
        marketLabel ||
          normalizedMarketKey
      ),

      normalizedProbability,

      normalizedDecisionScore,

      normalizedDecisionType,

      decisionGrade
        ? String(
            decisionGrade
          ).toUpperCase()
        : null,

      String(
        analysisVersion ||
          "brain-studio-v1"
      ),

      JSON.stringify(
        snapshot || {}
      ),

      normalizedFixtureId,
    ]
  );

  if (
    result.rows.length === 0
  ) {
    throw new Error(
      "Prédiction Railway introuvable"
    );
  }

  return result.rows[0];
}
app.post(
  "/public/studio-snapshot/:fixtureId",
  async (req, res) => {
    try {
      const fixtureId = Number(
        req.params.fixtureId
      );

      if (
        !Number.isInteger(fixtureId) ||
        fixtureId <= 0
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "fixtureId invalide",
          });
      }

      const body =
        req.body || {};

      const primaryMarket =
        body.primaryMarket ||
        body.bestDecision ||
        null;

      if (!primaryMarket) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "primaryMarket manquant",
          });
      }

      /*
       * Vérifier la date du match avant
       * d'autoriser la modification du snapshot.
       */
      const predictionResult =
        await pool.query(
          `
            SELECT
              fixture_id,
              fixture_date,
              result_status,
              studio_market_key,
              studio_market_label,
              studio_saved_at
            FROM predictions
            WHERE fixture_id = $1
            LIMIT 1
          `,
          [fixtureId]
        );

      const prediction =
        predictionResult.rows[0];

      if (!prediction) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Prédiction Railway introuvable",
          });
      }

      const fixtureDate =
        prediction.fixture_date
          ? new Date(
              prediction.fixture_date
            )
          : null;

      if (
        fixtureDate &&
        Number.isNaN(
          fixtureDate.getTime()
        )
      ) {
        return res
          .status(500)
          .json({
            ok: false,
            error:
              "Date du match invalide dans la base de données",
          });
      }

      /*
       * Dès que le coup d'envoi est atteint,
       * le dernier snapshot Brain Studio
       * enregistré est définitivement verrouillé.
       */
      if (
        fixtureDate &&
        fixtureDate.getTime() <=
          Date.now()
      ) {
        return res
          .status(409)
          .json({
            ok: false,
            locked: true,
            fixtureId,
            kickoff:
              fixtureDate.toISOString(),
            studioMarketKey:
              prediction
                .studio_market_key ||
              null,
            studioMarketLabel:
              prediction
                .studio_market_label ||
              null,
            studioSavedAt:
              prediction
                .studio_saved_at ||
              null,
            error:
              "Le pronostic Brain Studio est verrouillé depuis le coup d’envoi.",
          });
      }

      /*
       * Avant le coup d'envoi, le nouveau
       * marché Brain Studio remplace l'ancien.
       */
      const saved =
        await saveStudioSnapshot({
          fixtureId,

          marketKey:
            primaryMarket.key,

          marketLabel:
            primaryMarket.label,

          probability:
            primaryMarket
              ?.fairOdds
              ?.calibratedProbability ??
            primaryMarket
              ?.probability,

          decisionScore:
            primaryMarket
              ?.decision
              ?.score ??
            primaryMarket
              ?.score,

          decisionType:
            primaryMarket
              ?.decision
              ?.type,

          decisionGrade:
            primaryMarket
              ?.decision
              ?.grade,

          analysisVersion:
            body.analysisVersion ||
            body.version ||
            "brain-studio-v1",

          snapshot: {
            primaryMarket,

            generatedAt:
              new Date()
                .toISOString(),

            fixtureDate:
              fixtureDate
                ? fixtureDate
                    .toISOString()
                : null,

            locked:
              false,
          },
        });

      return res.json({
        ok: true,
        locked: false,
        replaced:
          Boolean(
            prediction
              .studio_market_key
          ),
        previousSnapshot: {
          marketKey:
            prediction
              .studio_market_key ||
            null,

          marketLabel:
            prediction
              .studio_market_label ||
            null,

          savedAt:
            prediction
              .studio_saved_at ||
            null,
        },
        prediction:
          saved,
      });
    } catch (error) {
      console.error(
        "ERREUR STUDIO SNAPSHOT :",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ||
            "Erreur inconnue",
        });
    }
  }
);
app.get(
  "/public/studio-snapshot/:fixtureId",
  async (req, res) => {
    try {
      const fixtureId = Number(
        req.params.fixtureId
      );

      if (
        !Number.isInteger(fixtureId) ||
        fixtureId <= 0
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "fixtureId invalide",
          });
      }

      const result =
        await pool.query(
          `
            SELECT
              fixture_id,
              fixture_date,
              home_team_name,
              away_team_name,
              result_status,

              studio_market_key,
              studio_market_label,
              studio_probability,
              studio_decision_score,
              studio_decision_type,
              studio_decision_grade,
              studio_analysis_version,
              studio_snapshot,
              studio_saved_at,

              updated_at
            FROM predictions
            WHERE fixture_id = $1
            LIMIT 1
          `,
          [fixtureId]
        );

      const prediction =
        result.rows[0];

      if (!prediction) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Prédiction Railway introuvable",
          });
      }

      const fixtureDate =
        prediction.fixture_date
          ? new Date(
              prediction.fixture_date
            )
          : null;

      const fixtureDateIsValid =
        fixtureDate &&
        !Number.isNaN(
          fixtureDate.getTime()
        );

      const locked =
        fixtureDateIsValid
          ? fixtureDate.getTime() <=
            Date.now()
          : false;

      const hasStudioSnapshot =
        Boolean(
          prediction
            .studio_market_key ||
          prediction
            .studio_market_label ||
          prediction
            .studio_snapshot
        );

      return res.json({
        ok: true,

        fixtureId:
          prediction.fixture_id,

        match: {
          homeTeam:
            prediction
              .home_team_name ||
            null,

          awayTeam:
            prediction
              .away_team_name ||
            null,

          kickoff:
            fixtureDateIsValid
              ? fixtureDate
                  .toISOString()
              : null,

          resultStatus:
            prediction
              .result_status ||
            null,
        },

        studio: {
          available:
            hasStudioSnapshot,

          locked,

          marketKey:
            prediction
              .studio_market_key ||
            null,

          marketLabel:
            prediction
              .studio_market_label ||
            null,

          probability:
            prediction
              .studio_probability != null
              ? Number(
                  prediction
                    .studio_probability
                )
              : null,

          decisionScore:
            prediction
              .studio_decision_score !=
            null
              ? Number(
                  prediction
                    .studio_decision_score
                )
              : null,

          decisionType:
            prediction
              .studio_decision_type ||
            null,

          decisionGrade:
            prediction
              .studio_decision_grade ||
            null,

          analysisVersion:
            prediction
              .studio_analysis_version ||
            null,

          savedAt:
            prediction
              .studio_saved_at ||
            null,

          snapshot:
            prediction
              .studio_snapshot ||
            null,
        },

        updatedAt:
          prediction.updated_at ||
          null,
      });
    } catch (error) {
      console.error(
        "ERREUR LECTURE STUDIO SNAPSHOT :",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ||
            "Erreur inconnue",
        });
    }
  }
);
/*
 * ============================================================
 * BRAIN STUDIO — GÉNÉRATION AUTOMATIQUE CÔTÉ RAILWAY
 * ============================================================
 */

let automaticStudioRebuildRunning = false;

function studioNumber(
  value,
  fallback = 0
) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function studioClamp(
  value,
  minimum = 0,
  maximum = 100
) {
  return Math.max(
    minimum,
    Math.min(
      maximum,
      studioNumber(value)
    )
  );
}

function studioProbabilityToOdd(
  probability
) {
  const normalizedProbability =
    studioNumber(probability);

  if (normalizedProbability <= 0) {
    return null;
  }

  return Number(
    (
      100 /
      normalizedProbability
    ).toFixed(2)
  );
}

function studioRiskToScore(risk) {
  const normalizedRisk =
    String(risk || "")
      .trim()
      .toLowerCase();

  if (
    normalizedRisk.includes("faible")
  ) {
    return 30;
  }

  if (
    normalizedRisk.includes("mod")
  ) {
    return 50;
  }

  if (
    normalizedRisk.includes("élev") ||
    normalizedRisk.includes("elev")
  ) {
    return 75;
  }

  return 60;
}

function getStudioDecisionGrade(
  score
) {
  const normalizedScore =
    studioNumber(score);

  if (normalizedScore >= 75) {
    return "A";
  }

  if (normalizedScore >= 60) {
    return "B";
  }

  if (normalizedScore >= 45) {
    return "C";
  }

  return "D";
}

function getStudioDecisionStars(
  score
) {
  const normalizedScore =
    studioNumber(score);

  if (normalizedScore >= 75) {
    return 4;
  }

  if (normalizedScore >= 60) {
    return 3;
  }

  if (normalizedScore >= 45) {
    return 2;
  }

  return 1;
}

function normalizeAutomaticStudioOutcome(
  prediction = {}
) {
  const explicitOutcome =
    prediction.selected_outcome ||
    prediction.selectedOutcome ||
    null;

  if (explicitOutcome) {
    return String(explicitOutcome)
      .trim()
      .toLowerCase();
  }

  const probabilities = {
    home:
      studioNumber(
        prediction.home_probability
      ),

    draw:
      studioNumber(
        prediction.draw_probability
      ),

    away:
      studioNumber(
        prediction.away_probability
      ),
  };

  return (
    Object.entries(probabilities)
      .sort(
        (a, b) =>
          b[1] - a[1]
      )[0]?.[0] ||
    null
  );
}

function buildAutomaticStudioMarket({
  key,
  label,
  family,
  probability,
  selectedOutcome,
  prediction,
  monteCarloModel,
}) {
  const normalizedProbability =
    studioClamp(probability);

  const confidence =
    studioClamp(
      prediction.confidence
    );

  const riskScore =
    studioRiskToScore(
      prediction.risk
    );

  const normalizedBetStatus =
    String(
      prediction.bet_status ||
      prediction.betStatus ||
      "NO_BET"
    )
      .trim()
      .toUpperCase();

  const normalizedKey =
    String(key || "")
      .trim()
      .toLowerCase();

  const isSelectedOutcome =
    normalizedKey ===
    String(
      selectedOutcome || ""
    )
      .trim()
      .toLowerCase();

  const isRecommended =
    isSelectedOutcome &&
    (
      normalizedBetStatus ===
        "BET" ||
      normalizedBetStatus ===
        "VALUE_BET"
    );

  const decisionScore =
    Math.round(
      studioClamp(
        normalizedProbability * 0.55 +
        confidence * 0.35 +
        (100 - riskScore) * 0.1
      )
    );

  const fairOdd =
    studioProbabilityToOdd(
      normalizedProbability
    );

  const marketOdd =
    isSelectedOutcome
      ? prediction.market_odd ??
        prediction.marketOdd ??
        null
      : null;

  const value =
    isSelectedOutcome
      ? prediction.value_percentage ??
        prediction.value ??
        null
      : null;

  const decisionType =
    isRecommended
      ? normalizedBetStatus
      : "NO_BET";

  const decisionGrade =
    getStudioDecisionGrade(
      decisionScore
    );

  return {
    key,
    label,
    family,

    probability:
      normalizedProbability,

    score:
      decisionScore,

    rawProbability:
      normalizedProbability,

    calibratedProbability:
      normalizedProbability,

    rawFairOdds:
      fairOdd,

    bookmakerOdds:
      marketOdd,

    valueEdge:
      value,

    expectedValue:
      value,

    expectedValuePercent:
      value,

    isValueBet:
      decisionType ===
      "VALUE_BET",

    oddsAvailable:
      marketOdd != null,

    fairOdds: {
      rawProbability:
        normalizedProbability,

      calibratedProbability:
        normalizedProbability,

      rawFairOdds:
        fairOdd,

      fairOdds:
        fairOdd,

      bookmakerOdds:
        marketOdd,

      valueEdge:
        value,

      expectedValue:
        value,

      expectedValuePercent:
        value,

      isValueBet:
        decisionType ===
        "VALUE_BET",

      oddsAvailable:
        marketOdd != null,

      quality: {
        label:
          normalizedProbability > 0
            ? "Calcul Railway"
            : "Indisponible",

        grade:
          normalizedProbability >= 60
            ? "A"
            : normalizedProbability >= 45
            ? "B"
            : normalizedProbability >= 30
            ? "C"
            : "D",

        stars:
          normalizedProbability >= 60
            ? 4
            : normalizedProbability >= 45
            ? 3
            : normalizedProbability >= 30
            ? 2
            : 1,
      },
    },

    decision: {
      score:
        decisionScore,

      grade:
        decisionGrade,

      stars:
        getStudioDecisionStars(
          decisionScore
        ),

      type:
        decisionType,

      label:
        isRecommended
          ? prediction.decision ||
            label
          : "Aucun pari recommandé",

      shortLabel:
        isRecommended
          ? "Recommandé"
          : "À éviter",

      recommendationStrength:
        isRecommended
          ? "strong"
          : "none",

      eligibleForPrudentTicket:
        isRecommended &&
        confidence >= 70 &&
        riskScore <= 50,

      eligibleForFunTicket:
        isRecommended,

      reasons:
        Array.isArray(
          prediction.decision_trace
        )
          ? prediction.decision_trace
          : [],

      warnings:
        decisionType === "NO_BET"
          ? [
              "Décision finale : NO_BET",
            ]
          : [],

      marketConsensus: {
        score:
          confidence,

        alignedVotes:
          isRecommended ? 3 : 1,

        totalVotes: 4,

        votes: [
          {
            engine:
              "Railway Probability",

            aligned:
              isSelectedOutcome,

            strength:
              normalizedProbability,

            reason:
              `Probabilité estimée : ${normalizedProbability}%`,
          },

          {
            engine:
              "Monte Carlo",

            aligned:
              Boolean(
                monteCarloModel
                  ?.simulations
              ),

            strength:
              monteCarloModel
                ?.simulations
                ? 100
                : 0,

            reason:
              monteCarloModel
                ?.simulations
                ? `${monteCarloModel.simulations} simulations`
                : "Monte Carlo indisponible",
          },

          {
            engine:
              "Risk Engine",

            aligned:
              riskScore <= 50,

            strength:
              100 - riskScore,

            reason:
              `Risque : ${
                prediction.risk ||
                "inconnu"
              }`,
          },
        ],
      },
    },

    evaluation: {
      evaluated: false,
      result: "pending",
      won: null,
    },
  };
}

function buildAutomaticStudioSnapshot(
  prediction
) {
  const monteCarloModel =
    prediction.monte_carlo_model &&
    typeof prediction
      .monte_carlo_model ===
      "object"
      ? prediction
          .monte_carlo_model
      : {};

  const selectedOutcome =
    normalizeAutomaticStudioOutcome(
      prediction
    );

  const homeName =
    prediction.home_team_name ||
    "Domicile";

  const awayName =
    prediction.away_team_name ||
    "Extérieur";

  const markets = [
    buildAutomaticStudioMarket({
      key: "HOME",

      label:
        `Victoire ${homeName}`,

      family: "1x2",

      probability:
        prediction.home_probability,

      selectedOutcome,
      prediction,
      monteCarloModel,
    }),

    buildAutomaticStudioMarket({
      key: "DRAW",
      label: "Match nul",
      family: "1x2",

      probability:
        prediction.draw_probability,

      selectedOutcome,
      prediction,
      monteCarloModel,
    }),

    buildAutomaticStudioMarket({
      key: "AWAY",

      label:
        `Victoire ${awayName}`,

      family: "1x2",

      probability:
        prediction.away_probability,

      selectedOutcome,
      prediction,
      monteCarloModel,
    }),
  ];

  const bttsProbability =
    Number(
      monteCarloModel.btts
    );

  if (
    Number.isFinite(
      bttsProbability
    )
  ) {
    markets.push(
      buildAutomaticStudioMarket({
        key: "BTTS",

        label:
          "Les deux équipes marquent",

        family: "goals",

        probability:
          bttsProbability,

        selectedOutcome,
        prediction,
        monteCarloModel,
      })
    );
  }

  const over25Probability =
    Number(
      monteCarloModel.over25
    );

  if (
    Number.isFinite(
      over25Probability
    )
  ) {
    markets.push(
      buildAutomaticStudioMarket({
        key: "OVER25",

        label:
          "Plus de 2.5 buts",

        family: "goals",

        probability:
          over25Probability,

        selectedOutcome,
        prediction,
        monteCarloModel,
      }),

      buildAutomaticStudioMarket({
        key: "UNDER25",

        label:
          "Moins de 2.5 buts",

        family: "goals",

        probability:
          Math.max(
            0,
            100 -
              over25Probability
          ),

        selectedOutcome,
        prediction,
        monteCarloModel,
      })
    );
  }

  const sortedMarkets =
    [...markets].sort(
      (a, b) => {
        const scoreDifference =
          studioNumber(
            b?.decision?.score
          ) -
          studioNumber(
            a?.decision?.score
          );

        if (
          scoreDifference !== 0
        ) {
          return scoreDifference;
        }

        return (
          studioNumber(
            b?.fairOdds
              ?.calibratedProbability
          ) -
          studioNumber(
            a?.fairOdds
              ?.calibratedProbability
          )
        );
      }
    );

  const primaryMarket =
    sortedMarkets[0] ||
    null;

  return {
    version:
      "brain-studio-railway-v1",

    generatedAt:
      new Date().toISOString(),

    fixtureId:
      prediction.fixture_id,

    match: {
      fixtureId:
        prediction.fixture_id,

      date:
        prediction.fixture_date,

      league:
        prediction.league_name,

      homeTeam:
        homeName,

      awayTeam:
        awayName,
    },

    selectedOutcome,

    primaryMarket,

    bestDecision:
      primaryMarket,

    markets:
      sortedMarkets,

    context:
      prediction.analysis_context ||
      null,

    modelInputs:
      prediction.model_inputs ||
      null,

    monteCarloModel,

    decisionTrace:
      Array.isArray(
        prediction.decision_trace
      )
        ? prediction.decision_trace
        : [],
  };
}

async function rebuildAutomaticStudioSnapshot(
  fixtureId
) {
  const normalizedFixtureId =
    Number(fixtureId);

  if (
    !Number.isInteger(
      normalizedFixtureId
    ) ||
    normalizedFixtureId <= 0
  ) {
    throw new Error(
      "fixtureId invalide"
    );
  }

  /*
   * Recharge l’analyse générale avant
   * de fabriquer Brain Studio.
   */
  const baseUrl =
    `http://127.0.0.1:${PORT}`;

  const analysisResponse =
    await fetch(
      `${baseUrl}/internal/analyze/${normalizedFixtureId}?refresh=1`,
      {
        method: "GET",

        headers: {
          Accept:
            "application/json",
        },
      }
    );

  const analysisData =
    await analysisResponse.json();

  if (
    !analysisResponse.ok ||
    !analysisData?.ok
  ) {
    throw new Error(
      analysisData?.error ||
      "Impossible de rafraîchir l’analyse Railway"
    );
  }

  const predictionResult =
    await pool.query(
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

          decision,
          selected_outcome,
          bet_status,

          confidence,
          risk,

          home_probability,
          draw_probability,
          away_probability,

          fair_odd,
          market_odd,
          value_percentage,

          decision_trace,
          model_inputs,
          monte_carlo_model,
          analysis_context,

          result_status,

          studio_saved_at,
          created_at,
          updated_at
        FROM predictions
        WHERE fixture_id = $1
        LIMIT 1
      `,
      [
        normalizedFixtureId,
      ]
    );

  const prediction =
    predictionResult.rows[0];

  if (!prediction) {
    throw new Error(
      "Prédiction Railway introuvable"
    );
  }

  const kickoff =
    prediction.fixture_date
      ? new Date(
          prediction.fixture_date
        )
      : null;

  if (
    kickoff &&
    !Number.isNaN(
      kickoff.getTime()
    ) &&
    kickoff.getTime() <=
      Date.now()
  ) {
    return {
      fixtureId:
        normalizedFixtureId,

      locked: true,
      saved: false,

      reason:
        "MATCH_STARTED",
    };
  }

  const studioSnapshot =
    buildAutomaticStudioSnapshot(
      prediction
    );

  const primaryMarket =
    studioSnapshot.primaryMarket;

  if (!primaryMarket) {
    throw new Error(
      "Aucun marché Brain Studio disponible"
    );
  }

  const saved =
    await saveStudioSnapshot({
      fixtureId:
        normalizedFixtureId,

      marketKey:
        primaryMarket.key,

      marketLabel:
        primaryMarket.label,

      probability:
        primaryMarket
          ?.fairOdds
          ?.calibratedProbability ??
        primaryMarket.probability,

      decisionScore:
        primaryMarket
          ?.decision
          ?.score ??
        primaryMarket.score,

      decisionType:
        primaryMarket
          ?.decision
          ?.type,

      decisionGrade:
        primaryMarket
          ?.decision
          ?.grade,

      analysisVersion:
        studioSnapshot.version,

      snapshot:
        studioSnapshot,
    });

  return {
    fixtureId:
      normalizedFixtureId,

    locked: false,
    saved: true,

    primaryMarket,

    prediction:
      saved,
  };
}

/*
 * Route manuelle de test.
 *
 * Exemple :
 * /internal/rebuild-studio-snapshot/123456
 */
app.get(
  "/internal/rebuild-studio-snapshot/:fixtureId",
  async (req, res) => {
    if (
      automaticStudioRebuildRunning
    ) {
      return res
        .status(409)
        .json({
          ok: false,
          error:
            "Une reconstruction Brain Studio est déjà en cours",
        });
    }

    automaticStudioRebuildRunning =
      true;

    try {
      const result =
        await rebuildAutomaticStudioSnapshot(
          req.params.fixtureId
        );

      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      console.error(
        "ERREUR REBUILD BRAIN STUDIO :",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ||
            "Erreur inconnue",
        });
    } finally {
      automaticStudioRebuildRunning =
        false;
    }
  }
);
/*
 * ============================================================
 * BRAIN STUDIO — SCHEDULER INTELLIGENT
 * ============================================================
 *
 * Fonctionnement :
 *
 * - vérification toutes les 15 minutes ;
 * - sélection des matchs qui débutent dans moins de 3 heures ;
 * - exclusion des matchs déjà commencés ou terminés ;
 * - exclusion des snapshots actualisés trop récemment ;
 * - recalcul un match après l’autre ;
 * - pause entre les matchs pour protéger API-Football ;
 * - verrouillage naturel au coup d’envoi.
 */

const STUDIO_SCHEDULER_INTERVAL_MS =
  15 * 60 * 1000;

const STUDIO_SCHEDULER_FIRST_RUN_DELAY_MS =
  3 * 60 * 1000;

const STUDIO_SCHEDULER_LOOKAHEAD_HOURS =
  3;

const STUDIO_SCHEDULER_REFRESH_MINUTES =
  12;

const STUDIO_SCHEDULER_MAX_MATCHES =
  20;

const STUDIO_SCHEDULER_DELAY_BETWEEN_MATCHES_MS =
  2500;

let studioSchedulerRunning =
  false;

let studioSchedulerLastStartedAt =
  null;

let studioSchedulerLastFinishedAt =
  null;

let studioSchedulerLastSummary =
  null;

function waitStudioScheduler(
  milliseconds
) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        milliseconds
      )
  );
}

function normalizeSchedulerStatus(
  value
) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function isFinishedSchedulerStatus(
  status
) {
  const normalized =
    normalizeSchedulerStatus(
      status
    );

  return new Set([
    "FT",
    "AET",
    "PEN",
    "FINISHED",
    "COMPLETED",
    "CANCELLED",
    "CANCELED",
    "PST",
    "POSTPONED",
    "ABD",
    "ABANDONED",
    "AWD",
    "WO",
  ]).has(normalized);
}

async function getUpcomingStudioFixtures({
  lookaheadHours =
    STUDIO_SCHEDULER_LOOKAHEAD_HOURS,

  refreshMinutes =
    STUDIO_SCHEDULER_REFRESH_MINUTES,

  limit =
    STUDIO_SCHEDULER_MAX_MATCHES,
} = {}) {
  const normalizedLookahead =
    Math.max(
      1,
      Math.min(
        24,
        Number(lookaheadHours) ||
          STUDIO_SCHEDULER_LOOKAHEAD_HOURS
      )
    );

  const normalizedRefreshMinutes =
    Math.max(
      5,
      Math.min(
        180,
        Number(refreshMinutes) ||
          STUDIO_SCHEDULER_REFRESH_MINUTES
      )
    );

  const normalizedLimit =
    Math.max(
      1,
      Math.min(
        100,
        Number(limit) ||
          STUDIO_SCHEDULER_MAX_MATCHES
      )
    );

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

          result_status,

          studio_market_key,
          studio_market_label,
          studio_probability,
          studio_decision_score,
          studio_decision_type,
          studio_decision_grade,
          studio_analysis_version,
          studio_saved_at,

          created_at,
          updated_at

        FROM predictions

        WHERE
          fixture_date IS NOT NULL

          /*
           * Match pas encore commencé.
           */
          AND fixture_date > NOW()

          /*
           * Match dans les prochaines heures.
           */
          AND fixture_date <=
            NOW() +
            ($1 * INTERVAL '1 hour')

          /*
           * Ne pas recalculer les matchs
           * explicitement terminés ou annulés.
           */
          AND (
            result_status IS NULL
            OR UPPER(
              result_status
            ) NOT IN (
              'FT',
              'AET',
              'PEN',
              'FINISHED',
              'COMPLETED',
              'CANCELLED',
              'CANCELED',
              'PST',
              'POSTPONED',
              'ABD',
              'ABANDONED',
              'AWD',
              'WO'
            )
          )

          /*
           * Premier snapshot ou snapshot
           * suffisamment ancien.
           */
          AND (
            studio_saved_at IS NULL
            OR studio_saved_at <=
              NOW() -
              ($2 * INTERVAL '1 minute')
          )

        ORDER BY
          fixture_date ASC

        LIMIT $3
      `,
      [
        normalizedLookahead,
        normalizedRefreshMinutes,
        normalizedLimit,
      ]
    );

  return result.rows;
}

async function runAutomaticStudioScheduler({
  source = "scheduler",

  force = false,

  lookaheadHours =
    STUDIO_SCHEDULER_LOOKAHEAD_HOURS,

  refreshMinutes =
    STUDIO_SCHEDULER_REFRESH_MINUTES,

  limit =
    STUDIO_SCHEDULER_MAX_MATCHES,
} = {}) {
  if (studioSchedulerRunning) {
    console.log(
      "BRAIN STUDIO SCHEDULER : cycle déjà actif"
    );

    return {
      ok: true,
      skipped: true,
      reason:
        "ALREADY_RUNNING",
      source,
    };
  }

  studioSchedulerRunning =
    true;

  studioSchedulerLastStartedAt =
    new Date().toISOString();

  const summary = {
    ok: true,
    source,

    startedAt:
      studioSchedulerLastStartedAt,

    finishedAt: null,

    lookaheadHours:
      Number(lookaheadHours),

    refreshMinutes:
      Number(refreshMinutes),

    force:
      Boolean(force),

    fixturesFound: 0,
    attempted: 0,
    saved: 0,
    locked: 0,
    skipped: 0,
    failed: 0,

    results: [],
  };

  try {
    let fixtures = [];

    if (force) {
      /*
       * En mode force, on ignore la date
       * du dernier snapshot, mais jamais
       * le coup d’envoi.
       */
      const forcedResult =
        await pool.query(
          `
            SELECT
              fixture_id,
              fixture_date,

              league_id,
              league_name,

              home_team_name,
              away_team_name,

              result_status,

              studio_saved_at,

              created_at,
              updated_at

            FROM predictions

            WHERE
              fixture_date IS NOT NULL

              AND fixture_date > NOW()

              AND fixture_date <=
                NOW() +
                ($1 * INTERVAL '1 hour')

              AND (
                result_status IS NULL
                OR UPPER(
                  result_status
                ) NOT IN (
                  'FT',
                  'AET',
                  'PEN',
                  'FINISHED',
                  'COMPLETED',
                  'CANCELLED',
                  'CANCELED',
                  'PST',
                  'POSTPONED',
                  'ABD',
                  'ABANDONED',
                  'AWD',
                  'WO'
                )
              )

            ORDER BY
              fixture_date ASC

            LIMIT $2
          `,
          [
            Math.max(
              1,
              Math.min(
                24,
                Number(
                  lookaheadHours
                ) ||
                  STUDIO_SCHEDULER_LOOKAHEAD_HOURS
              )
            ),

            Math.max(
              1,
              Math.min(
                100,
                Number(limit) ||
                  STUDIO_SCHEDULER_MAX_MATCHES
              )
            ),
          ]
        );

      fixtures =
        forcedResult.rows;
    } else {
      fixtures =
        await getUpcomingStudioFixtures({
          lookaheadHours,
          refreshMinutes,
          limit,
        });
    }

    summary.fixturesFound =
      fixtures.length;

    console.log(
      "BRAIN STUDIO SCHEDULER : démarrage",
      {
        source,
        fixturesFound:
          fixtures.length,
        lookaheadHours,
        refreshMinutes,
        force,
      }
    );

    for (
      let index = 0;
      index < fixtures.length;
      index += 1
    ) {
      const fixture =
        fixtures[index];

      const fixtureId =
        Number(
          fixture.fixture_id
        );

      const matchLabel =
        `${fixture.home_team_name || "Domicile"}` +
        " vs " +
        `${fixture.away_team_name || "Extérieur"}`;

      const kickoff =
        fixture.fixture_date
          ? new Date(
              fixture.fixture_date
            )
          : null;

      /*
       * Deuxième sécurité :
       * le match a pu commencer pendant
       * l’exécution du scheduler.
       */
      if (
        kickoff &&
        !Number.isNaN(
          kickoff.getTime()
        ) &&
        kickoff.getTime() <=
          Date.now()
      ) {
        summary.locked += 1;

        summary.results.push({
          fixtureId,
          match:
            matchLabel,
          ok: true,
          saved: false,
          locked: true,
          reason:
            "MATCH_STARTED",
        });

        continue;
      }

      if (
        isFinishedSchedulerStatus(
          fixture.result_status
        )
      ) {
        summary.skipped += 1;

        summary.results.push({
          fixtureId,
          match:
            matchLabel,
          ok: true,
          saved: false,
          skipped: true,
          reason:
            "FINISHED_STATUS",
        });

        continue;
      }

      summary.attempted += 1;

      try {
        console.log(
          `BRAIN STUDIO SCHEDULER : analyse ${index + 1}/${fixtures.length}`,
          {
            fixtureId,
            match:
              matchLabel,
            kickoff:
              fixture.fixture_date,
          }
        );

        const result =
          await rebuildAutomaticStudioSnapshot(
            fixtureId
          );

        if (result?.locked) {
          summary.locked += 1;
        } else if (result?.saved) {
          summary.saved += 1;
        } else {
          summary.skipped += 1;
        }

        summary.results.push({
          fixtureId,
          match:
            matchLabel,
          ok: true,

          saved:
            result?.saved ===
            true,

          locked:
            result?.locked ===
            true,

          reason:
            result?.reason ||
            null,

          primaryMarket:
            result?.primaryMarket
              ? {
                  key:
                    result
                      .primaryMarket
                      .key,

                  label:
                    result
                      .primaryMarket
                      .label,

                  probability:
                    result
                      .primaryMarket
                      ?.fairOdds
                      ?.calibratedProbability ??
                    result
                      .primaryMarket
                      ?.probability ??
                    null,

                  decisionScore:
                    result
                      .primaryMarket
                      ?.decision
                      ?.score ??
                    result
                      .primaryMarket
                      ?.score ??
                    null,

                  decisionType:
                    result
                      .primaryMarket
                      ?.decision
                      ?.type ??
                    null,
                }
              : null,
        });
      } catch (error) {
        summary.failed += 1;

        summary.results.push({
          fixtureId,
          match:
            matchLabel,
          ok: false,

          error:
            error?.message ||
            "Erreur inconnue",
        });

        console.error(
          `BRAIN STUDIO SCHEDULER : erreur fixture ${fixtureId}`,
          error
        );
      }

      /*
       * Protection contre les appels trop
       * rapprochés à API-Football.
       */
      if (
        index <
        fixtures.length - 1
      ) {
        await waitStudioScheduler(
          STUDIO_SCHEDULER_DELAY_BETWEEN_MATCHES_MS
        );
      }
    }

    summary.finishedAt =
      new Date().toISOString();

    studioSchedulerLastFinishedAt =
      summary.finishedAt;

    studioSchedulerLastSummary =
      summary;

    console.log(
      "BRAIN STUDIO SCHEDULER : terminé",
      {
        fixturesFound:
          summary.fixturesFound,
        attempted:
          summary.attempted,
        saved:
          summary.saved,
        locked:
          summary.locked,
        skipped:
          summary.skipped,
        failed:
          summary.failed,
      }
    );

    return summary;
  } catch (error) {
    summary.ok = false;
    summary.failed += 1;

    summary.error =
      error?.message ||
      "Erreur inconnue";

    summary.finishedAt =
      new Date().toISOString();

    studioSchedulerLastFinishedAt =
      summary.finishedAt;

    studioSchedulerLastSummary =
      summary;

    console.error(
      "BRAIN STUDIO SCHEDULER : erreur générale",
      error
    );

    return summary;
  } finally {
    studioSchedulerRunning =
      false;
  }
}

/*
 * Route permettant de lancer manuellement
 * un cycle complet du scheduler.
 *
 * Exemples :
 *
 * /internal/run-studio-scheduler
 *
 * /internal/run-studio-scheduler?force=1
 *
 * /internal/run-studio-scheduler?hours=6&limit=10
 */
app.get(
  "/internal/run-studio-scheduler",
  async (req, res) => {
    const force =
      req.query.force === "1" ||
      req.query.force === "true";

    const lookaheadHours =
      Number(
        req.query.hours
      ) ||
      STUDIO_SCHEDULER_LOOKAHEAD_HOURS;

    const refreshMinutes =
      Number(
        req.query.refreshMinutes
      ) ||
      STUDIO_SCHEDULER_REFRESH_MINUTES;

    const limit =
      Number(
        req.query.limit
      ) ||
      STUDIO_SCHEDULER_MAX_MATCHES;

    const summary =
      await runAutomaticStudioScheduler({
        source:
          "manual-route",

        force,
        lookaheadHours,
        refreshMinutes,
        limit,
      });

    return res
      .status(
        summary.ok
          ? 200
          : 500
      )
      .json(summary);
  }
);

/*
 * Route de surveillance du scheduler.
 */
app.get(
  "/internal/studio-scheduler-status",
  async (req, res) => {
    try {
      const upcomingFixtures =
        await getUpcomingStudioFixtures({
          limit: 10,
        });

      return res.json({
        ok: true,

        running:
          studioSchedulerRunning,

        configuration: {
          intervalMinutes:
            STUDIO_SCHEDULER_INTERVAL_MS /
            60000,

          firstRunDelayMinutes:
            STUDIO_SCHEDULER_FIRST_RUN_DELAY_MS /
            60000,

          lookaheadHours:
            STUDIO_SCHEDULER_LOOKAHEAD_HOURS,

          refreshMinutes:
            STUDIO_SCHEDULER_REFRESH_MINUTES,

          maxMatches:
            STUDIO_SCHEDULER_MAX_MATCHES,

          delayBetweenMatchesMs:
            STUDIO_SCHEDULER_DELAY_BETWEEN_MATCHES_MS,
        },

        lastStartedAt:
          studioSchedulerLastStartedAt,

        lastFinishedAt:
          studioSchedulerLastFinishedAt,

        lastSummary:
          studioSchedulerLastSummary,

        upcomingCount:
          upcomingFixtures.length,

        upcomingFixtures:
          upcomingFixtures.map(
            (fixture) => ({
              fixtureId:
                fixture.fixture_id,

              kickoff:
                fixture.fixture_date,

              league:
                fixture.league_name,

              homeTeam:
                fixture.home_team_name,

              awayTeam:
                fixture.away_team_name,

              studioSavedAt:
                fixture.studio_saved_at,
            })
          ),
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ||
            "Impossible de lire le statut du scheduler",
        });
    }
  }
);
    /*
 * ============================================================
 * FOOTBALLBRAIN — LEARNING ENGINE V1
 * ============================================================
 *
 * Phase 1 :
 * - analyse des prédictions terminées ;
 * - statistiques par marché ;
 * - statistiques par grade ;
 * - statistiques par type de décision ;
 * - calcul d'un coefficient prudent ;
 * - aucune modification automatique des prédictions pour l'instant.
 */

let learningEngineRunning = false;

const LEARNING_ENGINE_VERSION =
  "learning-engine-v1";

const LEARNING_MIN_SAMPLE_SIZE = 20;

const LEARNING_TARGET_WIN_RATE = 55;

/*
 * Valeur toujours comprise entre min et max.
 */
function clampLearningNumber(
  value,
  min,
  max
) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.max(
    min,
    Math.min(max, number)
  );
}

/*
 * Crée les tables nécessaires au Learning Engine.
 */
async function ensureLearningEngineTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS
      learning_market_stats (
        id SERIAL PRIMARY KEY,

        market_key TEXT NOT NULL,
        decision_grade TEXT NOT NULL,
        decision_type TEXT NOT NULL,

        sample_size INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,

        win_rate NUMERIC(7,3) NOT NULL DEFAULT 0,
        average_probability NUMERIC(7,3),
        average_confidence NUMERIC(7,3),
        average_market_odd NUMERIC(10,3),
        average_value NUMERIC(10,3),

        total_profit NUMERIC(12,3) NOT NULL DEFAULT 0,
        roi NUMERIC(10,3) NOT NULL DEFAULT 0,

        calibration_gap NUMERIC(10,3) NOT NULL DEFAULT 0,

        raw_weight NUMERIC(8,5) NOT NULL DEFAULT 1,
        applied_weight NUMERIC(8,5) NOT NULL DEFAULT 1,

        reliability_level TEXT NOT NULL DEFAULT 'INSUFFICIENT_DATA',

        engine_version TEXT NOT NULL,

        calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (
          market_key,
          decision_grade,
          decision_type
        )
      );

    CREATE TABLE IF NOT EXISTS
      learning_runs (
        id SERIAL PRIMARY KEY,

        engine_version TEXT NOT NULL,

        predictions_found INTEGER NOT NULL DEFAULT 0,
        groups_calculated INTEGER NOT NULL DEFAULT 0,

        started_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ,

        status TEXT NOT NULL DEFAULT 'RUNNING',
        error_message TEXT,

        summary JSONB,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

    CREATE INDEX IF NOT EXISTS
      learning_market_stats_market_idx
    ON learning_market_stats (
      market_key
    );

    CREATE INDEX IF NOT EXISTS
      learning_market_stats_reliability_idx
    ON learning_market_stats (
      reliability_level
    );

    CREATE INDEX IF NOT EXISTS
      learning_runs_started_idx
    ON learning_runs (
      started_at DESC
    );
  `);

  console.log(
    "✅ Tables Learning Engine vérifiées"
  );
}

/*
 * Détermine le niveau de confiance statistique.
 */
function getLearningReliabilityLevel(
  sampleSize
) {
  const count = Number(sampleSize) || 0;

  if (count >= 200) {
    return "HIGH";
  }

  if (count >= 80) {
    return "MEDIUM";
  }

  if (
    count >=
    LEARNING_MIN_SAMPLE_SIZE
  ) {
    return "LOW";
  }

  return "INSUFFICIENT_DATA";
}

/*
 * Calcule un coefficient très prudent.
 *
 * Le poids reste volontairement entre
 * 0.90 et 1.10 afin d'éviter qu'une petite
 * série de résultats dérègle le moteur.
 */
function calculateLearningWeight({
  sampleSize,
  winRate,
  roi,
  calibrationGap,
}) {
  const count =
    Number(sampleSize) || 0;

  if (
    count <
    LEARNING_MIN_SAMPLE_SIZE
  ) {
    return {
      rawWeight: 1,
      appliedWeight: 1,
      reason:
        "Échantillon insuffisant",
    };
  }

  const normalizedWinRate =
    Number(winRate) || 0;

  const normalizedRoi =
    Number(roi) || 0;

  const normalizedCalibrationGap =
    Number(calibrationGap) || 0;

  /*
   * Influence principale :
   * écart par rapport au taux cible.
   */
  const winRateImpact =
    (
      normalizedWinRate -
      LEARNING_TARGET_WIN_RATE
    ) / 100;

  /*
   * ROI plafonné pour ne pas sur-réagir
   * aux cotes élevées ou petits échantillons.
   */
  const roiImpact =
    clampLearningNumber(
      normalizedRoi,
      -25,
      25
    ) / 500;

  /*
   * Si les probabilités annoncées sont
   * beaucoup plus hautes que les résultats
   * réels, le poids doit baisser.
   */
  const calibrationImpact =
    clampLearningNumber(
      -normalizedCalibrationGap,
      -20,
      20
    ) / 500;

  /*
   * Plus l'échantillon est important,
   * plus le coefficient peut être appliqué.
   */
  const sampleConfidence =
    clampLearningNumber(
      count / 200,
      0.1,
      1
    );

  const rawWeight =
    1 +
    winRateImpact * 0.35 +
    roiImpact * 0.25 +
    calibrationImpact * 0.25;

  const boundedRawWeight =
    clampLearningNumber(
      rawWeight,
      0.85,
      1.15
    );

  const appliedWeight =
    1 +
    (
      boundedRawWeight - 1
    ) *
    sampleConfidence;

  return {
    rawWeight:
      Number(
        boundedRawWeight.toFixed(5)
      ),

    appliedWeight:
      Number(
        clampLearningNumber(
          appliedWeight,
          0.9,
          1.1
        ).toFixed(5)
      ),

    reason:
      `Échantillon de ${count} prédictions`,
  };
}

/*
 * Reconstruit toutes les statistiques
 * du Learning Engine.
 */
async function rebuildLearningEngine({
  source = "manual",
} = {}) {
  if (learningEngineRunning) {
    return {
      ok: true,
      skipped: true,
      reason: "ALREADY_RUNNING",
    };
  }

  learningEngineRunning = true;

  const startedAt =
    new Date().toISOString();

  let runId = null;

  try {
    await ensureLearningEngineTables();

    const runResult =
      await pool.query(
        `
          INSERT INTO learning_runs (
            engine_version,
            started_at,
            status,
            summary
          )
          VALUES (
            $1,
            $2,
            'RUNNING',
            $3::jsonb
          )
          RETURNING id
        `,
        [
          LEARNING_ENGINE_VERSION,
          startedAt,
          JSON.stringify({
            source,
          }),
        ]
      );

    runId =
      runResult.rows[0].id;

    /*
     * Nous utilisons en priorité le snapshot
     * Brain Studio réellement sauvegardé.
     *
     * Pour les anciennes prédictions sans
     * snapshot, on reprend les colonnes
     * classiques de predictions.
     */
    const result =
      await pool.query(`
        SELECT
          COALESCE(
            NULLIF(
              UPPER(
                studio_market_key
              ),
              ''
            ),
            NULLIF(
              UPPER(
                selected_outcome
              ),
              ''
            ),
            'UNKNOWN'
          ) AS market_key,

          COALESCE(
            NULLIF(
              UPPER(
                studio_decision_grade
              ),
              ''
            ),
            'UNRATED'
          ) AS decision_grade,

          COALESCE(
            NULLIF(
              UPPER(
                studio_decision_type
              ),
              ''
            ),
            NULLIF(
              UPPER(
                bet_status
              ),
              ''
            ),
            'NO_BET'
          ) AS decision_type,

          COUNT(*)::INTEGER
            AS sample_size,

          COUNT(*) FILTER (
            WHERE won = TRUE
          )::INTEGER AS wins,

          COUNT(*) FILTER (
            WHERE won = FALSE
          )::INTEGER AS losses,

          ROUND(
            (
              COUNT(*) FILTER (
                WHERE won = TRUE
              )::NUMERIC
              /
              NULLIF(
                COUNT(*) FILTER (
                  WHERE won IS NOT NULL
                ),
                0
              )
            ) * 100,
            3
          ) AS win_rate,

          ROUND(
            AVG(
              COALESCE(
                studio_probability,
                CASE
                  WHEN LOWER(
                    selected_outcome
                  ) = 'home'
                    THEN home_probability

                  WHEN LOWER(
                    selected_outcome
                  ) = 'draw'
                    THEN draw_probability

                  WHEN LOWER(
                    selected_outcome
                  ) = 'away'
                    THEN away_probability

                  ELSE NULL
                END
              )
            ),
            3
          ) AS average_probability,

          ROUND(
            AVG(confidence),
            3
          ) AS average_confidence,

          ROUND(
            AVG(market_odd),
            3
          ) AS average_market_odd,

          ROUND(
            AVG(value_percentage),
            3
          ) AS average_value,

          ROUND(
            COALESCE(
              SUM(profit),
              0
            ),
            3
          ) AS total_profit,

          ROUND(
            (
              COALESCE(
                SUM(profit),
                0
              )
              /
              NULLIF(
                COUNT(*) FILTER (
                  WHERE won IS NOT NULL
                    AND COALESCE(
                      studio_decision_type,
                      bet_status,
                      'NO_BET'
                    ) <> 'NO_BET'
                ),
                0
              )
            ) * 100,
            3
          ) AS roi

        FROM predictions

        WHERE
          result_status = 'COMPLETED'

          AND won IS NOT NULL

          AND COALESCE(
            studio_decision_type,
            bet_status,
            'NO_BET'
          ) <> 'NO_BET'

        GROUP BY
          market_key,
          decision_grade,
          decision_type

        ORDER BY
          sample_size DESC
      `);

    const groups =
      result.rows.map(
        (row) => {
          const sampleSize =
            Number(row.sample_size) || 0;

          const wins =
            Number(row.wins) || 0;

          const losses =
            Number(row.losses) || 0;

          const winRate =
            Number(row.win_rate) || 0;

          const averageProbability =
            Number(
              row.average_probability
            ) || 0;

          const roi =
            Number(row.roi) || 0;

          const calibrationGap =
            Number(
              (
                averageProbability -
                winRate
              ).toFixed(3)
            );

          const reliabilityLevel =
            getLearningReliabilityLevel(
              sampleSize
            );

          const weight =
            calculateLearningWeight({
              sampleSize,
              winRate,
              roi,
              calibrationGap,
            });

          return {
            marketKey:
              row.market_key,

            decisionGrade:
              row.decision_grade,

            decisionType:
              row.decision_type,

            sampleSize,
            wins,
            losses,
            winRate,

            averageProbability,

            averageConfidence:
              Number(
                row.average_confidence
              ) || 0,

            averageMarketOdd:
              Number(
                row.average_market_odd
              ) || 0,

            averageValue:
              Number(
                row.average_value
              ) || 0,

            totalProfit:
              Number(
                row.total_profit
              ) || 0,

            roi,
            calibrationGap,

            reliabilityLevel,

            rawWeight:
              weight.rawWeight,

            appliedWeight:
              weight.appliedWeight,
          };
        }
      );

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      for (const group of groups) {
        await client.query(
          `
            INSERT INTO
              learning_market_stats (
                market_key,
                decision_grade,
                decision_type,

                sample_size,
                wins,
                losses,

                win_rate,
                average_probability,
                average_confidence,
                average_market_odd,
                average_value,

                total_profit,
                roi,
                calibration_gap,

                raw_weight,
                applied_weight,

                reliability_level,
                engine_version,

                calculated_at,
                updated_at
              )
            VALUES (
              $1, $2, $3,
              $4, $5, $6,
              $7, $8, $9, $10, $11,
              $12, $13, $14,
              $15, $16,
              $17, $18,
              NOW(), NOW()
            )

            ON CONFLICT (
              market_key,
              decision_grade,
              decision_type
            )

            DO UPDATE SET
              sample_size =
                EXCLUDED.sample_size,

              wins =
                EXCLUDED.wins,

              losses =
                EXCLUDED.losses,

              win_rate =
                EXCLUDED.win_rate,

              average_probability =
                EXCLUDED.average_probability,

              average_confidence =
                EXCLUDED.average_confidence,

              average_market_odd =
                EXCLUDED.average_market_odd,

              average_value =
                EXCLUDED.average_value,

              total_profit =
                EXCLUDED.total_profit,

              roi =
                EXCLUDED.roi,

              calibration_gap =
                EXCLUDED.calibration_gap,

              raw_weight =
                EXCLUDED.raw_weight,

              applied_weight =
                EXCLUDED.applied_weight,

              reliability_level =
                EXCLUDED.reliability_level,

              engine_version =
                EXCLUDED.engine_version,

              calculated_at =
                NOW(),

              updated_at =
                NOW()
          `,
          [
            group.marketKey,
            group.decisionGrade,
            group.decisionType,

            group.sampleSize,
            group.wins,
            group.losses,

            group.winRate,
            group.averageProbability,
            group.averageConfidence,
            group.averageMarketOdd,
            group.averageValue,

            group.totalProfit,
            group.roi,
            group.calibrationGap,

            group.rawWeight,
            group.appliedWeight,

            group.reliabilityLevel,
            LEARNING_ENGINE_VERSION,
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

    const finishedAt =
      new Date().toISOString();

    const summary = {
      ok: true,
      source,

      engineVersion:
        LEARNING_ENGINE_VERSION,

      predictionsFound:
        groups.reduce(
          (sum, group) =>
            sum +
            group.sampleSize,
          0
        ),

      groupsCalculated:
        groups.length,

      reliableGroups:
        groups.filter(
          (group) =>
            group.reliabilityLevel !==
            "INSUFFICIENT_DATA"
        ).length,

      startedAt,
      finishedAt,

      groups,
    };

    await pool.query(
      `
        UPDATE learning_runs
        SET
          predictions_found = $1,
          groups_calculated = $2,
          finished_at = $3,
          status = 'COMPLETED',
          summary = $4::jsonb
        WHERE id = $5
      `,
      [
        summary.predictionsFound,
        summary.groupsCalculated,
        finishedAt,
        JSON.stringify(summary),
        runId,
      ]
    );

    console.log(
      "LEARNING ENGINE : terminé",
      {
        predictionsFound:
          summary.predictionsFound,

        groupsCalculated:
          summary.groupsCalculated,

        reliableGroups:
          summary.reliableGroups,
      }
    );

    return summary;
  } catch (error) {
    const finishedAt =
      new Date().toISOString();

    if (runId) {
      await pool.query(
        `
          UPDATE learning_runs
          SET
            finished_at = $1,
            status = 'FAILED',
            error_message = $2
          WHERE id = $3
        `,
        [
          finishedAt,
          error?.message ||
            "Erreur inconnue",
          runId,
        ]
      ).catch(() => {});
    }

    console.error(
      "LEARNING ENGINE : erreur",
      error
    );

    return {
      ok: false,
      source,
      startedAt,
      finishedAt,

      error:
        error?.message ||
        "Erreur inconnue",
    };
  } finally {
    learningEngineRunning = false;
  }
}

/*
 * Lancement manuel du Learning Engine.
 */
app.get(
  "/internal/rebuild-learning-engine",
  async (req, res) => {
    const summary =
      await rebuildLearningEngine({
        source: "manual-route",
      });

    return res
      .status(
        summary.ok
          ? 200
          : 500
      )
      .json(summary);
  }
);

/*
 * Lecture des statistiques calculées.
 */
app.get(
  "/public/learning/market-stats",
  async (req, res) => {
    try {
      await ensureLearningEngineTables();

      const result =
        await pool.query(`
          SELECT
            market_key,
            decision_grade,
            decision_type,

            sample_size,
            wins,
            losses,

            win_rate,
            average_probability,
            average_confidence,
            average_market_odd,
            average_value,

            total_profit,
            roi,
            calibration_gap,

            raw_weight,
            applied_weight,

            reliability_level,
            engine_version,
            calculated_at

          FROM learning_market_stats

          ORDER BY
            sample_size DESC,
            market_key ASC,
            decision_grade ASC
        `);

      return res.json({
        ok: true,

        count:
          result.rows.length,

        stats:
          result.rows,
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          stats: [],

          error:
            error?.message ||
            "Impossible de charger les statistiques du Learning Engine",
        });
    }
  }
);
app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `FootballBrain API running on 0.0.0.0:${PORT}`
    );
ensureStudioPredictionColumns()
  .catch((error) => {
    console.error(
      "ERREUR COLONNES STUDIO :",
      error
    );
    });
    aiEventEngine
      .ensureTables()
      .catch((error) => {
        console.error(
          "ERREUR TABLE AI_EVENTS :",
          error
        );
      });
    ensureLearningEngineTables()
  .catch((error) => {
    console.error(
      "ERREUR TABLES LEARNING ENGINE :",
      error
    );
  });
    /*
     * Premier rafraîchissement des
     * résultats deux minutes après
     * le démarrage.
     *
     * Environ deux appels API.
     */
    setTimeout(() => {
      runAutomaticResultSync();
    }, 2 * 60 * 1000);

    /*
     * Résultats toutes les 15 minutes.
     *
     * Hier + aujourd’hui :
     * environ deux appels API par cycle.
     *
     * 96 cycles par jour × 2 appels
     * ≈ 192 appels par jour.
     */
    setInterval(() => {
      runAutomaticResultSync();
    }, 15 * 60 * 1000);
/*
 * Premier cycle Brain Studio trois minutes
 * après le démarrage du serveur.
 */
setTimeout(() => {
  runAutomaticStudioScheduler({
    source:
      "startup",
  }).catch((error) => {
    console.error(
      "ERREUR DÉMARRAGE BRAIN STUDIO SCHEDULER :",
      error
    );
  });
}, STUDIO_SCHEDULER_FIRST_RUN_DELAY_MS);

/*
 * Brain Studio toutes les 15 minutes.
 */
setInterval(() => {
  runAutomaticStudioScheduler({
    source:
      "interval",
  }).catch((error) => {
    console.error(
      "ERREUR INTERVAL BRAIN STUDIO SCHEDULER :",
      error
    );
  });
}, STUDIO_SCHEDULER_INTERVAL_MS);

console.log(
  "✅ Brain Studio Scheduler : toutes les 15 min"
);
    /*
     * IMPORTANT :
     * aucune analyse complète automatique
     * toutes les 15 minutes.
     *
     * Les analyses quotidiennes seront
     * remises ensuite avec un seul cycle
     * contrôlé et des compétitions filtrées.
     */

    console.log(
      "✅ Synchronisation groupée : 15 min"
    );

    console.log(
      "⏸️ Analyse générale répétée : désactivée"
    );
    /*
 * Vérification chaque minute de l’heure
 * prévue pour l’analyse quotidienne.
 */
setInterval(() => {
  checkDailyFullAnalysisSchedule()
    .catch((error) => {
      console.error(
        "ERREUR PLANIFICATEUR ANALYSE QUOTIDIENNE :",
        error
      );
    });
}, 60 * 1000);

/*
 * Première vérification au démarrage.
 */
checkDailyFullAnalysisSchedule()
  .catch((error) => {
    console.error(
      "ERREUR PREMIÈRE VÉRIFICATION QUOTIDIENNE :",
      error
    );
  });
  }
);
