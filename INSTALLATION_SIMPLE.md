# Installation simple

Ne supprime pas ton dossier Git actuel.

1. Fais une copie de sauvegarde de ton dossier `footballbrain-api`.
2. Décompresse ce ZIP.
3. Copie tous les fichiers du dossier décompressé dans ton dossier `footballbrain-api` actuel et accepte le remplacement.
4. Ne supprime pas ton fichier `.env`.
5. Ouvre le terminal dans `footballbrain-api` et exécute :

```bash
npm install
npm run check
git add .
git commit -m "Football AI Pro backend v2.2"
git push
```

Après Railway : teste `/health`, puis `/internal/test-ai-event/1532840`, puis `/public/ai-timeline/1532840`.
