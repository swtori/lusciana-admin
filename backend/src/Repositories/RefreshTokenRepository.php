<?php

declare(strict_types=1);

namespace App\Repositories;

use MongoDB\Collection;
use MongoDB\Database;

final class RefreshTokenRepository
{
    private Collection $collection;

    public function __construct(Database $database)
    {
        $this->collection = $database->selectCollection('refresh_tokens');
    }

    public function insert(array $data): void
    {
        $this->collection->insertOne($data);
    }

    public function findOneActiveByTokenId(string $tokenId): ?array
    {
        $item = $this->collection->findOne([
            'tokenId' => $tokenId,
            'revokedAt' => null,
            'expiresAt' => ['$gt' => new \MongoDB\BSON\UTCDateTime()],
        ]);

        return $item ? (array) $item : null;
    }

    public function revokeByTokenId(string $tokenId): void
    {
        $this->collection->updateOne(
            ['tokenId' => $tokenId],
            ['$set' => ['revokedAt' => new \MongoDB\BSON\UTCDateTime()]]
        );
    }

    public function revokeAllByUserId(string $userId): void
    {
        $this->collection->updateMany(
            ['userId' => $userId, 'revokedAt' => null],
            ['$set' => ['revokedAt' => new \MongoDB\BSON\UTCDateTime()]]
        );
    }
}
