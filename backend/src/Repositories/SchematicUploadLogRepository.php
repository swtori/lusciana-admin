<?php

declare(strict_types=1);

namespace App\Repositories;

use MongoDB\Collection;
use MongoDB\Database;

final class SchematicUploadLogRepository
{
    private Collection $collection;

    public function __construct(Database $database)
    {
        $this->collection = $database->selectCollection('schematic_upload_logs');
    }

    public function insert(array $data): void
    {
        $this->collection->insertOne($data);
    }

    public function count(): int
    {
        return $this->collection->countDocuments([]);
    }

    public function findRecent(int $limit = 50): array
    {
        $limit = max(1, min($limit, 500));

        return $this->collection->find(
            [],
            ['sort' => ['uploadedAt' => -1], 'limit' => $limit]
        )->toArray();
    }
}
