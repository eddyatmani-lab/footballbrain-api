function registerAIEventRoutes({ app, aiEventEngine } = {}) {
  if (!app || typeof app.get !== "function") {
    throw new Error("Routes Event Engine : application Express invalide");
  }
  if (!aiEventEngine) {
    throw new Error("Routes Event Engine : moteur manquant");
  }

  app.get("/internal/test-ai-event/:fixtureId", async (req, res) => {
    try {
      await aiEventEngine.ensureTables();
      const fixtureId = Number(req.params.fixtureId);
      const event = await aiEventEngine.emit({
        fixtureId,
        eventType: "CORE_TEST_COMPLETED",
        eventCategory: "SYSTEM",
        source: "MANUAL_ROUTE",
        engineName: "EVENT_ENGINE",
        currentValue: { status: "WORKING" },
        metadata: {
          message: "Premier événement FootballBrain Core V2",
          testedAt: new Date().toISOString(),
        },
      });
      return res.json({ ok: true, message: "Event Engine opérationnel", event });
    } catch (error) {
      console.error("ERREUR TEST AI EVENT :", error);
      return res.status(500).json({ ok: false, error: error?.message || "Erreur inconnue" });
    }
  });

  app.get("/public/ai-timeline/:fixtureId", async (req, res) => {
    try {
      await aiEventEngine.ensureTables();
      const fixtureId = Number(req.params.fixtureId);
      const events = await aiEventEngine.getFixtureEvents(fixtureId, req.query.limit);
      return res.json({ ok: true, fixtureId, count: events.length, events });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        events: [],
        error: error?.message || "Impossible de charger la Timeline IA",
      });
    }
  });
}

module.exports = { registerAIEventRoutes };
