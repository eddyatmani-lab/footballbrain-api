# Correctif v2.3.3 — Colonnes Brain Studio manquantes

## Cause exacte

Le correctif v2.3.2 contenait bien la logique permettant d'expliquer la véritable
décision Brain Studio.

Mais la route `/public/ai-lab/:fixtureId` ne sélectionnait pas les colonnes
`studio_*` dans PostgreSQL.

La fonction recevait donc toujours :

- `studio_market_label = undefined`
- `studio_probability = undefined`
- `studio_snapshot = undefined`

Elle retombait automatiquement sur le scénario 1/X/2.

## Correction

La requête SQL sélectionne maintenant :

- `studio_market_key`
- `studio_market_label`
- `studio_probability`
- `studio_decision_score`
- `studio_decision_type`
- `studio_decision_grade`
- `studio_analysis_version`
- `studio_snapshot`
- `studio_saved_at`

La carte « Pourquoi cette prédiction ? » peut désormais expliquer le vrai marché
Brain Studio, par exemple « Plus de 2.5 buts à 98 % ».
