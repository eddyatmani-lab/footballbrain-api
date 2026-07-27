# Correctif v2.3.1 — Explainability

## Problème corrigé

Le moteur calculait bien `explainability` pendant l'analyse, mais la route publique
`/public/ai-lab/:fixtureId` ne renvoyait pas cette propriété au frontend.

La carte React recevait donc `null` et restait volontairement masquée.

## Correctif

La route publique reconstruit maintenant l'explication depuis les données déjà
enregistrées dans PostgreSQL :

- probabilités 1/X/2 ;
- poids forme, marché et Monte Carlo ;
- entrées des modèles ;
- confiance et risque ;
- cotes et value.

Le correctif fonctionne également pour les analyses déjà présentes dans la base :
il n'est pas nécessaire de relancer tous les matchs.
