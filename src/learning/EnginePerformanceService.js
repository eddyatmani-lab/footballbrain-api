"use strict";

const {
  ENGINE_LEARNING_VERSION,
  PERFORMANCE_THRESHOLDS,
  ENGINE_ROLES,
  ENGINE_ROLE_BY_NAME,
  ENGINE_METRIC_FOCUS,
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


function roleForEngine(engineName) {
  return (
    ENGINE_ROLE_BY_NAME?.[engineName] ||
    ENGINE_ROLES?.DIRECTIONAL ||
    "DIRECTIONAL"
  );
}

function metricFocusForRole(role) {
  return (
    ENGINE_METRIC_FOCUS?.[role] ||
    "ACCURACY"
  );
}

function contextualReliability(sampleSize) {
  const sample = Number(sampleSize) || 0;

  if (
    sample <
    PERFORMANCE_THRESHOLDS.contextualObservationSample
  ) {
    return "INSUFFICIENT_DATA";
  }

  if (
    sample <
    PERFORMANCE_THRESHOLDS.contextualLimitedSample
  ) {
    return "OBSERVATION";
  }

  if (
    sample <
    PERFORMANCE_THRESHOLDS.contextualReliableSample
  ) {
    return "DEVELOPING";
  }

  return "RELIABLE";
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
      CREATE TABLE IF NOT EXISTS engine_contextual_performance_stats (
        id BIGSERIAL PRIMARY KEY,
        engine_name TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        signal_bucket TEXT NOT NULL,

        sample_size INTEGER NOT NULL DEFAULT 0,
        home_wins INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        away_wins INTEGER NOT NULL DEFAULT 0,

        home_win_rate NUMERIC(10, 4),
        draw_rate NUMERIC(10, 4),
        away_win_rate NUMERIC(10, 4),
        average_goal_difference NUMERIC(10, 4),

        baseline_home_win_rate NUMERIC(10, 4),
        baseline_draw_rate NUMERIC(10, 4),
        baseline_away_win_rate NUMERIC(10, 4),

        home_win_lift NUMERIC(10, 4),
        draw_lift NUMERIC(10, 4),
        away_win_lift NUMERIC(10, 4),

        reliability_level TEXT NOT NULL,
        learning_version TEXT NOT NULL,

        calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (
          engine_name,
          signal_type,
          signal_bucket
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

  async function rebuildContextualPerformance() {
    const baselineResult = await pool.query(`
      SELECT
        COUNT(*)::INTEGER AS sample_size,
        COUNT(*) FILTER (
          WHERE p.home_goals > p.away_goals
        )::INTEGER AS home_wins,
        COUNT(*) FILTER (
          WHERE p.home_goals = p.away_goals
        )::INTEGER AS draws,
        COUNT(*) FILTER (
          WHERE p.away_goals > p.home_goals
        )::INTEGER AS away_wins
      FROM engine_prediction_logs log
      JOIN predictions p
        ON p.fixture_id = log.fixture_id
      WHERE log.engine_name = 'FatigueEngine'
        AND log.engine_role = 'CONTEXTUAL'
        AND p.result_status = 'COMPLETED'
        AND p.home_goals IS NOT NULL
        AND p.away_goals IS NOT NULL
        AND log.context_signal IS NOT NULL
    `);

    const baseline = baselineResult.rows[0] || {};
    const baselineSample =
      Number(baseline.sample_size) || 0;

    const baselineHome =
      baselineSample > 0
        ? (Number(baseline.home_wins || 0) / baselineSample) * 100
        : 0;
    const baselineDraw =
      baselineSample > 0
        ? (Number(baseline.draws || 0) / baselineSample) * 100
        : 0;
    const baselineAway =
      baselineSample > 0
        ? (Number(baseline.away_wins || 0) / baselineSample) * 100
        : 0;

    const result = await pool.query(`
      SELECT
        COALESCE(
          NULLIF(log.context_signal->>'bucket', ''),
          CASE
            WHEN (log.context_signal->>'penaltyDifference')::numeric <= -2
              THEN 'HOME_FRESHER'
            WHEN (log.context_signal->>'penaltyDifference')::numeric = -1
              THEN 'SLIGHT_HOME_FRESHER'
            WHEN (log.context_signal->>'penaltyDifference')::numeric = 0
              THEN 'BALANCED'
            WHEN (log.context_signal->>'penaltyDifference')::numeric = 1
              THEN 'SLIGHT_AWAY_FRESHER'
            WHEN (log.context_signal->>'penaltyDifference')::numeric >= 2
              THEN 'AWAY_FRESHER'
            ELSE 'UNKNOWN'
          END
        ) AS signal_bucket,

        COUNT(*)::INTEGER AS sample_size,
        COUNT(*) FILTER (
          WHERE p.home_goals > p.away_goals
        )::INTEGER AS home_wins,
        COUNT(*) FILTER (
          WHERE p.home_goals = p.away_goals
        )::INTEGER AS draws,
        COUNT(*) FILTER (
          WHERE p.away_goals > p.home_goals
        )::INTEGER AS away_wins,
        AVG(
          p.home_goals - p.away_goals
        )::NUMERIC AS average_goal_difference

      FROM engine_prediction_logs log
      JOIN predictions p
        ON p.fixture_id = log.fixture_id
      WHERE log.engine_name = 'FatigueEngine'
        AND log.engine_role = 'CONTEXTUAL'
        AND p.result_status = 'COMPLETED'
        AND p.home_goals IS NOT NULL
        AND p.away_goals IS NOT NULL
        AND log.context_signal IS NOT NULL
        AND log.context_signal ? 'penaltyDifference'
        AND NULLIF(
          log.context_signal->>'penaltyDifference',
          ''
        ) IS NOT NULL
      GROUP BY signal_bucket
      ORDER BY sample_size DESC, signal_bucket ASC
    `);

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (const row of result.rows) {
        const sampleSize =
          Number(row.sample_size) || 0;
        const homeWins =
          Number(row.home_wins) || 0;
        const draws =
          Number(row.draws) || 0;
        const awayWins =
          Number(row.away_wins) || 0;

        const homeRate =
          sampleSize > 0
            ? (homeWins / sampleSize) * 100
            : 0;
        const drawRate =
          sampleSize > 0
            ? (draws / sampleSize) * 100
            : 0;
        const awayRate =
          sampleSize > 0
            ? (awayWins / sampleSize) * 100
            : 0;

        await client.query(
          `
            INSERT INTO engine_contextual_performance_stats (
              engine_name,
              signal_type,
              signal_bucket,
              sample_size,
              home_wins,
              draws,
              away_wins,
              home_win_rate,
              draw_rate,
              away_win_rate,
              average_goal_difference,
              baseline_home_win_rate,
              baseline_draw_rate,
              baseline_away_win_rate,
              home_win_lift,
              draw_lift,
              away_win_lift,
              reliability_level,
              learning_version,
              calculated_at,
              updated_at
            )
            VALUES (
              'FatigueEngine',
              'FATIGUE_DIFFERENTIAL',
              $1,
              $2, $3, $4, $5,
              $6, $7, $8, $9,
              $10, $11, $12,
              $13, $14, $15,
              $16, $17,
              NOW(), NOW()
            )
            ON CONFLICT (
              engine_name,
              signal_type,
              signal_bucket
            )
            DO UPDATE SET
              sample_size = EXCLUDED.sample_size,
              home_wins = EXCLUDED.home_wins,
              draws = EXCLUDED.draws,
              away_wins = EXCLUDED.away_wins,
              home_win_rate = EXCLUDED.home_win_rate,
              draw_rate = EXCLUDED.draw_rate,
              away_win_rate = EXCLUDED.away_win_rate,
              average_goal_difference =
                EXCLUDED.average_goal_difference,
              baseline_home_win_rate =
                EXCLUDED.baseline_home_win_rate,
              baseline_draw_rate =
                EXCLUDED.baseline_draw_rate,
              baseline_away_win_rate =
                EXCLUDED.baseline_away_win_rate,
              home_win_lift =
                EXCLUDED.home_win_lift,
              draw_lift =
                EXCLUDED.draw_lift,
              away_win_lift =
                EXCLUDED.away_win_lift,
              reliability_level =
                EXCLUDED.reliability_level,
              learning_version =
                EXCLUDED.learning_version,
              calculated_at = NOW(),
              updated_at = NOW()
          `,
          [
            row.signal_bucket || "UNKNOWN",
            sampleSize,
            homeWins,
            draws,
            awayWins,
            homeRate,
            drawRate,
            awayRate,
            row.average_goal_difference == null
              ? null
              : Number(row.average_goal_difference),
            baselineHome,
            baselineDraw,
            baselineAway,
            homeRate - baselineHome,
            drawRate - baselineDraw,
            awayRate - baselineAway,
            contextualReliability(sampleSize),
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

    return {
      ok: true,
      engine: "FatigueEngine",
      role: "CONTEXTUAL",
      baselineSample,
      groups: result.rows.length,
    };
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

      const contextual =
        await rebuildContextualPerformance();

      const summary = {
        ok: true,
        groups: result.rows.length,
        contextual,
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

  async function getContextualPerformance() {
    const result = await pool.query(`
      SELECT *
      FROM engine_contextual_performance_stats
      ORDER BY
        engine_name ASC,
        sample_size DESC,
        signal_bucket ASC
    `);

    return {
      ok: true,
      count: result.rows.length,
      stats: result.rows,
      generatedAt: new Date().toISOString(),
    };
  }

  async function getRolePerformance() {
    const standardResult =
      await pool.query(`
        SELECT
          engine_name,
          SUM(sample_size)::INTEGER
            AS sample_size,

          CASE
            WHEN SUM(sample_size) > 0
            THEN
              SUM(
                COALESCE(accuracy, 0)
                * sample_size
              ) / SUM(sample_size)
            ELSE NULL
          END AS accuracy,

          CASE
            WHEN SUM(
              CASE
                WHEN average_probability IS NOT NULL
                  AND average_probability > 0
                THEN sample_size
                ELSE 0
              END
            ) > 0
            THEN
              SUM(
                CASE
                  WHEN average_probability IS NOT NULL
                    AND average_probability > 0
                  THEN average_probability * sample_size
                  ELSE 0
                END
              ) /
              SUM(
                CASE
                  WHEN average_probability IS NOT NULL
                    AND average_probability > 0
                  THEN sample_size
                  ELSE 0
                END
              )
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
              ) / SUM(sample_size)
            ELSE NULL
          END AS actual_frequency,

          CASE
            WHEN SUM(
              CASE
                WHEN average_probability IS NOT NULL
                  AND average_probability > 0
                THEN sample_size
                ELSE 0
              END
            ) > 0
            THEN
              SUM(
                CASE
                  WHEN average_probability IS NOT NULL
                    AND average_probability > 0
                  THEN calibration_gap * sample_size
                  ELSE 0
                END
              ) /
              SUM(
                CASE
                  WHEN average_probability IS NOT NULL
                    AND average_probability > 0
                  THEN sample_size
                  ELSE 0
                END
              )
            ELSE NULL
          END AS calibration_gap,

          CASE
            WHEN SUM(
              CASE
                WHEN average_probability IS NOT NULL
                  AND average_probability > 0
                THEN sample_size
                ELSE 0
              END
            ) > 0
            THEN
              SUM(
                CASE
                  WHEN average_probability IS NOT NULL
                    AND average_probability > 0
                  THEN brier_score * sample_size
                  ELSE 0
                END
              ) /
              SUM(
                CASE
                  WHEN average_probability IS NOT NULL
                    AND average_probability > 0
                  THEN sample_size
                  ELSE 0
                END
              )
            ELSE NULL
          END AS brier_score,

          CASE
            WHEN SUM(
              CASE
                WHEN average_probability IS NOT NULL
                  AND average_probability > 0
                THEN sample_size
                ELSE 0
              END
            ) > 0
            THEN
              SUM(
                CASE
                  WHEN average_probability IS NOT NULL
                    AND average_probability > 0
                  THEN log_loss * sample_size
                  ELSE 0
                END
              ) /
              SUM(
                CASE
                  WHEN average_probability IS NOT NULL
                    AND average_probability > 0
                  THEN sample_size
                  ELSE 0
                END
              )
            ELSE NULL
          END AS log_loss,

          SUM(
            CASE
              WHEN average_probability IS NOT NULL
                AND average_probability > 0
              THEN sample_size
              ELSE 0
            END
          )::INTEGER AS probability_sample_size

        FROM engine_performance_stats
        GROUP BY engine_name
        ORDER BY engine_name
      `);

    const contextualResult =
      await pool.query(`
        SELECT
          engine_name,
          SUM(sample_size)::INTEGER
            AS sample_size,
          MAX(calculated_at)
            AS calculated_at
        FROM
          engine_contextual_performance_stats
        GROUP BY engine_name
        ORDER BY engine_name
      `);

    const contextualByEngine =
      new Map(
        contextualResult.rows.map(
          (row) => [
            row.engine_name,
            row,
          ]
        )
      );

    const engines =
      standardResult.rows.map((row) => {
        const role =
          roleForEngine(
            row.engine_name
          );

        const sampleSize =
          Number(row.sample_size || 0);

        const probabilitySampleSize =
          Number(
            row.probability_sample_size || 0
          );

        const probabilityCoverage =
          sampleSize > 0
            ? probabilitySampleSize / sampleSize
            : 0;

        const minimumSample =
          role === ENGINE_ROLES.PROBABILISTIC
            ? PERFORMANCE_THRESHOLDS
                .probabilisticApplicationSample
            : PERFORMANCE_THRESHOLDS
                .directionalApplicationSample;

        const applicationReady =
          (
            role === ENGINE_ROLES.DIRECTIONAL &&
            sampleSize >= minimumSample
          ) ||
          (
            role === ENGINE_ROLES.PROBABILISTIC &&
            sampleSize >= minimumSample &&
            probabilityCoverage >=
              PERFORMANCE_THRESHOLDS
                .probabilisticMinimumProbabilityCoverage &&
            row.brier_score != null &&
            row.calibration_gap != null
          );

        return {
          engineName:
            row.engine_name,
          role,
          metricFocus:
            metricFocusForRole(role),
          sampleSize,
          accuracy:
            row.accuracy == null
              ? null
              : Number(row.accuracy),
          averageProbability:
            row.average_probability == null
              ? null
              : Number(
                  row.average_probability
                ),
          actualFrequency:
            row.actual_frequency == null
              ? null
              : Number(
                  row.actual_frequency
                ),
          calibrationGap:
            row.calibration_gap == null
              ? null
              : Number(
                  row.calibration_gap
                ),
          brierScore:
            row.brier_score == null
              ? null
              : Number(
                  row.brier_score
                ),
          logLoss:
            row.log_loss == null
              ? null
              : Number(
                  row.log_loss
                ),
          probabilitySampleSize,
          probabilityCoverage:
            Number(
              probabilityCoverage.toFixed(4)
            ),
          eligibleForGlobalWeight:
            role ===
              ENGINE_ROLES.DIRECTIONAL ||
            role ===
              ENGINE_ROLES.PROBABILISTIC,
          applicationReady,
          applicationReadinessReason:
            applicationReady
              ? "READY"
              : role === ENGINE_ROLES.PROBABILISTIC &&
                  probabilityCoverage <
                    PERFORMANCE_THRESHOLDS
                      .probabilisticMinimumProbabilityCoverage
                ? "INSUFFICIENT_PROBABILITY_COVERAGE"
                : sampleSize < minimumSample
                  ? "INSUFFICIENT_SAMPLE"
                  : "INSUFFICIENT_STATISTICAL_EVIDENCE",
        };
      });

    for (
      const [
        engineName,
        row,
      ] of contextualByEngine.entries()
    ) {
      const role =
        roleForEngine(engineName);

      engines.push({
        engineName,
        role,
        metricFocus:
          metricFocusForRole(role),
        sampleSize:
          Number(
            row.sample_size || 0
          ),
        accuracy: null,
        averageProbability: null,
        actualFrequency: null,
        calibrationGap: null,
        brierScore: null,
        logLoss: null,
        eligibleForGlobalWeight:
          false,
        contextualReliability:
          contextualReliability(
            row.sample_size
          ),
      });
    }

    /*
     * Evite un doublon si un ancien moteur contextuel
     * possédait encore de vieilles stats directionnelles.
     */
    const deduplicated =
      new Map();

    for (const engine of engines) {
      const existing =
        deduplicated.get(
          engine.engineName
        );

      if (
        !existing ||
        engine.role ===
          ENGINE_ROLES.CONTEXTUAL
      ) {
        deduplicated.set(
          engine.engineName,
          engine
        );
      }
    }

    return {
      ok: true,
      version:
        ENGINE_LEARNING_VERSION,
      engines:
        [...deduplicated.values()]
          .sort(
            (a, b) =>
              a.engineName
                .localeCompare(
                  b.engineName
                )
          ),
      roles: {
        directional:
          ENGINE_ROLES.DIRECTIONAL,
        probabilistic:
          ENGINE_ROLES.PROBABILISTIC,
        market:
          ENGINE_ROLES.MARKET,
        contextual:
          ENGINE_ROLES.CONTEXTUAL,
      },
      generatedAt:
        new Date().toISOString(),
    };
  }

  async function getPerformance() {
    const result = await pool.query(`
      SELECT *
      FROM engine_performance_stats
      ORDER BY
        engine_name ASC,
        sample_size DESC,
        predicted_side ASC
    `);

    return {
      ok: true,
      count: result.rows.length,
      stats: result.rows,
      generatedAt: new Date().toISOString(),
    };
  }

  return {
    ensureTables,
    rebuildPerformance,
    getPerformance,
    getRolePerformance,
    getContextualPerformance,
    rebuildContextualPerformance,
    reliabilityLevel,
  };
}

module.exports = {
  createEnginePerformanceService,
  reliabilityLevel,
};
