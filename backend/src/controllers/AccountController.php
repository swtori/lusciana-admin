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
use MongoDB\BSON\UTCDateTime;

final class AccountController
{
    public function __construct(
        private readonly AgentRepository $agents,
        private readonly UserRepository $users,
        private readonly AuthService $auth
    ) {
    }

    public function show(Request $request, array $params): JsonResponse
    {
        [$user, $agent] = $this->resolveLinkedAccount($request);

        return new JsonResponse([
            'user' => $user,
            'agent' => $agent,
            'loginEmail' => $this->buildAgentEmail((string) ($agent['pseudo'] ?? '')),
        ]);
    }

    public function update(Request $request, array $params): JsonResponse
    {
        [$user, $agent] = $this->resolveLinkedAccount($request);
        $payload = array_intersect_key($request->body, array_flip([
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

        if ($payload === []) {
            throw new HttpException('Aucune modification fournie', 422);
        }

        $payload['updatedAt'] = new UTCDateTime();
        $this->agents->update((string) $agent['id'], $payload);

        $updatedAgent = MongoSerializer::normalize($this->agents->findById((string) $agent['id']));
        $updatedUserPayload = [
            'name' => (string) ($updatedAgent['pseudo'] ?? ''),
            'email' => $this->buildAgentEmail((string) ($updatedAgent['pseudo'] ?? '')),
            'updatedAt' => new UTCDateTime(),
            'agentId' => (string) ($updatedAgent['id'] ?? ''),
            'assignedAgentIds' => [(string) ($updatedAgent['id'] ?? '')],
        ];

        $this->users->update((string) $user['id'], $updatedUserPayload);
        $updatedUser = $this->auth->publicUser($this->users->findById((string) $user['id']));

        return new JsonResponse([
            'message' => 'Compte mis a jour',
            'user' => $updatedUser,
            'agent' => $updatedAgent,
            'loginEmail' => $updatedUserPayload['email'],
        ]);
    }

    private function resolveLinkedAccount(Request $request): array
    {
        $user = $this->auth->authenticate($request);
        $agentId = (string) ($user['agentId'] ?? '');

        if ($agentId === '' && count($user['assignedAgentIds'] ?? []) === 1) {
            $agentId = (string) ($user['assignedAgentIds'][0] ?? '');
        }

        if ($agentId === '') {
            throw new HttpException('Aucun agent n est lie a ce compte', 404);
        }

        $agent = $this->agents->findById($agentId);
        if ($agent === null) {
            throw new HttpException('Agent introuvable', 404);
        }

        return [$user, MongoSerializer::normalize($agent)];
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
}
