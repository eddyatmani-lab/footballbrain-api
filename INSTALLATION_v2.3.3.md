# Installation

1. Décompresse le ZIP.
2. Copie tout son contenu dans ton dossier `footballbrain-api`.
3. Accepte le remplacement de `index.js`.
4. Ne touche pas au fichier `.env`.
5. Exécute :

```bash
npm run check
git add .
git commit -m "Fix studio columns in ai lab route"
git push
```

Après le redéploiement Railway :

1. Recharge la page avec `Ctrl + F5`.
2. Ouvre un match dont la décision FootballBrain est « Plus de 2.5 buts ».
3. La carte doit afficher « Pourquoi Plus de 2.5 buts à ... % ? ».

Aucune nouvelle modification Base44 n'est nécessaire.
