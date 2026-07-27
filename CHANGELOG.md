# Changelog — FootballBrain Backend v2.3

## Ajouté

- `core/explainability/decisionExplainability.js`
- Explication structurée de chaque décision FootballBrain.
- Classement des facteurs les plus influents.
- Distinction entre facteurs favorables et facteurs limitants.
- Mesure de l'accord entre FootballBrain et Monte Carlo.
- Conservation de l'explication dans l'historique local des prédictions.

## Inchangé

- Probabilités finales.
- Pondérations du moteur.
- Décision de pari.
- Routes Express.
- Schéma PostgreSQL.
- Frontend Base44.

## Note méthodologique

Les points d'influence sont des indicateurs relatifs calculés à partir de l'écart à une situation neutre et du poids de la source. Ils ne sont pas présentés comme des points de probabilité causaux.
