# Backend Lusciana

Backend PHP pour Lusciana avec MongoDB, JWT et runtime base sur Caddy via `FrankenPHP`.

## Pourquoi FrankenPHP

Tu voulais PHP et Caddy pour le backend. `Caddy` seul ne sait pas executer du PHP.  
La solution retenue est donc `FrankenPHP`, qui est base sur Caddy et execute PHP nativement dans un seul conteneur.

## Stack

- `PHP 8.3`
- `MongoDB`
- `firebase/php-jwt`
- `mongodb/mongodb`
- `vlucas/phpdotenv`
- `Caddy + FrankenPHP`

## Roles

- `guest` : lecture seule
- `builder` : consultation de ses commissions assignees
- `manager` : gestion agents, commissions et depenses
- `admin` : gestion des utilisateurs et administration metier
- `superadmin` : acces total

Les roles utilisateurs sont separes des categories metier d'un agent : `client`, `builder`, `manager`.

## Structure

- `public/index.php` : front controller
- `src/App.php` : bootstrap applicatif et enregistrement des routes
- `src/Controllers/*` : endpoints API
- `src/Repositories/*` : acces MongoDB
- `src/Services/*` : auth, JWT
- `Caddyfile` : configuration Caddy/FrankenPHP

## Configuration

Copie `.env.example` vers `.env`.

## Dependances

```bash
composer install
```

## Endpoints principaux

- `GET /api/health`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `POST /api/auth/change-password`
- `GET /api/users`
- `POST /api/users`
- `PATCH /api/users/:id`
- `GET /api/agents`
- `POST /api/agents`
- `PATCH /api/agents/:id`
- `GET /api/commissions`
- `POST /api/commissions`
- `PATCH /api/commissions/:id`
- `GET /api/expenses`
- `POST /api/expenses`

## MongoDB

URI attendue :

```env
MONGODB_URI=mongodb://luna:btKXJg5cSrdh6hWY04PslfyuXsAOhB@mongodb:27017/lusciana?authSource=admin
```

## Superadmin initial

Le backend cree automatiquement le compte `superadmin` defini dans `.env` s'il n'existe pas encore.

## Limites actuelles

- le front n'est pas encore branche sur cette API
- il faudra ensuite remplacer le `localStorage` du front par des appels HTTP
