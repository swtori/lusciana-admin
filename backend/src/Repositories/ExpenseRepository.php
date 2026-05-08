<?php

declare(strict_types=1);

namespace App\Repositories;

use MongoDB\BSON\ObjectId;
use MongoDB\Collection;
use MongoDB\Database;

final class ExpenseRepository
{
    private Collection $collection;

    public function __construct(Database $database)
    {
        $this->collection = $database->selectCollection('expenses');
    }

    public function findAll(): array
    {
        return $this->collection->find([], ['sort' => ['createdAt' => -1]])->toArray();
    }

    public function findById(string $id): ?array
    {
        $item = $this->collection->findOne(['_id' => new ObjectId($id)]);
        return $item ? (array) $item : null;
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

    public function delete(string $id): bool
    {
        $result = $this->collection->deleteOne(['_id' => new ObjectId($id)]);
        return $result->getDeletedCount() > 0;
    }
}
