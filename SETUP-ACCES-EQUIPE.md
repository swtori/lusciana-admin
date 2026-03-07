# Accès équipe – Configuration

## 1. Règles Realtime Database

Dans **Firebase Console** → **Realtime Database** → onglet **Règles**, remplace tout par le contenu de `firebase-database-rules.json` (ou copie-colle ci-dessous), puis **Publier**.

```json
{
  "rules": {
    "admins": {
      ".read": "auth != null",
      ".write": "root.child('admins').child(auth.uid).exists()"
    },
    "allowedUsers": {
      ".read": "auth != null",
      ".write": "root.child('admins').child(auth.uid).exists()"
    },
    "agents": {
      ".read": "auth != null && root.child('allowedUsers').child(auth.uid).exists()",
      ".write": "auth != null && root.child('allowedUsers').child(auth.uid).exists()"
    },
    "commissions": {
      ".read": "auth != null && root.child('allowedUsers').child(auth.uid).exists()",
      ".write": "auth != null && root.child('allowedUsers').child(auth.uid).exists()"
    },
    "analystExpenses": {
      ".read": "auth != null && root.child('allowedUsers').child(auth.uid).exists()",
      ".write": "auth != null && root.child('allowedUsers').child(auth.uid).exists()"
    }
  }
}
```

## 2. Premier administrateur (toi)

Comme au début personne n’est dans `admins`, il faut ajouter **manuellement** ton compte une première fois :

1. Connecte-toi une fois à l’app (Google ou email). Tu verras **« Accès refusé »** avec ton **identifiant (UID)**. Copie cet UID.
2. Va dans **Firebase Console** → **Realtime Database** → onglet **Données**.
3. Clique sur **+** à la racine → nom de la clé : `admins` → type : Objet.
4. Dans `admins`, ajoute une clé dont le **nom** est ton UID (collé) et la **valeur** : `true`.
5. Ajoute aussi ton UID dans `allowedUsers` : clé `allowedUsers` → enfant avec ton UID comme nom, valeur par ex. `{ "email": "ton@email.com", "addedAt": 0 }` (ou laisse un objet vide si tu veux).

Après ça, reconnecte-toi à l’app : tu auras accès et tu verras l’onglet **« Gestion de l’équipe »**.

## 3. Qui peut faire quoi

- **allowedUsers** : toute personne listée peut ouvrir l’app et utiliser les commissions/agents/données.
- **admins** : en plus, peuvent **ajouter** et **révoquer** des membres dans « Gestion de l’équipe ».
- Révoquer = retirer l’UID de `allowedUsers` → la personne ne peut plus accéder à l’app (elle verra « Accès refusé » à chaque connexion).
- Pour **supprimer définitivement** un compte (il ne peut plus se connecter nulle part) : Firebase Console → **Authentication** → **Utilisateurs** → supprimer l’utilisateur.

## 4. Résumé du flux

1. Nouvelle personne : elle se connecte (Google ou email) → voit « Accès refusé » et son UID.
2. Elle envoie son UID à un admin.
3. L’admin va dans **Gestion de l’équipe** → **Ajouter un membre** → colle l’UID (et optionnellement l’email) → **Ajouter**.
4. La personne rafraîchit la page : elle a accès.
5. Pour la retirer : **Révoquer** à côté de son nom → elle ne peut plus entrer.
