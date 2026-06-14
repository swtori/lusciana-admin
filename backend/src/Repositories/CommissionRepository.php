<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Support\CommissionBuildDate;
use MongoDB\BSON\ObjectId;
use MongoDB\BSON\UTCDateTime;
use MongoDB\Collection;
use MongoDB\Database;

final class CommissionRepository
{
    private Collection $collection;

    public function __construct(Database $database)
    {
        $this->collection = $database->selectCollection('commissions');
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

    /** @return array<string, mixed> */
    public function legacyImportFilter(): array
    {
        return [
            '$or' => [
                ['worldName' => ['$regex' => '^c-import-', '$options' => 'i']],
                ['buildSize' => 'legacy-import'],
                ['buildType' => 'legacy'],
                ['legacyImport' => ['$exists' => true]],
            ],
        ];
    }

    public function countLegacyImports(): int
    {
        return $this->collection->countDocuments($this->legacyImportFilter());
    }

    public function deleteLegacyImports(): int
    {
        $result = $this->collection->deleteMany($this->legacyImportFilter());
        return $result->getDeletedCount();
    }

    public function findByWorldName(string $worldName): ?array
    {
        $item = $this->collection->findOne(['worldName' => $worldName]);
        return $item ? (array) $item : null;
    }

    /** @param list<string> $worldNames */
    public function findExistingWorldNames(array $worldNames): array
    {
        if ($worldNames === []) {
            return [];
        }

        $cursor = $this->collection->find(
            ['worldName' => ['$in' => $worldNames]],
            ['projection' => ['worldName' => 1]]
        );

        $existing = [];
        foreach ($cursor as $document) {
            $name = (string) ($document['worldName'] ?? '');
            if ($name !== '') {
                $existing[] = $name;
            }
        }

        return $existing;
    }

    /** @param list<array<string, mixed>> $documents */
    public function insertMany(array $documents): int
    {
        if ($documents === []) {
            return 0;
        }

        $result = $this->collection->insertMany($documents);
        return $result->getInsertedCount();
    }

    /** @param list<string> $worldNames */
    public function countByWorldNames(array $worldNames): int
    {
        if ($worldNames === []) {
            return 0;
        }

        return $this->collection->countDocuments(['worldName' => ['$in' => $worldNames]]);
    }

    /** @param list<string> $worldNames */
    public function deleteByWorldNames(array $worldNames): int
    {
        if ($worldNames === []) {
            return 0;
        }

        $result = $this->collection->deleteMany(['worldName' => ['$in' => $worldNames]]);
        return $result->getDeletedCount();
    }

    /** @param list<string> $worldNames */
    public function findMatchingWorldNames(array $worldNames): array
    {
        if ($worldNames === []) {
            return [];
        }

        $cursor = $this->collection->find(
            ['worldName' => ['$in' => $worldNames]],
            ['projection' => ['worldName' => 1]]
        );

        $found = [];
        foreach ($cursor as $document) {
            $name = (string) ($document['worldName'] ?? '');
            if ($name !== '') {
                $found[] = $name;
            }
        }

        return array_values(array_unique($found));
    }

    public function normalizeAllBuildDates(): int
    {
        $updated = 0;
        $cursor = $this->collection->find([]);

        foreach ($cursor as $document) {
            $document = (array) $document;
            $id = (string) $document['_id'];
            $originalStart = (string) ($document['buildStart'] ?? '');
            $originalEnd = (string) ($document['buildEnd'] ?? '');
            $buildStart = CommissionBuildDate::normalize($originalStart);
            $buildEnd = CommissionBuildDate::normalize($originalEnd, true);

            if ($buildStart === $originalStart && $buildEnd === $originalEnd) {
                continue;
            }

            $this->update($id, [
                'buildStart' => $buildStart,
                'buildEnd' => $buildEnd,
                'updatedAt' => new UTCDateTime(),
            ]);
            $updated++;
        }

        return $updated;
    }
}
