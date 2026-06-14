<?php

declare(strict_types=1);

namespace App\Services;

final class DiscordBotTicketNotifyService
{
    private const WEBHOOK_TIMEOUT_MS = 45000;
    private const WEBHOOK_CONNECT_TIMEOUT_MS = 2000;

    public function __construct(private readonly array $config)
    {
    }

    public function isConfigured(): bool
    {
        return $this->webhookUrl() !== '' && $this->ingestSecret() !== '';
    }

    /**
     * Declenche le bot : traite pending + RCON, puis repond (synchrone cote bot).
     *
     * @return bool true si le webhook a repondu 2xx
     */
    public function triggerPendingSync(): bool
    {
        if (!$this->isConfigured()) {
            error_log('[Lusciana] DISCORD_BOT_TICKETS_WEBHOOK_URL ou DISCORD_TICKETS_INGEST_SECRET manquant — sync WL instantanee desactivee');

            return false;
        }

        if (!function_exists('curl_init')) {
            error_log('[Lusciana] extension curl absente — impossible de joindre le webhook bot');

            return false;
        }

        $handle = curl_init($this->webhookUrl());
        if ($handle === false) {
            return false;
        }

        curl_setopt_array($handle, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'X-Lusciana-Tickets-Key: ' . $this->ingestSecret(),
            ],
            CURLOPT_POSTFIELDS => '{}',
            CURLOPT_CONNECTTIMEOUT_MS => self::WEBHOOK_CONNECT_TIMEOUT_MS,
            CURLOPT_TIMEOUT_MS => self::WEBHOOK_TIMEOUT_MS,
        ]);

        $body = curl_exec($handle);
        $httpCode = (int) curl_getinfo($handle, CURLINFO_HTTP_CODE);
        $curlError = curl_error($handle);
        curl_close($handle);

        if ($curlError !== '') {
            error_log('[Lusciana] Webhook bot tickets: ' . $curlError);

            return false;
        }

        if ($httpCode < 200 || $httpCode >= 300) {
            error_log(sprintf(
                '[Lusciana] Webhook bot tickets HTTP %d: %s',
                $httpCode,
                is_string($body) ? substr($body, 0, 500) : ''
            ));

            return false;
        }

        if (is_string($body) && $body !== '') {
            $decoded = json_decode($body, true);
            if (is_array($decoded) && !empty($decoded['wlFailed'])) {
                error_log('[Lusciana] Webhook bot: echec RCON sur ' . (int) $decoded['wlFailed'] . ' pseudo(s)');

                return false;
            }
        }

        return true;
    }

    private function webhookUrl(): string
    {
        return trim((string) ($this->config['discord_bot_tickets_webhook_url'] ?? ''));
    }

    private function ingestSecret(): string
    {
        return trim((string) ($this->config['discord_tickets_ingest_secret'] ?? ''));
    }
}
