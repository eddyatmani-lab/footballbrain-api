"use strict";

const {
  LEARNING_MODE,
  ENGINE_LEARNING_VERSION,
  SETTLEMENT_INTERVAL_MINUTES,
  PERFORMANCE_INTERVAL_MINUTES,
} = require("./LearningConfig");

const {
  createEnginePredictionLog,
} = require("./EnginePredictionLog");

const {
  createEngineSettlementService,
} = require("./EngineSettlementService");

const {
  createEnginePerformanceService,
} = require("./EnginePerformanceService");

function createEngineLearningCore({
  app,
  pool,
  adminGuard = null,
  schedulersEnabled = true,
} = {}) {
  if (!app || !pool) {
    throw new Error(
      "EngineLearningCore: app et pool obligatoires."
    );
  }

  const predictionLog =
    createEnginePredictionLog({ pool });

  const settlementService =
    createEngineSettlementService({ pool });

  const performanceService =
    createEnginePerformanceService({ pool });

  let settlementTimer = null;
  let performanceTimer = null;
  let settlementRunning = false;
  let performanceRunning = false;

  function withAdminGuard(handler) {
    if (typeof adminGuard !== "function") {
      return [handler];
    }

    return [adminGuard, handler];
  }

  async function ensureTables() {
    await predictionLog.ensureTables();
    await settlementService.ensureTables();
    await performanceService.ensureTables();
  }

  async function logStudioSnapshot(payload = {}) {
    return predictionLog.logFromStudioSnapshot(payload);
  }

  async function runSettlement() {
    if (settlementRunning) {
      return {
        ok: true,
        skipped: true,
        reason: "SETTLEMENT_ALREADY_RUNNING",
      };
    }

    settlementRunning = true;

    try {
      return await settlementService.settleFinished({
        limit: 5000,
      });
    } finally {
      settlementRunning = false;
    }
  }

  async function rebuildPerformance() {
    if (performanceRunning) {
      return {
        ok: true,
        skipped: true,
        reason: "PERFORMANCE_ALREADY_RUNNING",
      };
    }

    performanceRunning = true;

    try {
      return await performanceService.rebuildPerformance();
    } finally {
      performanceRunning = false;
    }
  }

  function registerRoutes() {
    app.get(
      "/internal/learning/engines/status",
      ...withAdminGuard(async (req, res) => {
        try {
          await ensureTables();

          const [
            logs,
            settlements,
            stats,
            pending,
            ignored,
            latestRuns,
          ] = await Promise.all([
            pool.query(
              "SELECT COUNT(*)::INTEGER AS count FROM engine_prediction_logs"
            ),
            pool.query(
              "SELECT COUNT(*)::INTEGER AS count FROM engine_prediction_settlements"
            ),
            pool.query(
              "SELECT COUNT(*)::INTEGER AS count FROM engine_performance_stats"
            ),
            pool.query(`
              SELECT COUNT(*)::INTEGER AS count
              FROM engine_prediction_logs log
              JOIN predictions p
                ON p.fixture_id = log.fixture_id
              LEFT JOIN engine_prediction_settlements settlement
                ON settlement.prediction_log_id = log.id
              WHERE settlement.id IS NULL
                AND p.result_status = 'COMPLETED'
                AND p.home_goals IS NOT NULL
                AND p.away_goals IS NOT NULL
                AND UPPER(COALESCE(log.predicted_side, '')) IN (
                  'HOME',
                  'DRAW',
                  'AWAY',
                  'BTTS',
                  'NO_BTTS',
                  'OVER25',
                  'UNDER25'
                )
            `),
            pool.query(`
              SELECT COUNT(*)::INTEGER AS count
              FROM engine_prediction_settlements
              WHERE settlement_status = 'IGNORED'
            `),
            pool.query(`
              SELECT DISTINCT ON (run_type)
                run_type,
                status,
                rows_processed,
                summary,
                error_message,
                started_at,
                finished_at
              FROM engine_learning_runs
              ORDER BY run_type, started_at DESC
            `),
          ]);

          const runsByType = Object.fromEntries(
            latestRuns.rows.map((run) => [
              run.run_type,
              run,
            ])
          );

          return res.json({
            ok: true,
            mode: LEARNING_MODE,
            version: ENGINE_LEARNING_VERSION,
            logs: Number(logs.rows[0]?.count || 0),
            settlements: Number(
              settlements.rows[0]?.count || 0
            ),
            pendingSettlements: Number(
              pending.rows[0]?.count || 0
            ),
            ignoredSettlements: Number(
              ignored.rows[0]?.count || 0
            ),
            performanceGroups: Number(
              stats.rows[0]?.count || 0
            ),
            lastSettlementRun:
              runsByType.ENGINE_SETTLEMENT || null,
            lastPerformanceRun:
              runsByType.PERFORMANCE_REBUILD || null,
          });
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error: error?.message || String(error),
          });
        }
      })
    );

    app.post(
      "/internal/learning/engines/settle",
      ...withAdminGuard(async (req, res) => {
        try {
          await ensureTables();
          return res.json(await runSettlement());
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error: error?.message || String(error),
          });
        }
      })
    );

    app.post(
      "/internal/learning/engines/rebuild-performance",
      ...withAdminGuard(async (req, res) => {
        try {
          await ensureTables();
          return res.json(await rebuildPerformance());
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error: error?.message || String(error),
          });
        }
      })
    );

    app.get(
      "/internal/learning/engines/performance",
      ...withAdminGuard(async (req, res) => {
        try {
          await ensureTables();
          return res.json(
            await performanceService.getPerformance()
          );
        } catch (error) {
          return res.status(500).json({
            ok: false,
            error: error?.message || String(error),
          });
        }
      })
    );
  }

  function startScheduler() {
    if (!schedulersEnabled) return;
    if (settlementTimer || performanceTimer) return;

    setTimeout(async () => {
      try {
        await ensureTables();
        const settlement = await runSettlement();

        if (Number(settlement?.settled || 0) > 0) {
          await rebuildPerformance();
        }
      } catch (error) {
        console.error(
          "ENGINE LEARNING INITIAL RUN :",
          error
        );
      }
    }, 30 * 1000);

    settlementTimer = setInterval(async () => {
      try {
        const settlement = await runSettlement();

        if (Number(settlement?.settled || 0) > 0) {
          await rebuildPerformance();
        }
      } catch (error) {
        console.error(
          "ENGINE LEARNING SETTLEMENT :",
          error
        );
      }
    }, SETTLEMENT_INTERVAL_MINUTES * 60 * 1000);

    performanceTimer = setInterval(() => {
      rebuildPerformance().catch((error) => {
        console.error(
          "ENGINE LEARNING PERFORMANCE :",
          error
        );
      });
    }, PERFORMANCE_INTERVAL_MINUTES * 60 * 1000);
  }

  function stopScheduler() {
    if (settlementTimer) clearInterval(settlementTimer);
    if (performanceTimer) clearInterval(performanceTimer);

    settlementTimer = null;
    performanceTimer = null;
  }

  return {
    ensureTables,
    registerRoutes,
    startScheduler,
    stopScheduler,
    logStudioSnapshot,
    runSettlement,
    rebuildPerformance,
    mode: LEARNING_MODE,
    version: ENGINE_LEARNING_VERSION,
  };
}

module.exports = {
  createEngineLearningCore,
};
