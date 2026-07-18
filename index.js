const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;
const analysisCache = new Map();
const ANALYSIS_CACHE_TTL = 60 * 60 * 1000; // 1 heure

const API_BASE_URL =
  "https://v3.football.api-sports.io";

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
    ]);
const homeRecentForm =
  homeRecentResponse.data?.response || [];

const awayRecentForm =
  awayRecentResponse.data?.response || [];
const rawOdds = oddsResponse.data?.response || [];

const market = summarizeMatchWinnerOdds(rawOdds);
const footballBrain = computeFootballBrainScore(
  homeRecentForm.map((m) => ({
    result:
      m.teams.home.id === homeTeamId
        ? (m.goals.home > m.goals.away ? "W" :
           m.goals.home < m.goals.away ? "L" : "D")
        : (m.goals.away > m.goals.home ? "W" :
           m.goals.away < m.goals.home ? "L" : "D"),
  })),
  awayRecentForm.map((m) => ({
    result:
      m.teams.home.id === awayTeamId
        ? (m.goals.home > m.goals.away ? "W" :
           m.goals.home < m.goals.away ? "L" : "D")
        : (m.goals.away > m.goals.home ? "W" :
           m.goals.away < m.goals.home ? "L" : "D"),
  }))
);
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

if (
  probabilities.home + probabilities.draw >= 70
) {
  decision = "1X";
  reason = "La probabilité combinée domicile ou nul dépasse 70 %";
}

if (
  probabilities.away + probabilities.draw >= 70
) {
  decision = "X2";
  reason = "La probabilité combinée extérieur ou nul dépasse 70 %";
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
cd %USERPROFILE%\footballbrain-api
notepad index.js
app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});