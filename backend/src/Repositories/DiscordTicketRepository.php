<?php

declare(strict_types=1);

namespace App\Repositories;

use MongoDB\BSON\ObjectId;
use MongoDB\BSON\UTCDateTime;
use MongoDB\Collection;
use MongoDB\Database;

final class DiscordTicketRepository
{
    private Collection $collection;

    public function __construct(Database $database)
    {
        $this->collection = $database->selectCollection('discord_tickets');
    }

    public function findAll(): array
    {
        return $this->collection->find([], [
            'sort' => [
                'channelArchived' => 1,
                'status' => 1,
                'ticketName' => 1,
            ],
        ])->toArray();
    }

    /**
     * @return list<array>
     */
    public function findPendingBotSync(): array
    {
        return $this->collection->find(
            ['needsBotSync' => true],
            ['sort' => ['updatedAt' => 1]]
        )->toArray();
    }

    public function acknowledgeBotSync(array $channelIds): int
    {
        $ids = array_values(array_filter(array_map('strval', $channelIds)));
        if ($ids === []) {
            return 0;
        }

        $result = $this->collection->updateMany(
            ['discordChannelId' => ['$in' => $ids]],
            ['$set' => [
                'needsBotSync' => false,
                'pendingWlAction' => null,
                'pendingWlNicknames' => [],
                'botSyncedAt' => new UTCDateTime(),
                'updatedAt' => new UTCDateTime(),
            ]]
        );

        return (int) $result->getModifiedCount();
    }

    /**
     * @param array<string,mixed> $data
     * @return 'created'|'updated'
     */
    public function upsertFromBot(array $data, UTCDateTime $now): string
    {
        $existing = $this->findByChannelId((string) $data['discordChannelId']);

        $base = [
            'ticketName' => (string) $data['ticketName'],
            'guildId' => (string) $data['guildId'],
            'discordUrl' => (string) $data['discordUrl'],
            'status' => (string) $data['status'],
            'channelArchived' => (bool) $data['channelArchived'],
            'source' => 'bot',
            'syncedAt' => $now,
            'updatedAt' => $now,
        ];

        if (!empty($data['openedAt'])) {
            $base['openedAt'] = $data['openedAt'];
        }

        if ($existing === null) {
            $description = (string) ($data['description'] ?? '');
            $this->collection->insertOne(array_merge($base, [
                'discordChannelId' => (string) $data['discordChannelId'],
                'description' => $description,
                'descriptionUpdatedBy' => $description !== ''
                    ? (string) ($data['descriptionUpdatedBy'] ?? 'discord')
                    : null,
                'descriptionUpdatedAt' => $description !== ''
                    ? ($data['descriptionUpdatedAt'] ?? $now)
                    : null,
                'clientWl' => (string) ($data['clientWl'] ?? 'none'),
                'minecraftNicknames' => [],
                'needsBotSync' => false,
                'createdAt' => $now,
            ]));

            return 'created';
        }

        // Ne jamais ecraser description / auteur : reserves aux modifs admin
        $this->collection->updateOne(
            ['_id' => $existing['_id']],
            ['$set' => $base]
        );

        return 'updated';
    }

    public function findById(string $id): ?array
    {
        $item = $this->collection->findOne(['_id' => new ObjectId($id)]);

        return $item ? (array) $item : null;
    }

    public function findByChannelId(string $channelId): ?array
    {
        $item = $this->collection->findOne(['discordChannelId' => $channelId]);

        return $item ? (array) $item : null;
    }

    /**
     * @return 'created'|'updated'
     */
    public function upsertFromDiscord(array $data): string
    {
        $existing = $this->findByChannelId((string) $data['discordChannelId']);
        $now = new UTCDateTime();

        if ($existing === null) {
            $this->collection->insertOne(array_merge($data, [
                'status' => 'open',
                'description' => '',
                'descriptionUpdatedBy' => null,
                'descriptionUpdatedAt' => null,
                'clientWl' => 'none',
                'minecraftNicknames' => [],
                'channelArchived' => false,
                'createdAt' => $now,
                'updatedAt' => $now,
            ]));

            return 'created';
        }

        $set = [
            'ticketName' => (string) $data['ticketName'],
            'discordUrl' => (string) $data['discordUrl'],
            'guildId' => (string) $data['guildId'],
            'channelArchived' => false,
            'syncedAt' => $data['syncedAt'],
            'updatedAt' => $now,
        ];

        if (!empty($data['openedAt'])) {
            $set['openedAt'] = $data['openedAt'];
        }

        $this->collection->updateOne(
            ['_id' => $existing['_id']],
            ['$set' => $set]
        );

        return 'updated';
    }

    public function markMissingAsArchived(array $activeChannelIds): int
    {
        $filter = ['channelArchived' => ['$ne' => true]];
        if ($activeChannelIds !== []) {
            $filter['discordChannelId'] = ['$nin' => $activeChannelIds];
        }

        $result = $this->collection->updateMany($filter, [
            '$set' => [
                'channelArchived' => true,
                'updatedAt' => new UTCDateTime(),
            ],
        ]);

        return (int) $result->getModifiedCount();
    }

    public function update(string $id, array $data): bool
    {
        $result = $this->collection->updateOne(
            ['_id' => new ObjectId($id)],
            ['$set' => $data]
        );

        return $result->getMatchedCount() > 0;
    }
}
