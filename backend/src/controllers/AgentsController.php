<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Exceptions\HttpException;
use App\Http\JsonResponse;
use App\Http\Request;
use App\Repositories\AgentRepository;
use App\Services\AuthService;
use App\Support\MongoSerializer;
use App\Support\Roles;
use App\Support\Validator;
use MongoDB\BSON\UTCDateTime;

final class AgentsController
{
    public function __construct(
        private readonly AgentRepository $agents,
        private readonly AuthService $auth
    ) {
    }

    public function list(Request $request, array $params): JsonResponse
    {
        $this->auth->authenticate($request);

        $filter = [];
        if (!empty($request->query['category'])) {
            $filter['category'] = (string) $request->query['category'];
        }

        return new JsonResponse([
            'items' => array_map(
                fn (array $item) => MongoSerializer::normalize($item),
                $this->agents->findAll($filter)
            ),
        ]);
    }

    public function show(Request $request, array $params): JsonResponse
    {
        $this->auth->authenticate($request);
        $item = $this->agents->findById($params['id']);

        if ($item === null) {
            throw new HttpException('Agent introuvable', 404);
        }

        return new JsonResponse(['item' => MongoSerializer::normalize($item)]);
    }

    public function create(Request $request, array $params): JsonResponse
    {
        $this->auth->requireRole($request, Roles::MANAGER);
        Validator::requireFields($request->body, ['pseudo', 'category']);
        Validator::ensureInArray((string) $request->body['category'], [
            Roles::AGENT_CLIENT,
            Roles::AGENT_BUILDER,
            Roles::AGENT_MANAGER,
        ], 'category');

        if ($this->agents->findByPseudo((string) $request->body['pseudo']) !== null) {
            throw new HttpException('Ce pseudo existe deja', 409);
        }

        $now = new UTCDateTime();
        $id = $this->agents->insert([
            'pseudo' => (string) $request->body['pseudo'],
            'discord' => (string) ($request->body['discord'] ?? ''),
            'paymentMethods' => array_values($request->body['paymentMethods'] ?? []),
            'pf' => (string) ($request->body['pf'] ?? ''),
            'category' => (string) $request->body['category'],
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

        return new JsonResponse([
            'message' => 'Agent cree',
            'item' => MongoSerializer::normalize($this->agents->findById($id)),
        ], 201);
    }

    public function update(Request $request, array $params): JsonResponse
    {
        $this->auth->requireRole($request, Roles::MANAGER);

        $payload = $request->body;
        if (isset($payload['category'])) {
            Validator::ensureInArray((string) $payload['category'], [
                Roles::AGENT_CLIENT,
                Roles::AGENT_BUILDER,
                Roles::AGENT_MANAGER,
            ], 'category');
        }

        $payload['updatedAt'] = new UTCDateTime();

        if (!$this->agents->update($params['id'], $payload)) {
            throw new HttpException('Agent introuvable', 404);
        }

        return new JsonResponse([
            'message' => 'Agent mis a jour',
            'item' => MongoSerializer::normalize($this->agents->findById($params['id'])),
        ]);
    }

    public function delete(Request $request, array $params): JsonResponse
    {
        $this->auth->requireRole($request, Roles::ADMIN);

        if (!$this->agents->delete($params['id'])) {
            throw new HttpException('Agent introuvable', 404);
        }

        return new JsonResponse(['message' => 'Agent supprime']);
    }
}
