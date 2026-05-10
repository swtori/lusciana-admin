<?php

declare(strict_types=1);

namespace App\Services;

use MongoDB\BSON\UTCDateTime;
use MongoDB\Collection;
use MongoDB\Database;

final class HistoricalImportService
{
    private Collection $agents;
    private Collection $commissions;
    private Collection $imports;

    public function __construct(
        private readonly Database $database,
        private readonly string $projectRoot
    ) {
        $this->agents = $database->selectCollection('agents');
        $this->commissions = $database->selectCollection('commissions');
        $this->imports = $database->selectCollection('import_runs');
    }

    public function importIfAvailable(): void
    {
        [$agentsPath, $commissionsPath] = $this->resolveImportPaths();

        if ($agentsPath === null || $commissionsPath === null) {
            return;
        }

        $agentsHash = md5_file($agentsPath);
        $commissionsHash = md5_file($commissionsPath);

        if ($agentsHash === false || $commissionsHash === false) {
            return;
        }

        $importKey = 'lusciana-historical-import';
        $existingRun = $this->imports->findOne(['key' => $importKey]);
        if (is_array($existingRun)
            && ($existingRun['agentsHash'] ?? null) === $agentsHash
            && ($existingRun['commissionsHash'] ?? null) === $commissionsHash
            && !empty($existingRun['completedAt'])) {
            return;
        }

        $agents = $this->readNdjson($agentsPath);
        $commissions = $this->readNdjson($commissionsPath);

        foreach ($agents as $agent) {
            $this->upsertAgent($agent);
        }

        foreach ($commissions as $commission) {
            $this->upsertCommission($commission);
        }

        $now = new UTCDateTime();
        $this->imports->updateOne(
            ['key' => $importKey],
            ['$set' => [
                'key' => $importKey,
                'agentsHash' => $agentsHash,
                'commissionsHash' => $commissionsHash,
                'agentCount' => count($agents),
                'commissionCount' => count($commissions),
                'completedAt' => $now,
                'updatedAt' => $now,
            ]],
            ['upsert' => true]
        );
    }

    /**
     * @return array{0: string|null, 1: string|null}
     */
    private function resolveImportPaths(): array
    {
        $candidateDirectories = [
            $this->projectRoot . '/tmp',
            $this->projectRoot . '/../scripts',
            $this->projectRoot . '/scripts',
        ];

        foreach ($candidateDirectories as $directory) {
            $agentsPath = $directory . '/lusciana-agents.ndjson';
            $commissionsPath = $directory . '/lusciana-commissions.ndjson';

            if (is_file($agentsPath) && is_file($commissionsPath)) {
                return [$agentsPath, $commissionsPath];
            }
        }

        return [null, null];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function readNdjson(string $path): array
    {
        $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if ($lines === false) {
            return [];
        }

        $items = [];
        foreach ($lines as $line) {
            $decoded = json_decode($line, true);
            if (is_array($decoded)) {
                $items[] = $decoded;
            }
        }

        return $items;
    }

    /**
     * @param array<string, mixed> $agent
     */
    private function upsertAgent(array $agent): void
    {
        $pseudo = (string) ($agent['pseudo'] ?? '');
        if ($pseudo === '') {
            return;
        }

        $existing = $this->agents->findOne(['pseudo' => $pseudo]);
        if (is_array($existing)) {
            $legacyImport = is_array($existing['legacyImport'] ?? null)
                ? array_merge($existing['legacyImport'], (array) ($agent['legacyImport'] ?? []))
                : (array) ($agent['legacyImport'] ?? []);

            $this->agents->updateOne(
                ['_id' => $existing['_id']],
                ['$set' => [
                    'category' => (string) ($existing['category'] ?? '') !== '' ? $existing['category'] : ($agent['category'] ?? 'client'),
                    'updatedAt' => new UTCDateTime(),
                    'legacyImport' => $legacyImport,
                ]]
            );
            return;
        }

        $this->agents->insertOne($this->normalizeDocument($agent));
    }

    /**
     * @param array<string, mixed> $commission
     */
    private function upsertCommission(array $commission): void
    {
        $legacy = (array) ($commission['legacyImport'] ?? []);
        $month = (string) ($legacy['month'] ?? '');
        $row = (int) ($legacy['row'] ?? 0);
        $column = (int) ($legacy['column'] ?? 0);
        $type = (string) ($legacy['type'] ?? '');

        if ($month === '' || $row <= 0 || $column <= 0 || $type === '') {
            return;
        }

        $this->commissions->updateOne(
            [
                'legacyImport.source' => 'Comptabilité Lusciana.xlsx',
                'legacyImport.month' => $month,
                'legacyImport.row' => $row,
                'legacyImport.column' => $column,
                'legacyImport.type' => $type,
            ],
            ['$set' => $this->normalizeDocument($commission)],
            ['upsert' => true]
        );
    }

    /**
     * @param mixed $value
     * @return mixed
     */
    private function normalizeValue(mixed $value): mixed
    {
        if (is_array($value)) {
            $normalized = [];
            foreach ($value as $key => $item) {
                $normalized[$key] = $this->normalizeValue($item);
            }
            return $normalized;
        }

        if (is_string($value) && preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', $value) === 1) {
            return new UTCDateTime((new \DateTimeImmutable($value))->getTimestamp() * 1000);
        }

        return $value;
    }

    /**
     * @param array<string, mixed> $document
     * @return array<string, mixed>
     */
    private function normalizeDocument(array $document): array
    {
        $normalized = [];
        foreach ($document as $key => $value) {
            $normalized[$key] = $this->normalizeValue($value);
        }
        return $normalized;
    }
}
