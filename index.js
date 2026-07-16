const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

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
app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});