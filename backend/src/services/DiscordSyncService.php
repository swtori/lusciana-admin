<?php

declare(strict_types=1);

namespace App\Services;

use App\Exceptions\HttpException;
use App\Repositories\DiscordTicketRepository;
use MongoDB\BSON\UTCDateTime;

final class DiscordSyncService
{
    public function __construct(
        private readonly array $config,
        private readonly DiscordTicketRepository $tickets
    ) {
    }

    public function isConfigured(): bool
    {
        return $this->botToken() !== '' && $this->guildId() !== '';
    }

    /**
     * @return array{created:int,updated:int,archived:int,total:int}
     */
    public function sync(): array
    {
        if (!$this->isConfigured()) {
            throw new HttpException(
                'Discord non configure. Ajoutez DISCORD_BOT_TOKEN et DISCORD_GUILD_ID dans .env',
                503
            );
        }

        $channels = $this->fetchGuildChannels();
        $now = new UTCDateTime();
        $guildId = $this->guildId();
        $prefix = $this->ticketNamePrefix();
        $categoryId = $this->ticketCategoryId();
        $activeChannelIds = [];
        $created = 0;
        $updated = 0;

        foreach ($channels as $channel) {
            if (!$this->isTicketChannel($channel, $prefix, $categoryId)) {
                continue;
            }

            $channelId = (string) ($channel['id'] ?? '');
            if ($channelId === '') {
                continue;
            }

            $activeChannelIds[] = $channelId;
            $ticketName = (string) ($channel['name'] ?? 'ticket');
            $openedAt = null;
            if (!empty($channel['created_at'])) {
                $openedAt = new UTCDateTime(((int) $channel['created_at']) * 1000);
            }

            $action = $this->tickets->upsertFromDiscord([
                'discordChannelId' => $channelId,
                'ticketName' => $ticketName,
                'guildId' => $guildId,
                'discordUrl' => sprintf('https://discord.com/channels/%s/%s', $guildId, $channelId),
                'openedAt' => $openedAt,
                'syncedAt' => $now,
            ]);

            if ($action === 'created') {
                $created++;
            } else {
                $updated++;
            }
        }

        $archived = $this->tickets->markMissingAsArchived($activeChannelIds);

        return [
            'created' => $created,
            'updated' => $updated,
            'archived' => $archived,
            'total' => count($activeChannelIds),
        ];
    }

    /**
     * @return list<array<string,mixed>>
     */
    private function fetchGuildChannels(): array
    {
        $url = sprintf(
            'https://discord.com/api/v10/guilds/%s/channels',
            rawurlencode($this->guildId())
        );

        $response = $this->discordRequest('GET', $url);
        if (!is_array($response)) {
            throw new HttpException('Reponse Discord invalide', 502);
        }

        return $response;
    }

    /**
     * @param array<string,mixed> $channel
     */
    private function isTicketChannel(array $channel, string $prefix, string $categoryId): bool
    {
        $type = (int) ($channel['type'] ?? -1);
        // 0 = GUILD_TEXT, 15 = GUILD_FORUM (ignore forums for now)
        if ($type !== 0) {
            return false;
        }

        $name = strtolower((string) ($channel['name'] ?? ''));
        if ($name === '' || !str_starts_with($name, strtolower($prefix))) {
            return false;
        }

        if ($categoryId !== '') {
            $parentId = (string) ($channel['parent_id'] ?? '');
            if ($parentId !== $categoryId) {
                return false;
            }
        }

        return true;
    }

    /**
     * @return mixed
     */
    private function discordRequest(string $method, string $url)
    {
        if (!function_exists('curl_init')) {
            throw new HttpException('Extension cURL requise pour la sync Discord', 500);
        }

        $handle = curl_init($url);
        if ($handle === false) {
            throw new HttpException('Impossible d initialiser cURL', 500);
        }

        curl_setopt_array($handle, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => [
                'Authorization: Bot ' . $this->botToken(),
                'Content-Type: application/json',
                'User-Agent: LuscianaAdmin (https://admin.lusciana.fr, 1.0)',
            ],
            CURLOPT_TIMEOUT => 30,
        ]);

        $body = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_HTTP_CODE);
        $error = curl_error($handle);
        curl_close($handle);

        if ($body === false) {
            throw new HttpException('Erreur reseau Discord: ' . $error, 502);
        }

        $decoded = json_decode($body, true);
        if ($status >= 400) {
            $message = is_array($decoded) && isset($decoded['message'])
                ? (string) $decoded['message']
                : 'Erreur API Discord';
            throw new HttpException(sprintf('Discord API (%d): %s', $status, $message), 502);
        }

        return $decoded;
    }

    private function botToken(): string
    {
        return trim((string) ($this->config['discord_bot_token'] ?? ''));
    }

    private function guildId(): string
    {
        return trim((string) ($this->config['discord_guild_id'] ?? ''));
    }

    private function ticketNamePrefix(): string
    {
        $prefix = trim((string) ($this->config['discord_ticket_name_prefix'] ?? 'ticket-'));

        return $prefix !== '' ? $prefix : 'ticket-';
    }

    private function ticketCategoryId(): string
    {
        return trim((string) ($this->config['discord_ticket_category_id'] ?? ''));
    }
}
