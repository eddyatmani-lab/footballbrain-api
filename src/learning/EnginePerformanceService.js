"use strict";

const {
  ENGINE_LEARNING_VERSION,
  PERFORMANCE_THRESHOLDS,
} = require("./LearningConfig");

function reliabilityLevel(sampleSize, brierScore) {
  const sample = Number(sampleSize) || 0;
  const brier = Number(brierScore);

  if (sample < PERFORMANCE_THRESHOLDS.minimumSample) {
    return "INSUFFICIENT_DATA";
  }

  if (sample < PERFORMANCE_THRESHOLDS.mediumSample) {
    return "EARLY_SAMPLE";
  }

  if (Number.isFinite(brier)) {
    if (brier <= PERFORMANCE_THRESHOLDS.excellentBrier) {
      return sample >= PERFORMANCE_THRESHOLDS.reliableSample
        ? "EXCELLENT"
        : "PROMISING";
    }

    if (brier <= PERFORMANCE_THRESHOLDS.goodBrier) {
      return "RELIABLE";
    }

    if (brier >= PERFORMANCE_THRESHOLDS.warningBrier) {
      return "WARNING";
    }
  }

  return sample >= PERFORMANCE_THRESHOLDS.reliableSample
    ? "STABLE"
    : "DEVELOPING";
}

function createEnginePerformanceService({ pool }) {
  if (!pool) {
    throw new Error("EnginePerformanceService: pool obligatoire.");
  }

  async function ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS engine_performance_stats (
        id BIGSERIAL PRIMARY KEY,
        engine_name TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        predicted_side TEXT NOT NULL,

        sample_size INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        accuracy NUMERIC(10, 4),

        average_probability NUMERIC(10, 4),
        actual_frequency NUMERIC(10, 4),
        calibration_gap NUMERIC(10, 4),

        brier_score NUMERIC(12, 8),
        log_loss NUMERIC(12, 8),
        average_absolute_error NUMERIC(12, 8),

        reliability_level TEXT NOT NULL,
        learning_version TEXT NOT NULL,

        calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE(
          engine_name,
          engine_version,
          predicted_side
        )
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS engine_learning_runs (
        id BIGSERIAL PRIMARY KEY,
        run_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'RUNNING',
        rows_processed INTEGER NOT NULL DEFAULT 0,
        summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        error_message TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      );
    `);
  }

  async function rebuildPerformance() {
    const runResult = await pool.query(
      `
        INSERT INTO engine_learning_runs(run_type)
        VALUES ('PERFORMANCE_REBUILD')
        RETURNING id
      `
    );

    const runId = runResult.rows[0]?.id;
    const startedAt = new Date().toISOString();

    try {
      const result = await pool.query(`
        SELECT
          engine_name,
          engine_version,
          predicted_side,

          COUNT(*)::INTEGER AS sample_size,
          COUNT(*) FILTER (WHERE won = TRUE)::INTEGER AS wins,
          COUNT(*) FILTER (WHERE won = FALSE)::INTEGER AS losses,

          AVG(CASE WHEN won THEN 100.0 ELSE 0.0 END)
            AS accuracy,

          AVG(predicted_probability)
            FILTER (WHERE predicted_probability IS NOT NULL)
            AS average_probability,

          AVG(CASE WHEN won THEN 100.0 ELSE 0.0 END)
            AS actual_frequency,

          AVG(brier_score)
            FILTER (WHERE brier_score IS NOT NULL)
            AS brier_score,

          AVG(log_loss)
            FILTER (WHERE log_loss IS NOT NULL)
            AS log_loss,

          AVG(absolute_error)
            FILTER (WHERE absolute_error IS NOT NULL)
            AS average_absolute_error

        FROM engine_prediction_settlements
        WHERE settlement_status = 'SETTLED'
          AND won IS NOT NULL
        GROUP BY
          engine_name,
          engine_version,
          predicted_side
        ORDER BY
          engine_name,
          predicted_side
      `);

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        for (const row of result.rows) {
          const sampleSize = Number(row.sample_size) || 0;
          const averageProbability =
            row.average_probability == null
              ? null
              : Number(row.average_probability);
          const actualFrequency =
            row.actual_frequency == null
              ? null
              : Number(row.actual_frequency);
          const brier =
            row.brier_score == null
              ? null
              : Number(row.brier_score);

          const calibrationGap =
            averageProbability == null ||
            actualFrequency == null
              ? null
              : averageProbability - actualFrequency;

          await client.query(
            `
              INSERT INTO engine_performance_stats (
                engine_name,
                engine_version,
                predicted_side,
                sample_size,
                wins,
                losses,
                accuracy,
                average_probability,
                actual_frequency,
                calibration_gap,
                brier_score,
                log_loss,
                average_absolute_error,
                reliability_level,
                learning_version,
                calculated_at,
                updated_at
              )
              VALUES (
                $1, $2, $3,
                $4, $5, $6, $7,
                $8, $9, $10,
                $11, $12, $13,
                $14, $15,
                NOW(), NOW()
              )
              ON CONFLICT (
                engine_name,
                engine_version,
                predicted_side
              )
              DO UPDATE SET
                sample_size = EXCLUDED.sample_size,
                wins = EXCLUDED.wins,
                losses = EXCLUDED.losses,
                accuracy = EXCLUDED.accuracy,
                average_probability = EXCLUDED.average_probability,
                actual_frequency = EXCLUDED.actual_frequency,
                calibration_gap = EXCLUDED.calibration_gap,
                brier_score = EXCLUDED.brier_score,
                log_loss = EXCLUDED.log_loss,
                average_absolute_error =
                  EXCLUDED.average_absolute_error,
                reliability_level =
                  EXCLUDED.reliability_level,
                learning_version =
                  EXCLUDED.learning_version,
                calculated_at = NOW(),
                updated_at = NOW()
            `,
            [
              row.engine_name,
              row.engine_version,
              row.predicted_side,
              sampleSize,
              Number(row.wins) || 0,
              Number(row.losses) || 0,
              row.accuracy == null
                ? null
                : Number(row.accuracy),
              averageProbability,
              actualFrequency,
              calibrationGap,
              brier,
              row.log_loss == null
                ? null
                : Number(row.log_loss),
              row.average_absolute_error == null
                ? null
                : Number(row.average_absolute_error),
              reliabilityLevel(sampleSize, brier),
              ENGINE_LEARNING_VERSION,
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

      const summary = {
        ok: true,
        groups: result.rows.length,
        startedAt,
        finishedAt: new Date().toISOString(),
      };

      await pool.query(
        `
          UPDATE engine_learning_runs
          SET
            status = 'COMPLETED',
            rows_processed = $2,
            summary = $3::jsonb,
            finished_at = NOW()
          WHERE id = $1
        `,
        [
          runId,
          result.rows.length,
          JSON.stringify(summary),
        ]
      );

      return summary;
    } catch (error) {
      await pool.query(
        `
          UPDATE engine_learning_runs
          SET
            status = 'FAILED',
            error_message = $2,
            finished_at = NOW()
          WHERE id = $1
        `,
        [
          runId,
          String(error?.message || error).slice(0, 2000),
        ]
      );

      throw error;
    }
  }

  async function getPerformance() {
    const [detailResult, globalResult] =
      await Promise.all([
        pool.query(`
          SELECT *
          FROM engine_performance_stats
          ORDER BY
            engine_name ASC,
            sample_size DESC,
            predicted_side ASC
        `),

        /*
         * Vue globale : toutes les sélections d'un même moteur
         * sont réunies pour le pilotage des poids.
         *
         * Les statistiques par sélection restent disponibles dans
         * `stats` pour le diagnostic détaillé.
         */
        pool.query(`
          SELECT
            engine_name,

            STRING_AGG(
              DISTINCT engine_version,
              ', ' ORDER BY engine_version
            ) AS engine_versions,

            SUM(sample_size)::INTEGER
              AS sample_size,

            SUM(wins)::INTEGER
              AS wins,

            SUM(losses)::INTEGER
              AS losses,

            CASE
              WHEN SUM(sample_size) > 0
              THEN
                SUM(wins) * 100.0 /
                SUM(sample_size)
              ELSE NULL
            END AS accuracy,

            CASE
              WHEN SUM(sample_size) > 0
              THEN
                SUM(
                  COALESCE(
                    average_probability,
                    0
                  ) * sample_size
                ) /
                SUM(sample_size)
              ELSE NULL
            END AS average_probability,

            CASE
              WHEN SUM(sample_size) > 0
              THEN
                SUM(
                  COALESCE(
                    actual_frequency,
                    0
                  ) * sample_size
                ) /
                SUM(sample_size)
              ELSE NULL
            END AS actual_frequency,

            CASE
              WHEN SUM(sample_size) > 0
              THEN
                SUM(
                  COALESCE(
                    calibration_gap,
                    0
                  ) * sample_size
                ) /
                SUM(sample_size)
              ELSE NULL
            END AS calibration_gap,

            CASE
              WHEN SUM(sample_size) > 0
              THEN
                SUM(
                  COALESCE(
                    brier_score,
                    0
                  ) * sample_size
                ) /
                SUM(sample_size)
              ELSE NULL
            END AS brier_score,

            CASE
              WHEN SUM(sample_size) > 0
              THEN
                SUM(
                  COALESCE(
                    log_loss,
                    0
                  ) * sample_size
                ) /
                SUM(sample_size)
              ELSE NULL
            END AS log_loss,

            CASE
              WHEN SUM(sample_size) > 0
              THEN
                SUM(
                  COALESCE(
                    average_absolute_error,
                    0
                  ) * sample_size
                ) /
                SUM(sample_size)
              ELSE NULL
            END AS average_absolute_error,

            COUNT(*)::INTEGER
              AS selection_groups,

            ARRAY_AGG(
              predicted_side
              ORDER BY predicted_side
            ) AS selections

          FROM engine_performance_stats
          GROUP BY engine_name
          ORDER BY
            SUM(sample_size) DESC,
            engine_name ASC
        `),
      ]);

    const engineSummaries =
      globalResult.rows.map((row) => {
        const sampleSize =
          Number(row.sample_size) || 0;

        const brier =
          row.brier_score == null
            ? null
            : Number(row.brier_score);

        return {
          ...row,
          reliability_level:
            reliabilityLevel(
              sampleSize,
              brier
            ),
        };
      });

    return {
      ok: true,
      count: detailResult.rows.length,
      engineCount: engineSummaries.length,

      /* Vue principale du Dashboard. */
      engineSummaries,

      /* Vue détaillée par HOME/AWAY/BTTS/etc. */
      stats: detailResult.rows,

      generatedAt: new Date().toISOString(),
    };
  }

  return {
    ensureTables,
    rebuildPerformance,
    getPerformance,
    reliabilityLevel,
  };
}

module.exports = {
  createEnginePerformanceService,
  reliabilityLevel,
};
