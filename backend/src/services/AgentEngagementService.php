<?php

declare(strict_types=1);

namespace App\Services;

use App\Exceptions\HttpException;
use App\Repositories\AgentEngagementRepository;
use App\Support\AgentEngagementRules;
use App\Support\MongoSerializer;
use MongoDB\BSON\UTCDateTime;

final class AgentEngagementService
{
    public function __construct(
        private readonly AgentEngagementRepository $events
    ) {
    }

    /**
     * @param list<string> $agentIds
     * @return array<string, array<string, mixed>>
     */
    public function summariesForAgentIds(array $agentIds): array
    {
        $windowDays = AgentEngagementRules::WINDOW_DAYS;
        $aggregated = $this->events->aggregateNegativeCountsByAgent($agentIds, $windowDays);
        $periodStart = (new \DateTimeImmutable())
            ->modify(sprintf('-%d days', $windowDays))
            ->format(\DateTimeInterface::ATOM);

        $out = [];
        foreach ($agentIds as $rawId) {
            $id = (string) $rawId;
            if ($id === '') {
                continue;
            }
            $bucket = $aggregated[$id] ?? ['total' => 0, 'byType' => []];
            $total = (int) ($bucket['total'] ?? 0);
            $byType = is_array($bucket['byType'] ?? null) ? $bucket['byType'] : [];

            $out[$id] = [
                'windowDays' => $windowDays,
                'periodStart' => $periodStart,
                'negativeCount' => $total,
                'byType' => $byType,
                'status' => AgentEngagementRules::statusFromNegativeCount($total),
            ];
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $body
     * @return array<string, mixed>
     */
    public function recordNegativeEvent(
        string $agentId,
        array $body,
        string $createdByUserId
    ): array {
        $type = (string) ($body['type'] ?? '');
        if (!in_array($type, AgentEngagementRules::negativeTypes(), true)) {
            throw new HttpException('Type d\'evenement invalide', 422);
        }

        $note = trim((string) ($body['note'] ?? ''));
        $externalRef = trim((string) ($body['externalRef'] ?? ''));

        if ($externalRef !== '' && $this->events->findByExternalRef($agentId, $externalRef) !== null) {
            throw new HttpException('Evenement deja enregistre (reference externe)', 409);
        }

        $occurredAt = $this->parseOccurredAt($body['occurredAt'] ?? null);
        $now = new UTCDateTime();

        $doc = [
            'agentId' => $agentId,
            'type' => $type,
            'note' => $note,
            'source' => 'admin',
            'externalRef' => $externalRef !== '' ? $externalRef : null,
            'createdByUserId' => $createdByUserId,
            'occurredAt' => $occurredAt,
            'createdAt' => $now,
            'updatedAt' => $now,
        ];

        $id = $this->events->insert($doc);
        $doc['_id'] = $id;

        return MongoSerializer::normalize($doc);
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function listEventsNormalized(string $agentId): array
    {
        return array_map(
            static fn (array $row) => MongoSerializer::normalize($row),
            $this->events->findRecentByAgentId($agentId, 80)
        );
    }

    private function parseOccurredAt(mixed $raw): UTCDateTime
    {
        if ($raw === null || $raw === '') {
            return new UTCDateTime();
        }

        if (is_numeric($raw)) {
            $seconds = (int) $raw;
            if ($seconds > 200000000000) {
                $seconds = (int) floor($seconds / 1000);
            }

            return new UTCDateTime($seconds * 1000);
        }

        if (is_string($raw)) {
            try {
                $dt = new \DateTimeImmutable($raw);

                return new UTCDateTime($dt->getTimestamp() * 1000);
            } catch (\Throwable) {
                throw new HttpException('Date occurredAt invalide', 422);
            }
        }

        throw new HttpException('Date occurredAt invalide', 422);
    }
}
