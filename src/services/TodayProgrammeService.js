"use strict";

const DEFAULT_TIMEZONE = "Europe/Paris";

const FINISHED_STATUSES = new Set([
  "FT",
  "AET",
  "PEN",
  "FINISHED",
  "COMPLETED",
]);

const LIVE_STATUSES = new Set([
  "1H",
  "HT",
  "2H",
  "ET",
  "BT",
  "P",
  "SUSP",
  "INT",
  "LIVE",
]);

function normalizeDate(value) {
  const date = String(value || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }

  return date;
}

function normalizeStatus(status = {}) {
  const short = String(
    status?.short ||
      status?.code ||
      status ||
      ""
  )
    .trim()
    .toUpperCase();

  if (FINISHED_STATUSES.has(short)) {
    return "FINISHED";
  }

  if (LIVE_STATUSES.has(short)) {
    return "LIVE";
  }

  if (["PST", "CANC", "ABD", "AWD", "WO"].includes(short)) {
    return "UNAVAILABLE";
  }

  return "SCHEDULED";
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function createTodayProgrammeService({
  app,
  pool,
  callApiFootball,
  isExcludedFixture = () => false,
} = {}) {
  if (!app) {
    throw new Error(
      "TodayProgrammeService: app obligatoire."
    );
  }

  if (!pool) {
    throw new Error(
      "TodayProgrammeService: pool obligatoire."
    );
  }

  if (typeof callApiFootball !== "function") {
    throw new Error(
      "TodayProgrammeService: callApiFootball obligatoire."
    );
  }

  async function getEnabledLeagueIds() {
    try {
      const result = await pool.query(`
        SELECT league_id
        FROM league_settings
        WHERE enabled = TRUE
      `);

      return new Set(
        result.rows
          .map((row) => Number(row.league_id))
          .filter(
            (leagueId) =>
              Number.isInteger(leagueId) &&
              leagueId > 0
          )
      );
    } catch (error) {
      /*
       * Le Programme reste disponible même si le League Manager
       * n'a pas encore été initialisé.
       */
      if (error?.code === "42P01") {
        return new Set();
      }

      throw error;
    }
  }

  async function getPredictionMap(fixtureIds = []) {
    if (fixtureIds.length === 0) {
      return new Map();
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

          official_xg_home,
          official_xg_away,

          studio_market_key,
          studio_market_label,
          studio_probability,
          studio_decision_score,
          studio_analysis_version,
          studio_snapshot,
          studio_saved_at,

          result_status,
          home_goals,
          away_goals,
          updated_at

        FROM predictions
        WHERE fixture_id = ANY($1::int[])
      `,
      [fixtureIds]
    );

    return new Map(
      result.rows.map((row) => [
        Number(row.fixture_id),
        row,
      ])
    );
  }

  function adaptFixture(item, prediction) {
    const fixtureId = Number(item?.fixture?.id);
    const status = normalizeStatus(
      item?.fixture?.status
    );

    const studioSnapshotIsObject =
      prediction?.studio_snapshot &&
      typeof prediction.studio_snapshot === "object" &&
      !Array.isArray(prediction.studio_snapshot);

    const brainStudioAvailable = Boolean(
      prediction &&
        (
          studioSnapshotIsObject ||
          prediction.studio_market_key ||
          prediction.studio_market_label
        )
    );

    const aiLabAvailable = Boolean(prediction);

    return {
      fixtureId,

      date:
        item?.fixture?.date ||
        prediction?.fixture_date ||
        null,

      timestamp:
        numberOrNull(
          item?.fixture?.timestamp
        ),

      timezone:
        item?.fixture?.timezone ||
        DEFAULT_TIMEZONE,

      status: {
        category: status,
        short:
          item?.fixture?.status?.short ||
          null,
        long:
          item?.fixture?.status?.long ||
          null,
        elapsed:
          numberOrNull(
            item?.fixture?.status?.elapsed
          ),
      },

      venue: {
        id:
          numberOrNull(
            item?.fixture?.venue?.id
          ),
        name:
          item?.fixture?.venue?.name ||
          null,
        city:
          item?.fixture?.venue?.city ||
          null,
      },

      league: {
        id:
          numberOrNull(
            item?.league?.id
          ),
        name:
          item?.league?.name ||
          prediction?.league_name ||
          "Compétition inconnue",
        country:
          item?.league?.country ||
          null,
        logo:
          item?.league?.logo ||
          null,
        flag:
          item?.league?.flag ||
          null,
        season:
          numberOrNull(
            item?.league?.season
          ),
        round:
          item?.league?.round ||
          null,
      },

      homeTeam: {
        id:
          numberOrNull(
            item?.teams?.home?.id
          ),
        name:
          item?.teams?.home?.name ||
          prediction?.home_team_name ||
          "Équipe domicile",
        logo:
          item?.teams?.home?.logo ||
          null,
        winner:
          item?.teams?.home?.winner ??
          null,
      },

      awayTeam: {
        id:
          numberOrNull(
            item?.teams?.away?.id
          ),
        name:
          item?.teams?.away?.name ||
          prediction?.away_team_name ||
          "Équipe extérieure",
        logo:
          item?.teams?.away?.logo ||
          null,
        winner:
          item?.teams?.away?.winner ??
          null,
      },

      goals: {
        home:
          numberOrNull(
            item?.goals?.home ??
            prediction?.home_goals
          ),
        away:
          numberOrNull(
            item?.goals?.away ??
            prediction?.away_goals
          ),
      },

      analysis: {
        aiLab: {
          available:
            aiLabAvailable,
          updatedAt:
            prediction?.updated_at ||
            null,
          decision:
            prediction?.decision ||
            null,
          selectedOutcome:
            prediction?.selected_outcome ||
            null,
          betStatus:
            prediction?.bet_status ||
            null,
          confidence:
            numberOrNull(
              prediction?.confidence
            ),
          risk:
            prediction?.risk ||
            null,
          probabilities: {
            home:
              numberOrNull(
                prediction?.home_probability
              ),
            draw:
              numberOrNull(
                prediction?.draw_probability
              ),
            away:
              numberOrNull(
                prediction?.away_probability
              ),
          },
          xg: {
            home:
              numberOrNull(
                prediction?.official_xg_home
              ),
            away:
              numberOrNull(
                prediction?.official_xg_away
              ),
          },
        },

        brainStudio: {
          available:
            brainStudioAvailable,
          marketKey:
            prediction?.studio_market_key ||
            null,
          marketLabel:
            prediction?.studio_market_label ||
            null,
          probability:
            numberOrNull(
              prediction?.studio_probability
            ),
          decisionScore:
            numberOrNull(
              prediction?.studio_decision_score
            ),
          version:
            prediction?.studio_analysis_version ||
            null,
          savedAt:
            prediction?.studio_saved_at ||
            null,
        },
      },
    };
  }

  async function getProgramme(date) {
    const normalizedDate =
      normalizeDate(date);

    if (!normalizedDate) {
      const error = new Error(
        "La date doit être au format YYYY-MM-DD."
      );

      error.status = 400;
      throw error;
    }

    /*
     * Un seul appel API-Football. Il bénéficie déjà du cache central
     * configuré dans index.js.
     */
    const response =
      await callApiFootball(
        "/fixtures",
        {
          date: normalizedDate,
          timezone:
            DEFAULT_TIMEZONE,
        }
      );

    const rawFixtures =
      Array.isArray(
        response.data?.response
      )
        ? response.data.response
        : [];

    const enabledLeagueIds =
      await getEnabledLeagueIds();

    const filteredFixtures =
      rawFixtures.filter((fixture) => {
        if (isExcludedFixture(fixture)) {
          return false;
        }

        /*
         * Si le League Manager contient des ligues activées,
         * seules celles-ci sont visibles.
         * S'il est vide, on évite une page blanche et on affiche
         * toutes les compétitions non exclues.
         */
        if (enabledLeagueIds.size === 0) {
          return true;
        }

        const leagueId = Number(
          fixture?.league?.id
        );

        return enabledLeagueIds.has(
          leagueId
        );
      });

    const fixtureIds =
      filteredFixtures
        .map(
          (fixture) =>
            Number(fixture?.fixture?.id)
        )
        .filter(
          (fixtureId) =>
            Number.isInteger(fixtureId) &&
            fixtureId > 0
        );

    const predictionMap =
      await getPredictionMap(
        fixtureIds
      );

    const matches =
      filteredFixtures
        .map((fixture) => {
          const fixtureId =
            Number(
              fixture?.fixture?.id
            );

          return adaptFixture(
            fixture,
            predictionMap.get(
              fixtureId
            ) || null
          );
        })
        .sort((first, second) => {
          return (
            Number(first.timestamp || 0) -
            Number(second.timestamp || 0)
          );
        });

    const summary = {
      total:
        matches.length,
      scheduled:
        matches.filter(
          (match) =>
            match.status.category ===
            "SCHEDULED"
        ).length,
      live:
        matches.filter(
          (match) =>
            match.status.category ===
            "LIVE"
        ).length,
      finished:
        matches.filter(
          (match) =>
            match.status.category ===
            "FINISHED"
        ).length,
      aiLabAvailable:
        matches.filter(
          (match) =>
            match.analysis.aiLab.available
        ).length,
      brainStudioAvailable:
        matches.filter(
          (match) =>
            match.analysis.brainStudio.available
        ).length,
    };

    return {
      ok: true,
      date:
        normalizedDate,
      timezone:
        DEFAULT_TIMEZONE,
      source:
        "API_FOOTBALL_AND_RAILWAY",
      leagueFilterActive:
        enabledLeagueIds.size > 0,
      summary,
      matches,
      generatedAt:
        new Date().toISOString(),
    };
  }

  function registerRoutes() {
    app.get(
      "/public/programme-du-jour",
      async (req, res) => {
        try {
          const result =
            await getProgramme(
              req.query.date
            );

          return res.json(result);
        } catch (error) {
          console.error(
            "ERREUR PROGRAMME DU JOUR :",
            error
          );

          return res
            .status(
              error?.status ||
              error?.response?.status ||
              500
            )
            .json({
              ok: false,
              error:
                error?.message ||
                "Impossible de charger le programme du jour.",
            });
        }
      }
    );
  }

  return {
    getProgramme,
    registerRoutes,
  };
}

module.exports = {
  createTodayProgrammeService,
};
