<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Exceptions\HttpException;
use App\Http\JsonResponse;
use App\Http\Request;
use App\Repositories\UserRepository;
use App\Services\AuthService;
use App\Support\MongoSerializer;
use App\Support\Roles;
use App\Support\Validator;
use MongoDB\BSON\UTCDateTime;

final class UsersController
{
    public function __construct(
        private readonly UserRepository $users,
        private readonly AuthService $auth
    ) {
    }

    public function list(Request $request, array $params): JsonResponse
    {
        $this->auth->requireRole($request, Roles::ADMIN);

        $items = array_map(
            fn (array $user) => $this->auth->publicUser($user),
            $this->users->findAll()
        );

        return new JsonResponse(['items' => $items]);
    }

    public function create(Request $request, array $params): JsonResponse
    {
        $actor = $this->auth->requireRole($request, Roles::ADMIN);

        Validator::requireFields($request->body, ['name', 'email', 'password', 'role']);
        Validator::ensureEmail((string) $request->body['email']);
        Validator::ensureInArray((string) $request->body['role'], Roles::all(), 'role');

        if ($request->body['role'] === Roles::SUPERADMIN && $actor['role'] !== Roles::SUPERADMIN) {
            throw new HttpException('Seul un superadmin peut creer un superadmin', 403);
        }

        if ($this->users->findByEmail((string) $request->body['email']) !== null) {
            throw new HttpException('Cet email existe deja', 409);
        }

        $now = new UTCDateTime();
        $id = $this->users->insert([
            'name' => (string) $request->body['name'],
            'email' => strtolower((string) $request->body['email']),
            'passwordHash' => password_hash((string) $request->body['password'], PASSWORD_BCRYPT),
            'role' => (string) $request->body['role'],
            'isActive' => (bool) ($request->body['isActive'] ?? true),
            'tokenVersion' => 0,
            'assignedAgentIds' => array_values($request->body['assignedAgentIds'] ?? []),
            'lastLoginAt' => null,
            'createdAt' => $now,
            'updatedAt' => $now,
        ]);

        return new JsonResponse([
            'message' => 'Utilisateur cree',
            'item' => $this->auth->publicUser($this->users->findById($id)),
        ], 201);
    }

    public function update(Request $request, array $params): JsonResponse
    {
        $actor = $this->auth->requireRole($request, Roles::ADMIN);
        $user = $this->users->findById($params['id']);

        if ($user === null) {
            throw new HttpException('Utilisateur introuvable', 404);
        }

        $normalized = MongoSerializer::normalize($user);

        if (($normalized['role'] ?? null) === Roles::SUPERADMIN && $actor['role'] !== Roles::SUPERADMIN) {
            throw new HttpException('Seul un superadmin peut modifier ce compte', 403);
        }

        if (isset($request->body['role'])) {
            Validator::ensureInArray((string) $request->body['role'], Roles::all(), 'role');

            if ($request->body['role'] === Roles::SUPERADMIN && $actor['role'] !== Roles::SUPERADMIN) {
                throw new HttpException('Seul un superadmin peut attribuer ce role', 403);
            }
        }

        $payload = [];

        foreach (['name', 'email', 'role', 'isActive', 'assignedAgentIds'] as $field) {
            if (array_key_exists($field, $request->body)) {
                $payload[$field] = $field === 'email'
                    ? strtolower((string) $request->body[$field])
                    : $request->body[$field];
            }
        }

        if (!empty($request->body['password'])) {
            $payload['passwordHash'] = password_hash((string) $request->body['password'], PASSWORD_BCRYPT);
            $payload['tokenVersion'] = ((int) ($normalized['tokenVersion'] ?? 0)) + 1;
        }

        if ($payload === []) {
            throw new HttpException('Aucune modification fournie', 422);
        }

        $payload['updatedAt'] = new UTCDateTime();
        $this->users->update($params['id'], $payload);

        if (array_key_exists('passwordHash', $payload)) {
            $this->auth->invalidateSessions($params['id']);
        }

        return new JsonResponse([
            'message' => 'Utilisateur mis a jour',
            'item' => $this->auth->publicUser($this->users->findById($params['id'])),
        ]);
    }
}
