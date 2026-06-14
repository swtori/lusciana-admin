<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Exceptions\HttpException;
use App\Http\JsonResponse;
use App\Http\Request;
use App\Repositories\AgentRepository;
use App\Repositories\LoginEventRepository;
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
        private readonly AgentRepository $agents,
        private readonly LoginEventRepository $loginEvents,
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

        $loginEventsByUserId = $this->loginEvents->findRecentByUserIds(
            array_map(
                static fn (array $item): string => (string) ($item['id'] ?? ''),
                $items
            )
        );

        $items = array_map(function (array $item) use ($loginEventsByUserId): array {
            $item['recentLoginEvents'] = array_map(
                static fn (array $event): array => MongoSerializer::normalize($event),
                $loginEventsByUserId[(string) ($item['id'] ?? '')] ?? []
            );

            return $item;
        }, $items);

        return new JsonResponse(['items' => $items]);
    }

    public function create(Request $request, array $params): JsonResponse
    {
        $actor = $this->auth->requireRole($request, Roles::ADMIN);

        Validator::requireFields($request->body, ['name', 'email', 'password', 'role']);
        Validator::ensureInArray((string) $request->body['role'], Roles::all(), 'role');

        $role = (string) $request->body['role'];

        if ($role === Roles::SUPERADMIN && $actor['role'] !== Roles::SUPERADMIN) {
            throw new HttpException('Seul un superadmin peut creer un superadmin', 403);
        }

        $accountData = $this->buildAccountData($request->body, $role);

        if ($this->users->findByEmail($accountData['email']) !== null) {
            throw new HttpException('Cet email existe deja', 409);
        }

        if ($accountData['agentId'] !== null && $this->users->findByAgentId($accountData['agentId']) !== null) {
            throw new HttpException('Cet agent possede deja un compte', 409);
        }

        $now = new UTCDateTime();
        $id = $this->users->insert([
            'name' => $accountData['name'],
            'email' => $accountData['email'],
            'passwordHash' => password_hash((string) $request->body['password'], PASSWORD_BCRYPT),
            'role' => $role,
            'isActive' => (bool) ($request->body['isActive'] ?? true),
            'tokenVersion' => 0,
            'assignedAgentIds' => $accountData['assignedAgentIds'],
            'agentId' => $accountData['agentId'],
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

        $nextRole = (string) ($request->body['role'] ?? ($normalized['role'] ?? Roles::GUEST));
        $accountData = $this->buildAccountData($request->body, $nextRole, $normalized);

        $payload = [];

        foreach (['role', 'isActive'] as $field) {
            if (array_key_exists($field, $request->body)) {
                $payload[$field] = $request->body[$field];
            }
        }

        $payload['name'] = $accountData['name'];
        $payload['email'] = $accountData['email'];
        $payload['assignedAgentIds'] = $accountData['assignedAgentIds'];
        $payload['agentId'] = $accountData['agentId'];

        $existingLinkedUser = $accountData['agentId'] !== null
            ? $this->users->findByAgentId($accountData['agentId'])
            : null;

        if ($existingLinkedUser !== null && (string) ($existingLinkedUser['_id'] ?? '') !== (string) ($user['_id'] ?? '')) {
            throw new HttpException('Cet agent possede deja un compte', 409);
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

    private function buildAccountData(array $body, string $role, ?array $existingUser = null): array
    {
        if (in_array($role, [Roles::BUILDER, Roles::MANAGER], true)) {
            $agentId = $this->resolveAgentId($body, $existingUser);
            if ($agentId === null) {
                throw new HttpException('Un agent doit etre selectionne pour ce compte', 422);
            }

            $agent = $this->agents->findById($agentId);
            if ($agent === null) {
                throw new HttpException('Agent introuvable', 404);
            }

            $normalizedAgent = MongoSerializer::normalize($agent);
            $agentCategory = (string) ($normalizedAgent['category'] ?? '');
            $matchesRole = $role === Roles::MANAGER
                ? $agentCategory === Roles::AGENT_MANAGER
                : in_array($agentCategory, [Roles::AGENT_TRIAL, Roles::AGENT_APPRENTICE, Roles::AGENT_BUILDER], true);
            if (!$matchesRole) {
                throw new HttpException('La categorie de l agent ne correspond pas au role du compte', 422);
            }

            return [
                'name' => (string) ($normalizedAgent['pseudo'] ?? ''),
                'email' => $this->buildAgentEmail((string) ($normalizedAgent['pseudo'] ?? '')),
                'assignedAgentIds' => [(string) ($normalizedAgent['id'] ?? $agentId)],
                'agentId' => (string) ($normalizedAgent['id'] ?? $agentId),
            ];
        }

        $email = strtolower((string) ($body['email'] ?? ($existingUser['email'] ?? '')));
        Validator::ensureEmail($email);

        return [
            'name' => (string) ($body['name'] ?? ($existingUser['name'] ?? '')),
            'email' => $email,
            'assignedAgentIds' => array_values($body['assignedAgentIds'] ?? ($existingUser['assignedAgentIds'] ?? [])),
            'agentId' => null,
        ];
    }

    private function resolveAgentId(array $body, ?array $existingUser = null): ?string
    {
        if (!empty($body['agentId'])) {
            return (string) $body['agentId'];
        }

        $assignedAgentIds = array_values(array_filter(
            array_map('strval', $body['assignedAgentIds'] ?? []),
            static fn (string $value): bool => $value !== ''
        ));
        if (count($assignedAgentIds) === 1) {
            return $assignedAgentIds[0];
        }

        if (!empty($existingUser['agentId'])) {
            return (string) $existingUser['agentId'];
        }

        $existingAssignedAgentIds = array_values(array_filter(
            array_map('strval', $existingUser['assignedAgentIds'] ?? []),
            static fn (string $value): bool => $value !== ''
        ));

        return count($existingAssignedAgentIds) === 1 ? $existingAssignedAgentIds[0] : null;
    }

    private function buildAgentEmail(string $pseudo): string
    {
        $localPart = strtolower(trim($pseudo));
        $localPart = preg_replace('/[^a-z0-9._-]+/i', '.', $localPart) ?? '';
        $localPart = trim($localPart, '.');

        if ($localPart === '') {
            throw new HttpException('Le pseudo ne permet pas de generer un email valide', 422);
        }

        $email = $localPart . '@lusciana.fr';
        Validator::ensureEmail($email);

        return $email;
    }
}
