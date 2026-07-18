const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const analysisCache = new Map();
const ANALYSIS_CACHE_TTL = 60 * 60 * 1000;

const API_BASE_URL =
  "https://v3.football.api-sports.io";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
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
    return res.status(error.response?.status || 500).json({
      ok: false,
      error:
        error.apiData ||
        error.response?.data ||
        error.message,
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

   const cached = analysisCache.get(fixtureId);

if (
  cached &&
  Date.now() - cached.createdAt < ANALYSIS_CACHE_TTL
) {
  return res.json({
    ...cached.data,
    cached: true,
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

const market = summarizeMatchWinnerOdds(rawOdds);
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
const injuries =
  injuriesResponse.data?.response || [];

const lineups =
  lineupsResponse.data?.response || [];

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
    market
  );
const headToHead =
  h2hResponse.data?.response || [];

const footballBrainRating =
  computeFootballBrainRating({
    footballBrain,
    footballBrainDecision,
    market,
    headToHead,
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
    
    footballBrain,
  footballBrainDecision,
footballBrainRating,
},
};
await savePredictionToDatabase(result.analysis);
analysisCache.set(fixtureId, {
  createdAt: Date.now(),
  data: result,
});

return res.json({
  ...result,
  cached: false,
});

  } catch (error) {
    return res.status(error.response?.status || 500).json({
      ok: false,
      error:
        error.apiData ||
        error.response?.data ||
        error.message,
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
function summarizeMatchWinnerOdds(oddsData) {
  const home = [];
  const draw = [];
  const away = [];

  oddsData.forEach((fixture) => {
    (fixture.bookmakers || []).forEach(
      (bookmaker) => {
        const bet = (
          bookmaker.bets || []
        ).find(
          (b) => b.name === "Match Winner"
        );

        if (!bet) return;

        bet.values.forEach((value) => {
          const odd = Number(value.odd);

          if (value.value === "Home")
            home.push(odd);

          if (value.value === "Draw")
            draw.push(odd);

          if (value.value === "Away")
            away.push(odd);
        });
      }
    );
  });

  const avg = (arr) =>
    arr.length
      ? Number(
          (
            arr.reduce((a, b) => a + b, 0) /
            arr.length
          ).toFixed(2)
        )
      : null;

  const result = {
    homeAverageOdd: avg(home),
    drawAverageOdd: avg(draw),
    awayAverageOdd: avg(away),
  };

  const values = [
    {
      key: "home",
      value: result.homeAverageOdd,
    },
    {
      key: "draw",
      value: result.drawAverageOdd,
    },
    {
      key: "away",
      value: result.awayAverageOdd,
    },
  ].filter((x) => x.value);

  result.marketFavorite =
    values.sort(
      (a, b) => a.value - b.value
    )[0]?.key;

  return result;
}
function computeFootballBrainDecision(footballBrain, market) {
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

  const homeProbability =
    homeFormProbability * 0.45 +
    homeMarketProbability * 0.55;

  const awayProbability =
    awayFormProbability * 0.45 +
    awayMarketProbability * 0.55;

  let drawProbability =
    drawMarketProbability * 0.8 + 0.05;

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
    return res.status(500).json({
      ok: false,
      error: error.message,
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
async function savePredictionToDatabase(analysis) {
  const decision =
    analysis.footballBrainDecision || {};

  const probabilities =
    decision.probabilities || {};

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
        explanation
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20
      )
      ON CONFLICT (fixture_id)
      DO UPDATE SET
        fixture_date = EXCLUDED.fixture_date,
        league_id = EXCLUDED.league_id,
        league_name = EXCLUDED.league_name,
        home_team_id = EXCLUDED.home_team_id,
        home_team_name = EXCLUDED.home_team_name,
        away_team_id = EXCLUDED.away_team_id,
        away_team_name = EXCLUDED.away_team_name,
        decision = EXCLUDED.decision,
        selected_outcome = EXCLUDED.selected_outcome,
        bet_status = EXCLUDED.bet_status,
        confidence = EXCLUDED.confidence,
        risk = EXCLUDED.risk,
        home_probability = EXCLUDED.home_probability,
        draw_probability = EXCLUDED.draw_probability,
        away_probability = EXCLUDED.away_probability,
        fair_odd = EXCLUDED.fair_odd,
        market_odd = EXCLUDED.market_odd,
        value_percentage = EXCLUDED.value_percentage,
        explanation = EXCLUDED.explanation,
        updated_at = NOW()
    `,
    [
      analysis.fixtureId,
      analysis.match?.date || null,
      analysis.match?.league?.id || null,
      analysis.match?.league?.name || null,
      analysis.match?.homeTeam?.id || null,
      analysis.match?.homeTeam?.name || null,
      analysis.match?.awayTeam?.id || null,
      analysis.match?.awayTeam?.name || null,
      decision.decision || null,
      decision.selectedOutcome || null,
      decision.betStatus || null,
      decision.confidence ?? null,
      decision.risk || null,
      probabilities.home ?? null,
      probabilities.draw ?? null,
      probabilities.away ?? null,
      decision.fairOdd ?? null,
      decision.marketOdd ?? null,
      decision.value ?? null,
      decision.explanation || null,
    ]
  );
}
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
function settlePrediction(prediction, fixture) {
  const homeGoals = fixture.goals?.home;
  const awayGoals = fixture.goals?.away;

  if (
    !Number.isFinite(homeGoals) ||
    !Number.isFinite(awayGoals)
  ) {
    throw new Error("Score final indisponible");
  }

  let actualOutcome = "draw";

  if (homeGoals > awayGoals) {
    actualOutcome = "home";
  } else if (awayGoals > homeGoals) {
    actualOutcome = "away";
  }

  const isNoBet =
    prediction.bet_status === "NO_BET";

  if (isNoBet) {
    return {
      homeGoals,
      awayGoals,
      actualOutcome,
      won: null,
      profit: 0,
    };
  }

  const won =
    prediction.selected_outcome === actualOutcome;

  const marketOdd =
    Number(prediction.market_odd);

  // Mise fixe virtuelle : 1 unité
  const profit = won
    ? Number((marketOdd - 1).toFixed(2))
    : -1;

  return {
    homeGoals,
    awayGoals,
    actualOutcome,
    won,
    profit,
  };
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
    items: [],
  };

  for (const prediction of pendingResult.rows) {
    summary.checked += 1;

    try {
      const response = await callApiFootball(
        "/fixtures",
        {
          id: prediction.fixture_id,
          timezone: "Europe/Paris",
        }
      );

      const fixture =
        response.data?.response?.[0];

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
        fixtureId: prediction.fixture_id,
        status,
        score: {
          home: settlement.homeGoals,
          away: settlement.awayGoals,
        },
        selectedOutcome:
          prediction.selected_outcome,
        actualOutcome:
          settlement.actualOutcome,
        betStatus:
          prediction.bet_status,
        won: settlement.won,
        profit: settlement.profit,
        eloProcessed:
          !elo.alreadyProcessed,
        updated: true,
      });
    } catch (error) {
      summary.errors += 1;

      summary.items.push({
        fixtureId: prediction.fixture_id,
        updated: false,
        error: error.message,
      });
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
app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});