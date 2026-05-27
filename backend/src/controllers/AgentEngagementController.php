<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Exceptions\HttpException;
use App\Http\JsonResponse;
use App\Http\Request;
use App\Repositories\AgentRepository;
use App\Services\AgentEngagementService;
use App\Services\AuthService;
use App\Support\Roles;
use App\Support\Validator;

final class AgentEngagementController
{
    public function __construct(
        private readonly AgentRepository $agents,
        private readonly AgentEngagementService $engagement,
        private readonly AuthService $auth
    ) {
    }

    public function createEvent(Request $request, array $params): JsonResponse
    {
        $user = $this->auth->requireRole($request, Roles::MANAGER);
        Validator::requireFields($request->body, ['type']);

        $agentId = (string) ($params['id'] ?? '');
        if ($this->agents->findById($agentId) === null) {
            throw new HttpException('Agent introuvable', 404);
        }

        $item = $this->engagement->recordNegativeEvent(
            $agentId,
            $request->body,
            (string) ($user['id'] ?? '')
        );

        $summaries = $this->engagement->summariesForAgentIds([$agentId]);
        $summary = $summaries[$agentId] ?? null;

        return new JsonResponse([
            'message' => 'Evenement enregistre',
            'item' => $item,
            'engagement' => $summary,
        ], 201);
    }

    public function listEvents(Request $request, array $params): JsonResponse
    {
        $user = $this->auth->authenticate($request);
        $agentId = (string) ($params['id'] ?? '');

        $agent = $this->agents->findById($agentId);
        if ($agent === null) {
            throw new HttpException('Agent introuvable', 404);
        }

        if (($user['role'] ?? null) === Roles::BUILDER) {
            $allowed = array_map('strval', $user['assignedAgentIds'] ?? []);
            if (!in_array($agentId, $allowed, true)) {
                throw new HttpException('Acces refuse', 403);
            }
        }

        $items = $this->engagement->listEventsNormalized($agentId);
        $summaries = $this->engagement->summariesForAgentIds([$agentId]);

        return new JsonResponse([
            'items' => $items,
            'engagement' => $summaries[$agentId] ?? null,
        ]);
    }
}
