const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("FootballBrain API OK");
});

app.get("/timezone", async (req, res) => {
  try {
    const apiKey = process.env.API_FOOTBALL_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "API_FOOTBALL_KEY manquante",
      });
    }

    const response = await axios.get(
      "https://v3.football.api-sports.io/timezone",
      {
        headers: {
          "x-apisports-key": apiKey.trim(),
        },
        timeout: 15000,
      }
    );

    return res.json({
      ok: true,
      httpStatus: response.status,
      data: response.data,
    });
  } catch (error) {
    return res.status(
      error.response?.status || 500
    ).json({
      ok: false,
      httpStatus: error.response?.status || 500,
      error:
        error.response?.data ||
        error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});