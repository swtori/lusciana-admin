# Lusciana Commission Manager

## Mise en ligne (GitHub Pages)

1. Pousse le repo sur GitHub (branch `main` ou `master`).
2. **Settings** → **Pages** → **Source** : *Deploy from a branch*.
3. Choisis la branche (ex. `main`) et le dossier **/ (root)**.
4. Sauvegarde. L’URL sera : `https://<ton-username>.github.io/textGen/commission_manager.html`

## Firebase (Realtime Database)

Les données sont synchronisées avec Firebase si la config est renseignée dans `commission_manager.html` :

- Firebase Console → **Paramètres du projet** (engrenage) → **Mes applications** → ajoute une app Web si besoin.
- Copie l’objet `firebaseConfig` et remplace celui dans le fichier (vers le début du `<script>`).

Sans config valide, l’app utilise uniquement le `localStorage` du navigateur.
