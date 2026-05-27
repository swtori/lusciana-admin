<?php

declare(strict_types=1);

namespace App\Support;

final class Roles
{
    public const GUEST = 'guest';
    public const BUILDER = 'builder';
    public const MANAGER = 'manager';
    public const ADMIN = 'admin';
    public const SUPERADMIN = 'superadmin';

    public const AGENT_CLIENT = 'client';
    public const AGENT_APPRENTICE = 'apprentice';
    public const AGENT_BUILDER = 'builder';
    public const AGENT_MANAGER = 'manager';

    private const HIERARCHY = [
        self::GUEST,
        self::BUILDER,
        self::MANAGER,
        self::ADMIN,
        self::SUPERADMIN,
    ];

    public static function all(): array
    {
        return self::HIERARCHY;
    }

    public static function can(string $currentRole, string $minimumRole): bool
    {
        return array_search($currentRole, self::HIERARCHY, true) >= array_search($minimumRole, self::HIERARCHY, true);
    }
}
