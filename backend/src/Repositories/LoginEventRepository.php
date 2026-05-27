<?php

declare(strict_types=1);

namespace App\Repositories;

use MongoDB\Collection;
use MongoDB\Database;

final class LoginEventRepository
{
    private Collection $collection;

    public function __construct(Database $database)
    {
        $this->collection = $database->selectCollection('login_events');
    }

    public function insert(array $data): void
    {
        $this->collection->insertOne($data);
    }

    public function findRecentByUserIds(array $userIds, int $limitPerUser = 8): array
    {
        $normalizedUserIds = array_values(array_unique(array_filter(
            array_map('strval', $userIds),
            static fn (string $value): bool => $value !== ''
        )));

        if ($normalizedUserIds === []) {
            return [];
        }

        $grouped = [];
        $counts = array_fill_keys($normalizedUserIds, 0);

        $cursor = $this->collection->find(
            ['userId' => ['$in' => $normalizedUserIds]],
            ['sort' => ['occurredAt' => -1]]
        );

        foreach ($cursor as $item) {
            $event = (array) $item;
            $userId = (string) ($event['userId'] ?? '');

            if ($userId === '' || !array_key_exists($userId, $counts)) {
                continue;
            }

            if ($counts[$userId] >= $limitPerUser) {
                continue;
            }

            $grouped[$userId][] = $event;
            $counts[$userId]++;
        }

        return $grouped;
    }
}
