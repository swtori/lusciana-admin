<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Exceptions\HttpException;
use App\Http\JsonResponse;
use App\Http\Request;
use App\Repositories\ExpenseRepository;
use App\Services\AuthService;
use App\Support\MongoSerializer;
use App\Support\Roles;
use App\Support\Validator;
use MongoDB\BSON\UTCDateTime;

final class ExpensesController
{
    public function __construct(
        private readonly ExpenseRepository $expenses,
        private readonly AuthService $auth
    ) {
    }

    public function list(Request $request, array $params): JsonResponse
    {
        $this->auth->authenticate($request);

        return new JsonResponse([
            'items' => array_map(
                fn (array $item) => MongoSerializer::normalize($item),
                $this->expenses->findAll()
            ),
        ]);
    }

    public function create(Request $request, array $params): JsonResponse
    {
        $user = $this->auth->requireRole($request, Roles::MANAGER);
        Validator::requireFields($request->body, ['label', 'amount', 'date']);

        $now = new UTCDateTime();
        $id = $this->expenses->insert([
            'label' => (string) $request->body['label'],
            'amount' => (float) $request->body['amount'],
            'currency' => strtoupper((string) ($request->body['currency'] ?? 'EUR')),
            'date' => (string) $request->body['date'],
            'createdBy' => $user['id'],
            'createdAt' => $now,
            'updatedAt' => $now,
        ]);

        return new JsonResponse([
            'message' => 'Depense creee',
            'item' => MongoSerializer::normalize($this->expenses->findById($id)),
        ], 201);
    }

    public function update(Request $request, array $params): JsonResponse
    {
        $this->auth->requireRole($request, Roles::MANAGER);
        $payload = $request->body;
        $payload['updatedAt'] = new UTCDateTime();

        if (!$this->expenses->update($params['id'], $payload)) {
            throw new HttpException('Depense introuvable', 404);
        }

        return new JsonResponse([
            'message' => 'Depense mise a jour',
            'item' => MongoSerializer::normalize($this->expenses->findById($params['id'])),
        ]);
    }

    public function delete(Request $request, array $params): JsonResponse
    {
        $this->auth->requireRole($request, Roles::MANAGER);

        if (!$this->expenses->delete($params['id'])) {
            throw new HttpException('Depense introuvable', 404);
        }

        return new JsonResponse(['message' => 'Depense supprimee']);
    }
}
