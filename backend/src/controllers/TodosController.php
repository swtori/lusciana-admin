<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Exceptions\HttpException;
use App\Http\JsonResponse;
use App\Http\Request;
use App\Repositories\TodoRepository;
use App\Services\AuthService;
use App\Support\MongoSerializer;
use App\Support\Roles;
use App\Support\Validator;
use MongoDB\BSON\UTCDateTime;

final class TodosController
{
    private const STATUSES = ['todo', 'in_progress', 'done'];

    public function __construct(
        private readonly TodoRepository $todos,
        private readonly AuthService $auth
    ) {
    }

    public function list(Request $request, array $params): JsonResponse
    {
        $this->auth->authenticate($request);

        return new JsonResponse([
            'items' => array_map(
                fn (array $item) => MongoSerializer::normalize($item),
                $this->todos->findAll()
            ),
        ]);
    }

    public function create(Request $request, array $params): JsonResponse
    {
        $user = $this->auth->requireRole($request, Roles::BUILDER);
        Validator::requireFields($request->body, ['title', 'status']);
        Validator::ensureInArray((string) $request->body['status'], self::STATUSES, 'status');

        $now = new UTCDateTime();
        $id = $this->todos->insert([
            'title' => trim((string) $request->body['title']),
            'description' => trim((string) ($request->body['description'] ?? '')),
            'status' => (string) $request->body['status'],
            'deadline' => trim((string) ($request->body['deadline'] ?? '')),
            'assignedTo' => trim((string) ($request->body['assignedTo'] ?? '')),
            'createdBy' => $user['id'],
            'createdByName' => (string) ($user['name'] ?? $user['email']),
            'updatedBy' => $user['id'],
            'updatedByName' => (string) ($user['name'] ?? $user['email']),
            'createdAt' => $now,
            'updatedAt' => $now,
        ]);

        return new JsonResponse([
            'message' => 'Tache creee',
            'item' => MongoSerializer::normalize($this->todos->findById($id)),
        ], 201);
    }

    public function update(Request $request, array $params): JsonResponse
    {
        $user = $this->auth->requireRole($request, Roles::BUILDER);
        $existing = $this->todos->findById($params['id']);

        if ($existing === null) {
            throw new HttpException('Tache introuvable', 404);
        }

        $payload = [];

        foreach (['title', 'description', 'status', 'deadline', 'assignedTo'] as $field) {
            if (!array_key_exists($field, $request->body)) {
                continue;
            }

            $value = $request->body[$field];
            if ($field === 'status') {
                Validator::ensureInArray((string) $value, self::STATUSES, 'status');
                $payload[$field] = (string) $value;
                continue;
            }

            $payload[$field] = trim((string) $value);
        }

        if ($payload === []) {
            throw new HttpException('Aucune modification fournie', 422);
        }

        $payload['updatedBy'] = $user['id'];
        $payload['updatedByName'] = (string) ($user['name'] ?? $user['email']);
        $payload['updatedAt'] = new UTCDateTime();

        $this->todos->update($params['id'], $payload);

        return new JsonResponse([
            'message' => 'Tache mise a jour',
            'item' => MongoSerializer::normalize($this->todos->findById($params['id'])),
        ]);
    }

    public function delete(Request $request, array $params): JsonResponse
    {
        $this->auth->requireRole($request, Roles::BUILDER);

        if (!$this->todos->delete($params['id'])) {
            throw new HttpException('Tache introuvable', 404);
        }

        return new JsonResponse(['message' => 'Tache supprimee']);
    }
}
