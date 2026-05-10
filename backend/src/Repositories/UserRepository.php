<?php

declare(strict_types=1);

namespace App\Repositories;

use MongoDB\BSON\ObjectId;
use MongoDB\Collection;
use MongoDB\Database;

final class UserRepository
{
    private Collection $collection;

    public function __construct(Database $database)
    {
        $this->collection = $database->selectCollection('users');
    }

    public function findByEmail(string $email): ?array
    {
        $user = $this->collection->findOne(['email' => strtolower($email)]);
        return $user ? (array) $user : null;
    }

    public function findById(string $id): ?array
    {
        $user = $this->collection->findOne(['_id' => new ObjectId($id)]);
        return $user ? (array) $user : null;
    }

    public function findByAgentId(string $agentId): ?array
    {
        $user = $this->collection->findOne(['agentId' => $agentId]);
        return $user ? (array) $user : null;
    }

    public function findAll(): array
    {
        return $this->collection->find([], ['sort' => ['createdAt' => -1]])->toArray();
    }

    public function insert(array $data): string
    {
        $result = $this->collection->insertOne($data);
        return (string) $result->getInsertedId();
    }

    public function update(string $id, array $data): bool
    {
        $result = $this->collection->updateOne(
            ['_id' => new ObjectId($id)],
            ['$set' => $data]
        );

        return $result->getMatchedCount() > 0;
    }

    public function deleteByAgentId(string $agentId): bool
    {
        $result = $this->collection->deleteOne(['agentId' => $agentId]);
        return $result->getDeletedCount() > 0;
    }
}
