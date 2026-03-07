# Règles Firebase Realtime Database

Dans la **Console Firebase** → **Realtime Database** → onglet **Règles**, remplace le contenu par :

```json
{
  "rules": {
    "agents": {
      ".read": "auth != null",
      ".write": "auth != null"
    },
    "commissions": {
      ".read": "auth != null",
      ".write": "auth != null"
    },
    "analystExpenses": {
      ".read": "auth != null",
      ".write": "auth != null"
    },
    "allowedEmails": {
      ".read": true,
      ".write": "auth != null"
    },
    "adminEmails": {
      ".read": "auth != null",
      ".write": "auth != null"
    }
  }
}
```

- **allowedEmails** : en lecture pour tous (pour que la page d’inscription puisse vérifier si un email peut créer un compte), en écriture pour les utilisateurs connectés (seuls les admins utilisent la page /admin).
- **adminEmails** : lecture et écriture réservées aux utilisateurs connectés (la page admin vérifie côté client si l’utilisateur est dans cette liste).

Puis clique sur **Publier**.
