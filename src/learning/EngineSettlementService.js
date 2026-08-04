"use strict";

const {
  ENGINE_LEARNING_VERSION,
} = require("./LearningConfig");

function outcomeFromScore(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return "HOME";
  if (awayGoals > homeGoals) return "AWAY";
  return "DRAW";
}

function marketWon(side, homeGoals, awayGoals) {
  const total = homeGoals + awayGoals;
  const bothScored = homeGoals > 0 && awayGoals > 0;

  if (side === "HOME") return homeGoals > awayGoals;
  if (side === "DRAW") return homeGoals === awayGoals;
  if (side === "AWAY") return awayGoals > homeGoals;
  if (side === "BTTS") return bothScored;
  if (side === "NO_BTTS") return !bothScored;
  if (side === "OVER25") return total >= 3;
  if (side === "UNDER25") return total <= 2;

  return null;
}

function brierScore(probabilityPercent, won) {
  const probability = Number(probabilityPercent);

  if (!Number.isFinite(probability)) return null;

  const normalized = Math.max(
    0.001,
    Math.min(0.999, probability / 100)
  );

  const actual = won ? 1 : 0;
  return (normalized - actual) ** 2;
}

function logLoss(probabilityPercent, won) {
  const probability = Number(probabilityPercent);

  if (!Number.isFinite(probability)) return null;

  const normalized = Math.max(
    0.001,
    Math.min(0.999, probability / 100)
  );

  return -(
    won
      ? Math.log(normalized)
      : Math.log(1 - normalized)
  );
}

function createEngineSettlementService({ pool }) {
  if (!pool) {
    throw new Error("EngineSettlementService: pool obligatoire.");
  }

  async function ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS engine_prediction_settlements (
        id BIGSERIAL PRIMARY KEY,
        prediction_log_id BIGINT NOT NULL
          REFERENCES engine_prediction_logs(id)
          ON DELETE CASCADE,

        fixture_id BIGINT NOT NULL,
        engine_name TEXT NOT NULL,
        engine_version TEXT NOT NULL,

        predicted_side TEXT NOT NULL,
        predicted_probability NUMERIC(8, 4),

        home_goals INTEGER NOT NULL,
        away_goals INTEGER NOT NULL,
        actual_outcome TEXT NOT NULL,

        won BOOLEAN,
        brier_score NUMERIC(12, 8),
        log_loss NUMERIC(12, 8),
        absolute_error NUMERIC(12, 8),

        settlement_status TEXT NOT NULL DEFAULT 'SETTLED',
        ignored_reason TEXT,

        settlement_version TEXT NOT NULL,
        settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE(prediction_log_id)
      );
    `);

    await pool.query(`
      ALTER TABLE engine_prediction_settlements
      ADD COLUMN IF NOT EXISTS settlement_status TEXT
        NOT NULL DEFAULT 'SETTLED';
    `);

    await pool.query(`
      ALTER TABLE engine_prediction_settlements
      ADD COLUMN IF NOT EXISTS ignored_reason TEXT;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_engine_settlements_engine
      ON engine_prediction_settlements(
        engine_name,
        settled_at DESC
      );
    `);
  }

  async function settleFinished({ limit = 1000 } = {}) {
    const safeLimit = Math.max(
      1,
      Math.min(10000, Number(limit) || 1000)
    );

    const runResult = await pool.query(`
      INSERT INTO engine_learning_runs(run_type)
      VALUES ('ENGINE_SETTLEMENT')
      RETURNING id
    `);

    const runId = runResult.rows[0]?.id;

    try {
      const result = await pool.query(
      `
        SELECT
          log.id AS prediction_log_id,
          log.fixture_id,
          log.engine_name,
          log.engine_version,
          log.predicted_side,
          log.predicted_probability,
          p.home_goals,
          p.away_goals
        FROM engine_prediction_logs log
        JOIN predictions p
          ON p.fixture_id = log.fixture_id
        LEFT JOIN engine_prediction_settlements settlement
          ON settlement.prediction_log_id = log.id
        WHERE settlement.id IS NULL
          AND p.result_status = 'COMPLETED'
          AND p.home_goals IS NOT NULL
          AND p.away_goals IS NOT NULL
        ORDER BY p.fixture_date ASC NULLS LAST
        LIMIT $1
      `,
      [safeLimit]
    );

    let settled = 0;
    let ignored = 0;
    let skipped = 0;

    for (const row of result.rows) {
      const homeGoals = Number(row.home_goals);
      const awayGoals = Number(row.away_goals);
      const won = marketWon(
        row.predicted_side,
        homeGoals,
        awayGoals
      );

      if (won === null) {
        const ignoredReason =
          String(row.predicted_side || "").toUpperCase() ===
          "NEUTRAL"
            ? "NEUTRAL_PREDICTION"
            : "UNSUPPORTED_PREDICTED_SIDE";

        const ignoredResult = await pool.query(
          `
            INSERT INTO engine_prediction_settlements (
              prediction_log_id,
              fixture_id,
              engine_name,
              engine_version,
              predicted_side,
              predicted_probability,
              home_goals,
              away_goals,
              actual_outcome,
              won,
              brier_score,
              log_loss,
              absolute_error,
              settlement_status,
              ignored_reason,
              settlement_version,
              settled_at,
              updated_at
            )
            VALUES (
              $1, $2, $3, $4, $5,
              $6, $7, $8, $9,
              NULL, NULL, NULL, NULL,
              'IGNORED', $10, $11,
              NOW(), NOW()
            )
            ON CONFLICT (prediction_log_id)
            DO NOTHING
            RETURNING id
          `,
          [
            row.prediction_log_id,
            row.fixture_id,
            row.engine_name,
            row.engine_version,
            row.predicted_side,
            Number.isFinite(
              Number(row.predicted_probability)
            )
              ? Number(row.predicted_probability)
              : null,
            homeGoals,
            awayGoals,
            outcomeFromScore(
              homeGoals,
              awayGoals
            ),
            ignoredReason,
            ENGINE_LEARNING_VERSION,
          ]
        );

        if (ignoredResult.rowCount > 0) {
          ignored += 1;
        } else {
          skipped += 1;
        }

        continue;
      }

      const probability = Number(row.predicted_probability);
      const score = brierScore(probability, won);
      const loss = logLoss(probability, won);
      const absoluteError = Number.isFinite(probability)
        ? Math.abs(probability / 100 - (won ? 1 : 0))
        : null;

      await pool.query(
        `
          INSERT INTO engine_prediction_settlements (
            prediction_log_id,
            fixture_id,
            engine_name,
            engine_version,
            predicted_side,
            predicted_probability,
            home_goals,
            away_goals,
            actual_outcome,
            won,
            brier_score,
            log_loss,
            absolute_error,
            settlement_status,
            ignored_reason,
            settlement_version,
            settled_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13,
            'SETTLED', NULL, $14,
            NOW(), NOW()
          )
          ON CONFLICT (prediction_log_id)
          DO NOTHING
        `,
        [
          row.prediction_log_id,
          row.fixture_id,
          row.engine_name,
          row.engine_version,
          row.predicted_side,
          Number.isFinite(probability) ? probability : null,
          homeGoals,
          awayGoals,
          outcomeFromScore(homeGoals, awayGoals),
          won,
          score,
          loss,
          absoluteError,
          ENGINE_LEARNING_VERSION,
        ]
      );

      settled += 1;
    }

      const summary = {
        ok: true,
        found: result.rows.length,
        settled,
        ignored,
        skipped,
        processed: settled + ignored,
        settledAt: new Date().toISOString(),
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
          settled + ignored,
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

  return {
    ensureTables,
    settleFinished,
    marketWon,
  };
}

module.exports = {
  createEngineSettlementService,
  marketWon,
  outcomeFromScore,
};
