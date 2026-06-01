<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Exceptions\HttpException;
use App\Http\JsonResponse;
use App\Http\Request;
use App\Repositories\SchematicUploadLogRepository;
use App\Services\AuthService;
use App\Services\SchematicsUploadService;
use App\Support\MongoSerializer;
use App\Support\Roles;
use MongoDB\BSON\UTCDateTime;

final class SchematicsController
{
    public function __construct(
        private readonly SchematicsUploadService $uploads,
        private readonly SchematicUploadLogRepository $uploadLogs,
        private readonly AuthService $auth
    ) {
    }

    public function info(Request $request, array $params): JsonResponse
    {
        $this->auth->authenticate($request);

        return new JsonResponse([
            'allowedExtensions' => array_map(
                static fn (string $ext): string => '.' . $ext,
                $this->uploads->allowedExtensions()
            ),
            'maxBytes' => $this->uploads->maxBytes(),
            'maxMb' => (int) ceil($this->uploads->maxBytes() / 1024 / 1024),
            'diagnostics' => $this->uploads->diagnostics(),
        ]);
    }

    public function logs(Request $request, array $params): JsonResponse
    {
        $user = $this->auth->requireRole($request, Roles::MANAGER);

        $defaultLimit = Roles::can((string) ($user['role'] ?? ''), Roles::ADMIN) ? 200 : 50;
        $maxLimit = Roles::can((string) ($user['role'] ?? ''), Roles::ADMIN) ? 500 : 200;
        $limit = (int) ($request->query['limit'] ?? $defaultLimit);
        $limit = max(1, min($limit, $maxLimit));

        return new JsonResponse([
            'items' => array_map(
                static fn (array $item) => MongoSerializer::normalize($item),
                $this->uploadLogs->findRecent($limit)
            ),
            'total' => $this->uploadLogs->count(),
            'limit' => $limit,
        ]);
    }

    public function upload(Request $request, array $params): JsonResponse
    {
        $user = $this->auth->requireRole($request, Roles::BUILDER);

        if (!isset($_FILES['file']) || !is_array($_FILES['file'])) {
            $filesKeys = array_keys($_FILES);
            error_log('[schematics] Upload sans $_FILES[file]. Cles recues: ' . implode(', ', $filesKeys));
            $this->recordLog($request, $user, [
                'originalFilename' => '',
                'filename' => '',
                'path' => '',
                'sizeBytes' => 0,
                'status' => 'failed',
                'errorMessage' => 'Fichier manquant (champ file)',
            ]);
            throw new HttpException('Fichier manquant (champ "file")', 422);
        }

        $originalFilename = (string) ($_FILES['file']['name'] ?? '');

        try {
            $result = $this->uploads->store($_FILES['file'], (string) ($user['id'] ?? ''));
        } catch (HttpException $exception) {
            error_log('[schematics] Echec upload: ' . $exception->getMessage());
            $this->recordLog($request, $user, [
                'originalFilename' => $originalFilename,
                'filename' => '',
                'path' => '',
                'sizeBytes' => (int) ($_FILES['file']['size'] ?? 0),
                'status' => 'failed',
                'errorMessage' => $exception->getMessage(),
            ]);
            throw $exception;
        }

        error_log(sprintf(
            '[schematics] OK user=%s file=%s path=%s size=%d',
            (string) ($user['email'] ?? $user['id'] ?? '?'),
            (string) ($result['filename'] ?? '?'),
            (string) ($result['path'] ?? '?'),
            (int) ($result['size'] ?? 0)
        ));

        $this->recordLog($request, $user, [
            'originalFilename' => $originalFilename,
            'filename' => (string) ($result['filename'] ?? ''),
            'path' => (string) ($result['path'] ?? ''),
            'sizeBytes' => (int) ($result['size'] ?? 0),
            'status' => 'success',
            'errorMessage' => null,
        ]);

        return new JsonResponse([
            'message' => 'Schematic envoye sur le serveur Minecraft',
            'item' => $result,
            'diagnostics' => $this->uploads->diagnostics(),
        ], 201);
    }

    private function recordLog(Request $request, array $user, array $payload): void
    {
        $now = new UTCDateTime();

        $this->uploadLogs->insert([
            'userId' => (string) ($user['id'] ?? ''),
            'userName' => (string) ($user['name'] ?? ''),
            'userEmail' => (string) ($user['email'] ?? ''),
            'userRole' => (string) ($user['role'] ?? ''),
            'originalFilename' => (string) ($payload['originalFilename'] ?? ''),
            'filename' => (string) ($payload['filename'] ?? ''),
            'path' => (string) ($payload['path'] ?? ''),
            'sizeBytes' => (int) ($payload['sizeBytes'] ?? 0),
            'status' => (string) ($payload['status'] ?? 'failed'),
            'errorMessage' => isset($payload['errorMessage']) ? (string) $payload['errorMessage'] : null,
            'ipAddress' => $request->ip,
            'userAgent' => $request->userAgent,
            'uploadedAt' => $now,
            'createdAt' => $now,
        ]);
    }
}
