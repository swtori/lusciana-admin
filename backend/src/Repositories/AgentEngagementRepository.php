<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Support\AgentEngagementRules;
use MongoDB\BSON\UTCDateTime;
use MongoDB\Collection;
use MongoDB\Database;

final class AgentEngagementRepository
{
    private Collection $collection;

    public function __construct(Database $database)
    {
        $this->collection = $database->selectCollection('agent_engagement_events');
    }

    public function findByExternalRef(string $agentId, string $externalRef): ?array
    {
        if ($externalRef === '') {
            return null;
        }

        $doc = $this->collection->findOne([
            'agentId' => $agentId,
            'externalRef' => $externalRef,
        ]);

        return $doc ? (array) $doc : null;
    }

    public function insert(array $data): string
    {
        $result = $this->collection->insertOne($data);

        return (string) $result->getInsertedId();
    }

    /**
     * @param list<string> $agentIds
     * @return array<string, array{total: int, byType: array<string, int>}>
     */
    public function aggregateNegativeCountsByAgent(array $agentIds, int $windowDays): array
    {
        $normalized = array_values(array_unique(array_filter(
            array_map('strval', $agentIds),
            static fn (string $id): bool => $id !== ''
        )));

        $empty = [];
        foreach ($normalized as $id) {
            $empty[$id] = ['total' => 0, 'byType' => []];
        }

        if ($normalized === []) {
            return [];
        }

        $sinceMs = (time() - $windowDays * 86400) * 1000;
        $since = new UTCDateTime($sinceMs);

        $cursor = $this->collection->find(
            [
                'agentId' => ['$in' => $normalized],
                'type' => ['$in' => AgentEngagementRules::negativeTypes()],
                'occurredAt' => ['$gte' => $since],
            ],
            ['sort' => ['occurredAt' => -1]]
        );

        $out = $empty;
        foreach ($cursor as $row) {
            $doc = (array) $row;
            $agentId = (string) ($doc['agentId'] ?? '');
            $type = (string) ($doc['type'] ?? '');
            if ($agentId === '' || !isset($out[$agentId])) {
                continue;
            }
            $out[$agentId]['total']++;
            if (!isset($out[$agentId]['byType'][$type])) {
                $out[$agentId]['byType'][$type] = 0;
            }
            $out[$agentId]['byType'][$type]++;
        }

        return $out;
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function findRecentByAgentId(string $agentId, int $limit = 80): array
    {
        if ($agentId === '') {
            return [];
        }

        $cursor = $this->collection->find(
            ['agentId' => $agentId],
            [
                'sort' => ['occurredAt' => -1],
                'limit' => max(1, $limit),
            ]
        );

        return array_map(static fn ($doc) => (array) $doc, iterator_to_array($cursor, false));
    }
}
