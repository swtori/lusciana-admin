<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Exceptions\HttpException;
use App\Http\JsonResponse;
use App\Http\Request;
use App\Repositories\AgentRepository;
use App\Repositories\UserRepository;
use App\Services\AuthService;
use App\Support\MongoSerializer;
use App\Support\Roles;
use App\Support\Validator;
use MongoDB\BSON\UTCDateTime;

final class AgentsController
{
    public function __construct(
        private readonly AgentRepository $agents,
        private readonly UserRepository $users,
        private readonly AuthService $auth
    ) {
    }

    public function list(Request $request, array $params): JsonResponse
    {
        $user = $this->auth->authenticate($request);

        $filter = [];
        if (!empty($request->query['category'])) {
            $filter['category'] = (string) $request->query['category'];
        }

        $items = array_map(
            fn (array $item) => MongoSerializer::normalize($item),
            $this->agents->findAll($filter)
        );

        if (($user['role'] ?? null) === Roles::BUILDER) {
            $allowedAgentIds = array_map('strval', $user['assignedAgentIds'] ?? []);
            $items = array_values(array_filter($items, function (array $item) use ($allowedAgentIds): bool {
                return in_array((string) ($item['id'] ?? ''), $allowedAgentIds, true);
            }));
        }

        return new JsonResponse([
            'items' => $items,
        ]);
    }

    public function show(Request $request, array $params): JsonResponse
    {
        $user = $this->auth->authenticate($request);
        $item = $this->agents->findById($params['id']);

        if ($item === null) {
            throw new HttpException('Agent introuvable', 404);
        }

        $normalized = MongoSerializer::normalize($item);

        if (($user['role'] ?? null) === Roles::BUILDER) {
            $allowedAgentIds = array_map('strval', $user['assignedAgentIds'] ?? []);
            if (!in_array((string) ($normalized['id'] ?? ''), $allowedAgentIds, true)) {
                throw new HttpException('Acces refuse', 403);
            }
        }

        return new JsonResponse(['item' => $normalized]);
    }

    public function create(Request $request, array $params): JsonResponse
    {
        $this->auth->requireRole($request, Roles::MANAGER);
        Validator::requireFields($request->body, ['pseudo', 'category']);
        $category = (string) $request->body['category'];
        $pseudo = (string) $request->body['pseudo'];
        Validator::ensureInArray($category, [
            Roles::AGENT_CLIENT,
            Roles::AGENT_BUILDER,
            Roles::AGENT_MANAGER,
        ], 'category');

        if ($this->agents->findByPseudo($pseudo) !== null) {
            throw new HttpException('Ce pseudo existe deja', 409);
        }

        $now = new UTCDateTime();
        $id = $this->agents->insert([
            'pseudo' => $pseudo,
            'discord' => (string) ($request->body['discord'] ?? ''),
            'paymentMethods' => array_values($request->body['paymentMethods'] ?? []),
            'pf' => (string) ($request->body['pf'] ?? ''),
            'category' => $category,
            'commissionRate' => (float) ($request->body['commissionRate'] ?? 0),
            'memberSince' => (string) ($request->body['memberSince'] ?? ''),
            'isCompany' => (bool) ($request->body['isCompany'] ?? false),
            'iban' => (string) ($request->body['iban'] ?? ''),
            'country' => (string) ($request->body['country'] ?? ''),
            'address' => (string) ($request->body['address'] ?? ''),
            'companyName' => (string) ($request->body['companyName'] ?? ''),
            'createdAt' => $now,
            'updatedAt' => $now,
        ]);

        $credentials = null;
        if (in_array($category, [Roles::AGENT_BUILDER, Roles::AGENT_MANAGER], true)) {
            try {
                $agent = MongoSerializer::normalize($this->agents->findById($id));
                $credentials = $this->createLinkedUserForAgent($agent, $now);
            } catch (\Throwable $exception) {
                $this->agents->delete($id);
                throw $exception;
            }
        }

        return new JsonResponse([
            'message' => 'Agent cree',
            'item' => MongoSerializer::normalize($this->agents->findById($id)),
            'credentials' => $credentials,
        ], 201);
    }

    public function update(Request $request, array $params): JsonResponse
    {
        $currentUser = $this->auth->authenticate($request);
        $agent = $this->agents->findById($params['id']);
        if ($agent === null) {
            throw new HttpException('Agent introuvable', 404);
        }

        $normalizedAgent = MongoSerializer::normalize($agent);
        $isSelfUpdate = $this->isSelfAgentUpdate($currentUser, $normalizedAgent);

        if (!$isSelfUpdate) {
            $this->auth->requireRole($request, Roles::MANAGER);
        }

        $payload = $request->body;
        if ($isSelfUpdate) {
            $payload = array_intersect_key($payload, array_flip([
                'discord',
                'paymentMethods',
                'pf',
                'memberSince',
                'isCompany',
                'iban',
                'country',
                'address',
                'companyName',
            ]));
        }

        if (isset($payload['category'])) {
            Validator::ensureInArray((string) $payload['category'], [
                Roles::AGENT_CLIENT,
                Roles::AGENT_BUILDER,
                Roles::AGENT_MANAGER,
            ], 'category');
        }

        if (!empty($payload['pseudo'])) {
            $existing = $this->agents->findByPseudo((string) $payload['pseudo']);
            if ($existing !== null && (string) ($existing['_id'] ?? '') !== (string) ($agent['_id'] ?? '')) {
                throw new HttpException('Ce pseudo existe deja', 409);
            }
        }

        if ($payload === []) {
            throw new HttpException('Aucune modification fournie', 422);
        }

        $payload['updatedAt'] = new UTCDateTime();

        if (!$this->agents->update($params['id'], $payload)) {
            throw new HttpException('Agent introuvable', 404);
        }

        $updatedAgent = MongoSerializer::normalize($this->agents->findById($params['id']));
        $this->syncLinkedUser($updatedAgent);

        return new JsonResponse([
            'message' => 'Agent mis a jour',
            'item' => $updatedAgent,
        ]);
    }

    public function delete(Request $request, array $params): JsonResponse
    {
        $this->auth->requireRole($request, Roles::MANAGER);

        if (!$this->agents->delete($params['id'])) {
            throw new HttpException('Agent introuvable', 404);
        }

        $this->users->deleteByAgentId($params['id']);

        return new JsonResponse(['message' => 'Agent supprime']);
    }

    private function createLinkedUserForAgent(array $agent, UTCDateTime $now): ?array
    {
        $agentId = (string) ($agent['id'] ?? '');
        if ($agentId === '') {
            throw new HttpException('Agent introuvable', 404);
        }

        if ($this->users->findByAgentId($agentId) !== null) {
            throw new HttpException('Cet agent possede deja un compte', 409);
        }

        $email = $this->buildAgentEmail((string) ($agent['pseudo'] ?? ''));
        $role = (string) ($agent['category'] ?? '') === Roles::AGENT_MANAGER ? Roles::MANAGER : Roles::BUILDER;
        $existingUser = $this->users->findByEmail($email);

        if ($existingUser !== null) {
            $existingUserId = (string) ($existingUser['_id'] ?? '');
            $existingAgentId = (string) ($existingUser['agentId'] ?? '');
            $existingAssignedAgentIds = array_values(array_filter(
                array_map('strval', $existingUser['assignedAgentIds'] ?? []),
                static fn (string $value): bool => $value !== ''
            ));
            $existingRole = (string) ($existingUser['role'] ?? '');

            if ($existingAgentId !== '' || $existingAssignedAgentIds !== []) {
                throw new HttpException('Cet email existe deja', 409);
            }

            if ($existingRole !== $role) {
                throw new HttpException('Un compte avec cet email existe deja avec un role incompatible', 409);
            }

            if ($existingUserId === '') {
                throw new HttpException('Utilisateur introuvable', 404);
            }

            $this->users->update($existingUserId, [
                'name' => (string) ($agent['pseudo'] ?? ''),
                'email' => $email,
                'role' => $role,
                'agentId' => $agentId,
                'assignedAgentIds' => [$agentId],
                'updatedAt' => $now,
            ]);

            return null;
        }

        $plainPassword = $this->generateInitialPassword();

        $this->users->insert([
            'name' => (string) ($agent['pseudo'] ?? ''),
            'email' => $email,
            'passwordHash' => password_hash($plainPassword, PASSWORD_BCRYPT),
            'role' => $role,
            'isActive' => true,
            'tokenVersion' => 0,
            'assignedAgentIds' => [$agentId],
            'agentId' => $agentId,
            'lastLoginAt' => null,
            'createdAt' => $now,
            'updatedAt' => $now,
        ]);

        return [
            'email' => $email,
            'password' => $plainPassword,
        ];
    }

    private function isSelfAgentUpdate(array $user, array $agent): bool
    {
        $linkedAgentId = (string) ($user['agentId'] ?? '');
        if ($linkedAgentId === '') {
            return false;
        }

        return $linkedAgentId === (string) ($agent['id'] ?? '');
    }

    private function syncLinkedUser(array $agent): void
    {
        $linkedUser = $this->users->findByAgentId((string) ($agent['id'] ?? ''));
        if ($linkedUser === null) {
            return;
        }

        $category = (string) ($agent['category'] ?? '');
        if (!in_array($category, [Roles::AGENT_BUILDER, Roles::AGENT_MANAGER], true)) {
            return;
        }

        $role = $category === Roles::AGENT_MANAGER ? Roles::MANAGER : Roles::BUILDER;
        $email = $this->buildAgentEmail((string) ($agent['pseudo'] ?? ''));

        $this->users->update((string) $linkedUser['_id'], [
            'name' => (string) ($agent['pseudo'] ?? ''),
            'email' => $email,
            'role' => $role,
            'agentId' => (string) ($agent['id'] ?? ''),
            'assignedAgentIds' => [(string) ($agent['id'] ?? '')],
            'updatedAt' => new UTCDateTime(),
        ]);
    }

    private function buildAgentEmail(string $pseudo): string
    {
        $localPart = strtolower(trim($pseudo));
        $localPart = preg_replace('/[^a-z0-9._-]+/i', '.', $localPart) ?? '';
        $localPart = trim($localPart, '.');

        if ($localPart === '') {
            throw new HttpException('Le pseudo ne permet pas de generer un email valide', 422);
        }

        return $localPart . '@lusciana.fr';
    }

    private function generateInitialPassword(): string
    {
        return 'Lus!' . strtoupper(bin2hex(random_bytes(4))) . '9a';
    }
}
