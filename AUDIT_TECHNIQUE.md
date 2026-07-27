# Audit technique — Football AI Pro Backend

## État général

- `index.js` reçu : **14710 lignes**.
- Routes Express détectées : **68**.
- Fonctions nommées détectées : **98**.
- Appels directs `pool.query(...)` : **56**.
- Utilisations d’API-Football via `callApiFootball(...)` : **52**.
- Tables créées depuis le code : **7**.

## Risques prioritaires constatés

1. **Routes en double.** Plusieurs blocs du backend ont été recopiés dans `index.js`.
2. **`node_modules` est suivi par Git.** Environ 928 fichiers sont suivis dans ce dossier.
3. **Aucun test automatisé.** Le script `test` d’origine échouait volontairement.
4. **La base de données et API-Football restent fortement concentrées dans `index.js`.**
5. **Des routes internes sensibles déclenchent des migrations ou reconstructions via GET.**

## Routes dupliquées détectées

- `GET /` : 2 occurrences, lignes 151, 4561.
- `GET /health` : 2 occurrences, lignes 159, 4569.
- `GET /timezone` : 2 occurrences, lignes 172, 4582.
- `GET /fixtures` : 2 occurrences, lignes 224, 4634.
- `GET /fixtures-test` : 2 occurrences, lignes 344, 4754.
- `GET /leagues` : 2 occurrences, lignes 361, 4771.
- `GET /status` : 2 occurrences, lignes 375, 4785.
- `GET /internal/match/:fixtureId` : 2 occurrences, lignes 395, 4805.
- `GET /internal/match/:fixtureId/context` : 2 occurrences, lignes 474, 4884.
- `GET /internal/lineups/:fixtureId` : 2 occurrences, lignes 1342, 5124.
- `GET /internal/predictions/:fixtureId` : 2 occurrences, lignes 1365, 5147.
- `GET /internal/history` : 2 occurrences, lignes 2039, 5436.
- `GET /internal/stats` : 2 occurrences, lignes 2060, 5457.
- `GET /internal/db-test` : 2 occurrences, lignes 2459, 5875.
- `GET /internal/db-init` : 2 occurrences, lignes 2589, 5904.
- `GET /internal/elo/process/:fixtureId` : 2 occurrences, lignes 3426, 6219.
- `GET /internal/team/:apiTeamId` : 4 occurrences, lignes 3479, 3524, 6272, 6317.
- `GET /internal/elo-rankings` : 2 occurrences, lignes 3569, 6362.
- `GET /internal/cron/update-results` : 2 occurrences, lignes 4000, 7316.
- `GET /public/analysis/:fixtureId` : 3 occurrences, lignes 4042, 7354, 7433.
- `GET /test-fixtures` : 2 occurrences, lignes 4462, 8087.

## Modification effectuée dans la v2.2

- Extraction de l’Event Engine dans `core/events/eventEngine.js`.
- Extraction de ses routes dans `routes/aiEventRoutes.js`.
- Conservation des mêmes URL et réponses JSON.
- Ajout de `npm start` et `npm run check`.
- Renforcement de `.gitignore`.
- Aucun calcul de pronostic n’a été changé.

## Étape suivante

La v2.3 devra comparer puis supprimer progressivement les blocs dupliqués, sans suppression automatique massive.
