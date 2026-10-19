# Sac de Layon

Checklist de matériel pour les expéditions en Guyane. Tu dis où tu pars, combien de jours et à combien : l'appli calcule les quantités, le poids du sac, et prépare une fiche sécurité à envoyer à un proche.

**Ouvrir l'appli :** https://samueldagostino64-ai.github.io/sac-de-layon-/

- Gratuite, sans compte, sans publicité.
- Marche sans réseau après une première ouverture (service worker).
- Les données restent sur le téléphone (localStorage) : rien n'est envoyé à un serveur. La sauvegarde se fait en fichier, depuis Réglages.

## Contenu du dépôt

| Fichier | Rôle |
| --- | --- |
| `index.html` | Toute l'appli (HTML, CSS, JavaScript), sans étape de compilation |
| `sw.js` | Service worker : hors ligne, ouverture rapide en réseau faible |
| `fonts/` | Polices Barlow embarquées (licence SIL OFL, `fonts/OFL.txt`) |
| `jspdf.min.js` | jsPDF 2.5.1, pour l'export PDF de la liste |
| `tests/` | Tests de bout en bout (Chromium piloté par Playwright) |

## Publier une nouvelle version

1. Monter le numéro « version N » en bas de `index.html` et `CACHE` dans `sw.js` (un test vérifie qu'ils correspondent).
2. `npm install && npx playwright install chromium && npm test`
3. Fusionner dans `main` : GitHub Pages republie le site, les téléphones prennent la nouvelle version à l'ouverture suivante.
