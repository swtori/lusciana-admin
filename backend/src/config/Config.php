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
        ];
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
