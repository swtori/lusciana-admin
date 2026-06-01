<?php

declare(strict_types=1);

namespace App\Services;

use App\Exceptions\HttpException;
use App\Http\Request;
use App\Repositories\DiscordTicketRepository;
use App\Support\Validator;
use MongoDB\BSON\UTCDateTime;

final class DiscordTicketIngestService
{
    private const STATUSES = ['open', 'in_progress', 'quoted', 'handled', 'archived'];
    private const CLIENT_WL = ['none', 'whitelist', 'blacklist'];

    public function __construct(
        private readonly array $config,
        private readonly DiscordTicketRepository $tickets
    ) {
    }

    public function isConfigured(): bool
    {
        return $this->ingestSecret() !== '';
    }

    public function integrationMode(): string
    {
        if ($this->isConfigured()) {
            return 'bot';
        }

        $token = trim((string) ($this->config['discord_bot_token'] ?? ''));
        $guild = trim((string) ($this->config['discord_guild_id'] ?? ''));

        if ($token !== '' && $guild !== '') {
            return 'discord_api';
        }

        return 'none';
    }

    public function assertIngestKey(Request $request): void
    {
        $expected = $this->ingestSecret();
        if ($expected === '') {
            throw new HttpException(
                'Ingest bot non configure. Ajoutez DISCORD_TICKETS_INGEST_SECRET dans .env',
                503
            );
        }

        $provided = trim((string) ($request->headers['x-lusciana-tickets-key'] ?? ''));
        if ($provided === '' || !hash_equals($expected, $provided)) {
            throw new HttpException('Cle ingest invalide', 401);
        }
    }

    /**
     * @param array<string,mixed> $body
     * @return array{created:int,updated:int,archived:int,total:int}
     */
    public function ingestPayload(array $body): array
    {
        if (isset($body['tickets']) && is_array($body['tickets'])) {
            return $this->ingestBatch($body);
        }

        $action = $this->ingestOne($body);

        return [
            'created' => $action === 'created' ? 1 : 0,
            'updated' => $action === 'updated' ? 1 : 0,
            'archived' => !empty($body['closed']) || !empty($body['channelArchived']) ? 1 : 0,
            'total' => 1,
        ];
    }

    /**
     * @param array<string,mixed> $body
     * @return array{created:int,updated:int,archived:int,total:int}
     */
    public function ingestBatch(array $body): array
    {
        $items = $body['tickets'] ?? [];
        if (!is_array($items) || $items === []) {
            throw new HttpException('Le tableau tickets est obligatoire', 422);
        }

        $created = 0;
        $updated = 0;
        $activeChannelIds = [];
        $now = new UTCDateTime();

        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }
            $normalized = $this->normalizeTicketPayload($item);
            if ($normalized['channelArchived'] !== true) {
                $activeChannelIds[] = $normalized['discordChannelId'];
            }
            $action = $this->tickets->upsertFromBot($normalized, $now);
            if ($action === 'created') {
                $created++;
            } else {
                $updated++;
            }
        }

        $archived = 0;
        if (!empty($body['archiveMissing'])) {
            $archived = $this->tickets->markMissingAsArchived($activeChannelIds);
        }

        return [
            'created' => $created,
            'updated' => $updated,
            'archived' => $archived,
            'total' => count($activeChannelIds),
        ];
    }

    /**
     * @return list<array>
     */
    public function pendingForBot(): array
    {
        return $this->tickets->findPendingBotSync();
    }

    public function acknowledgeBotSync(array $channelIds): int
    {
        return $this->tickets->acknowledgeBotSync($channelIds);
    }

    /**
     * @param array<string,mixed> $payload
     * @return 'created'|'updated'
     */
    private function ingestOne(array $payload): string
    {
        $normalized = $this->normalizeTicketPayload($payload);

        return $this->tickets->upsertFromBot($normalized, new UTCDateTime());
    }

    /**
     * @param array<string,mixed> $payload
     * @return array<string,mixed>
     */
    private function normalizeTicketPayload(array $payload): array
    {
        Validator::requireFields($payload, ['discordChannelId', 'ticketName']);

        $guildId = trim((string) ($payload['guildId'] ?? $this->defaultGuildId()));
        if ($guildId === '') {
            throw new HttpException('guildId manquant (payload ou DISCORD_GUILD_ID)', 422);
        }

        $channelId = (string) $payload['discordChannelId'];
        $closed = !empty($payload['closed']) || !empty($payload['channelArchived']);
        $status = (string) ($payload['status'] ?? ($closed ? 'archived' : 'open'));
        Validator::ensureInArray($status, self::STATUSES, 'status');

        $clientWl = (string) ($payload['clientWl'] ?? 'none');
        Validator::ensureInArray($clientWl, self::CLIENT_WL, 'clientWl');

        $discordUrl = trim((string) ($payload['discordUrl'] ?? ''));
        if ($discordUrl === '') {
            $discordUrl = sprintf('https://discord.com/channels/%s/%s', $guildId, $channelId);
        }

        $openedAt = null;
        if (!empty($payload['openedAt'])) {
            $timestamp = strtotime((string) $payload['openedAt']);
            if ($timestamp !== false) {
                $openedAt = new UTCDateTime($timestamp * 1000);
            }
        }

        return [
            'discordChannelId' => $channelId,
            'ticketName' => (string) $payload['ticketName'],
            'guildId' => $guildId,
            'discordUrl' => $discordUrl,
            'status' => $closed ? 'archived' : $status,
            'description' => trim((string) ($payload['description'] ?? '')),
            'clientWl' => $clientWl,
            'channelArchived' => $closed,
            'openedAt' => $openedAt,
        ];
    }

    private function ingestSecret(): string
    {
        return trim((string) ($this->config['discord_tickets_ingest_secret'] ?? ''));
    }

    private function defaultGuildId(): string
    {
        return trim((string) ($this->config['discord_guild_id'] ?? ''));
    }
}
