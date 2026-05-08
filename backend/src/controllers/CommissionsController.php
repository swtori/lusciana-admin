<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Exceptions\HttpException;
use App\Http\JsonResponse;
use App\Http\Request;
use App\Repositories\AgentRepository;
use App\Repositories\CommissionRepository;
use App\Services\AuthService;
use App\Support\MongoSerializer;
use App\Support\Roles;
use App\Support\Validator;
use MongoDB\BSON\UTCDateTime;

final class CommissionsController
{
    public function __construct(
        private readonly CommissionRepository $commissions,
        private readonly AgentRepository $agents,
        private readonly AuthService $auth
    ) {
    }

    public function list(Request $request, array $params): JsonResponse
    {
        $user = $this->auth->authenticate($request);
        $items = array_map(
            fn (array $item) => MongoSerializer::normalize($item),
            $this->commissions->findAll()
        );

        if ($user['role'] === Roles::BUILDER) {
            $allowedPseudos = [];
            foreach (($user['assignedAgentIds'] ?? []) as $agentId) {
                $agent = $this->agents->findById((string) $agentId);
                if ($agent !== null) {
                    $allowedPseudos[] = (string) ($agent['pseudo'] ?? '');
                }
            }

            $items = array_values(array_filter($items, function (array $item) use ($allowedPseudos): bool {
                $selected = $item['selectedAgents'] ?? [];
                $realized = $item['realizedBy'] ?? [];
                return count(array_intersect($allowedPseudos, $selected)) > 0
                    || count(array_intersect($allowedPseudos, $realized)) > 0;
            }));
        }

        return new JsonResponse(['items' => $items]);
    }

    public function show(Request $request, array $params): JsonResponse
    {
        $user = $this->auth->authenticate($request);
        $item = $this->commissions->findById($params['id']);

        if ($item === null) {
            throw new HttpException('Commission introuvable', 404);
        }

        $normalized = MongoSerializer::normalize($item);

        if ($user['role'] === Roles::BUILDER) {
            $allowedPseudos = [];
            foreach (($user['assignedAgentIds'] ?? []) as $agentId) {
                $agent = $this->agents->findById((string) $agentId);
                if ($agent !== null) {
                    $allowedPseudos[] = (string) ($agent['pseudo'] ?? '');
                }
            }

            $selected = $normalized['selectedAgents'] ?? [];
            $realized = $normalized['realizedBy'] ?? [];

            if (count(array_intersect($allowedPseudos, $selected)) === 0
                && count(array_intersect($allowedPseudos, $realized)) === 0) {
                throw new HttpException('Acces refuse', 403);
            }
        }

        return new JsonResponse(['item' => $normalized]);
    }

    public function create(Request $request, array $params): JsonResponse
    {
        $user = $this->auth->requireRole($request, Roles::MANAGER);

        Validator::requireFields($request->body, ['buildSize', 'buildName', 'worldName', 'price']);

        $now = new UTCDateTime();
        $id = $this->commissions->insert([
            'buildSize' => (string) $request->body['buildSize'],
            'buildName' => (string) $request->body['buildName'],
            'worldName' => (string) $request->body['worldName'],
            'realizedBy' => array_values($request->body['realizedBy'] ?? []),
            'version' => (string) ($request->body['version'] ?? ''),
            'forCustomer' => (string) ($request->body['forCustomer'] ?? 'yes'),
            'price' => (float) $request->body['price'],
            'buildStart' => (string) ($request->body['buildStart'] ?? ''),
            'buildEnd' => (string) ($request->body['buildEnd'] ?? ''),
            'depositPaid' => (string) ($request->body['depositPaid'] ?? 'no'),
            'depositAmount' => (float) ($request->body['depositAmount'] ?? 0),
            'buildType' => (string) ($request->body['buildType'] ?? ''),
            'organics' => (string) ($request->body['organics'] ?? ''),
            'selectedAgents' => array_values($request->body['selectedAgents'] ?? []),
            'priceDistribution' => $request->body['priceDistribution'] ?? [],
            'commissionPercent' => (float) ($request->body['commissionPercent'] ?? 0),
            'wentWell' => (string) ($request->body['wentWell'] ?? 'yes'),
            'clientName' => (string) ($request->body['clientName'] ?? ''),
            'clientWants' => (string) ($request->body['clientWants'] ?? ''),
            'hasFeedback' => (string) ($request->body['hasFeedback'] ?? 'no'),
            'clientFeedback' => (string) ($request->body['clientFeedback'] ?? ''),
            'render' => (string) ($request->body['render'] ?? ''),
            'showcaseText' => (string) ($request->body['showcaseText'] ?? ''),
            'createdBy' => $user['id'],
            'createdAt' => $now,
            'updatedAt' => $now,
        ]);

        return new JsonResponse([
            'message' => 'Commission creee',
            'item' => MongoSerializer::normalize($this->commissions->findById($id)),
        ], 201);
    }

    public function update(Request $request, array $params): JsonResponse
    {
        $this->auth->requireRole($request, Roles::MANAGER);
        $payload = $request->body;
        $payload['updatedAt'] = new UTCDateTime();

        if (!$this->commissions->update($params['id'], $payload)) {
            throw new HttpException('Commission introuvable', 404);
        }

        return new JsonResponse([
            'message' => 'Commission mise a jour',
            'item' => MongoSerializer::normalize($this->commissions->findById($params['id'])),
        ]);
    }

    public function delete(Request $request, array $params): JsonResponse
    {
        $this->auth->requireRole($request, Roles::ADMIN);

        if (!$this->commissions->delete($params['id'])) {
            throw new HttpException('Commission introuvable', 404);
        }

        return new JsonResponse(['message' => 'Commission supprimee']);
    }
}
