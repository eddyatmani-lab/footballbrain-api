# Correctif v2.3.2 — vraie décision FootballBrain

## Problème
La carte « Pourquoi cette prédiction ? » expliquait le favori 1/X/2, même lorsque la décision principale Brain Studio était un autre marché (par exemple Plus de 2.5 buts).

## Correction
La carte utilise maintenant en priorité :
- `studio_market_label` ;
- `studio_probability` ;
- `studio_decision_score` ;
- le marché principal contenu dans `studio_snapshot`.

Elle n'utilise l'explication 1/X/2 qu'en solution de secours lorsqu'aucune décision Brain Studio n'est disponible.
