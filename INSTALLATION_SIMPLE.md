# Installation simple — Backend v2.3 Explainability

Cette version ajoute le moteur qui explique les décisions de FootballBrain.
Elle ne change pas les calculs de probabilités ni les routes existantes.

## Ce que tu dois faire

1. Ferme ton éditeur de code.
2. Fais une copie de sauvegarde de ton dossier `footballbrain-api` actuel.
3. Décompresse ce ZIP.
4. Ouvre le dossier décompressé.
5. Copie **tout son contenu** dans ton dossier `footballbrain-api` actuel.
6. Accepte le remplacement de `index.js`.
7. Ne remplace et ne supprime pas ton fichier `.env` personnel.
8. Ouvre le terminal dans `footballbrain-api` et lance :

```bash
npm install
npm run check
git add .
git commit -m "FootballBrain v2.3 explainability"
git push
```

## Vérification

Après le redéploiement Railway :

1. Vérifie `/health`.
2. Ouvre une analyse existante.
3. Dans la réponse JSON, `footballBrainDecision` doit maintenant contenir :

```text
explainability
```

avec notamment :

- `headline`
- `summary`
- `topFactors`
- `supportingFactors`
- `limitingFactors`
- `sourceAgreement`

## Retour arrière

Remets simplement la sauvegarde de ton ancien dossier puis refais :

```bash
git add .
git commit -m "Rollback v2.3"
git push
```
