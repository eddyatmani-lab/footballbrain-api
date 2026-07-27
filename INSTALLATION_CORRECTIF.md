# Installation du correctif v2.3.1

1. Décompresse le ZIP.
2. Copie son contenu dans le dossier `footballbrain-api`.
3. Accepte le remplacement de `index.js`.
4. Ne remplace pas ton fichier `.env`.
5. Exécute :

```bash
npm run check
git add .
git commit -m "Fix explainability public route"
git push
```

Après le redéploiement Railway :

1. ouvre directement `/public/ai-lab/ID_DU_MATCH`;
2. recherche `prediction.explainability` dans la réponse ;
3. recharge la page Base44 avec `Ctrl + F5`.

Le fichier frontend v2.4 déjà installé n'a pas besoin d'être modifié.
