<?php

declare(strict_types=1);

namespace App\Repositories;

use MongoDB\BSON\ObjectId;
use MongoDB\BSON\Regex;
use MongoDB\Collection;
use MongoDB\Database;

final class AgentRepository
{
    private Collection $collection;

    public function __construct(Database $database)
    {
        $this->collection = $database->selectCollection('agents');
    }

    public function findAll(array $filter = []): array
    {
        return $this->collection->find($filter, ['sort' => ['pseudo' => 1]])->toArray();
    }

    public function findById(string $id): ?array
    {
        $item = $this->collection->findOne(['_id' => new ObjectId($id)]);
        return $item ? (array) $item : null;
    }

    public function findByPseudo(string $pseudo): ?array
    {
        $item = $this->collection->findOne(['pseudo' => $pseudo]);
        return $item ? (array) $item : null;
    }

    public function findByDiscordUserId(string $discordUserId): ?array
    {
        $discordUserId = trim($discordUserId);
        if ($discordUserId === '' || !ctype_digit($discordUserId)) {
            return null;
        }

        $item = $this->collection->findOne(['discordUserId' => $discordUserId]);
        if ($item !== null) {
            return (array) $item;
        }

        $mentionPattern = '<@' . preg_quote($discordUserId, '/') . '>';
        $item = $this->collection->findOne([
            'discord' => new Regex($mentionPattern, 'i'),
        ]);

        if ($item !== null) {
            return (array) $item;
        }

        $item = $this->collection->findOne([
            'discord' => new Regex(preg_quote($discordUserId, '/'), 'i'),
        ]);

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
