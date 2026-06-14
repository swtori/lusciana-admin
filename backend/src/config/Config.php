<?php

declare(strict_types=1);

namespace App\Config;

use Dotenv\Dotenv;
use RuntimeException;

final class Config
{
    public static function load(string $projectRoot): array
    {
        if (file_exists($projectRoot . '/.env')) {
            Dotenv::createImmutable($projectRoot)->safeLoad();
        }

        $required = [
            'APP_ENV',
            'APP_URL',
            'FRONTEND_URL',
            'MONGODB_URI',
            'JWT_ACCESS_SECRET',
            'JWT_REFRESH_SECRET',
            'SUPERADMIN_EMAIL',
            'SUPERADMIN_PASSWORD',
        ];

        foreach ($required as $key) {
            if (empty($_ENV[$key]) && empty($_SERVER[$key])) {
                throw new RuntimeException(sprintf('Variable d environnement manquante: %s', $key));
            }
        }

        $frontendRaw = self::env('FRONTEND_URL', 'http://localhost:8080');
        $frontendOrigins = self::parseCommaSeparatedList($frontendRaw);
        if ($frontendOrigins === []) {
            throw new RuntimeException('FRONTEND_URL doit contenir au moins une origine (URL de base du front, sans chemin). Plusieurs origines: separees par une virgule.');
        }

        return [
            'app_env' => self::env('APP_ENV', 'production'),
            'app_url' => self::env('APP_URL', 'http://localhost:4000'),
            'frontend_url' => $frontendOrigins[0],
            'frontend_origins' => $frontendOrigins,
            'mongodb_uri' => self::env('MONGODB_URI'),
            'database_name' => self::env('MONGODB_DATABASE', 'lusciana'),
            'jwt_access_secret' => self::env('JWT_ACCESS_SECRET'),
            'jwt_refresh_secret' => self::env('JWT_REFRESH_SECRET'),
            'jwt_access_ttl' => (int) self::env('JWT_ACCESS_TTL', '900'),
            'jwt_refresh_ttl' => (int) self::env('JWT_REFRESH_TTL', '28800'),
            'superadmin_email' => self::env('SUPERADMIN_EMAIL'),
            'superadmin_password' => self::env('SUPERADMIN_PASSWORD'),
            'superadmin_name' => self::env('SUPERADMIN_NAME', 'Lusciana Owner'),
            'schematics_upload_dir' => self::env(
                'SCHEMATICS_UPLOAD_DIR',
                '/home/luna/luna-minecraft/plugins/FastAsyncWorldEdit/schematics'
            ),
            'schematics_max_mb' => max(1, (int) self::env('SCHEMATICS_MAX_MB', '64')),
            'discord_bot_token' => self::optionalEnv('DISCORD_BOT_TOKEN'),
            'discord_guild_id' => self::optionalEnv('DISCORD_GUILD_ID'),
            'discord_ticket_name_prefix' => self::optionalEnv('DISCORD_TICKET_NAME_PREFIX', 'ticket-'),
            'discord_ticket_category_id' => self::optionalEnv('DISCORD_TICKET_CATEGORY_ID'),
            'discord_tickets_ingest_secret' => self::optionalEnv('DISCORD_TICKETS_INGEST_SECRET'),
            'discord_bot_tickets_webhook_url' => self::optionalEnv(
                'DISCORD_BOT_TICKETS_WEBHOOK_URL',
                'http://127.0.0.1:3847/internal/discord-tickets/process-pending'
            ),
        ];
    }

    private static function optionalEnv(string $key, string $default = ''): string
    {
        $value = $_ENV[$key] ?? $_SERVER[$key] ?? $default;

        return is_string($value) ? trim($value) : $default;
    }

    private static function env(string $key, ?string $default = null): string
    {
        $value = $_ENV[$key] ?? $_SERVER[$key] ?? $default;

        if ($value === null) {
            throw new RuntimeException(sprintf('Variable d environnement introuvable: %s', $key));
        }

        return $value;
    }

    /**
     * @return list<string>
     */
    private static function parseCommaSeparatedList(string $raw): array
    {
        $out = [];
        foreach (explode(',', $raw) as $part) {
            $item = rtrim(trim((string) $part), '/');
            if ($item !== '') {
                $out[] = $item;
            }
        }

        return $out;
    }
}
