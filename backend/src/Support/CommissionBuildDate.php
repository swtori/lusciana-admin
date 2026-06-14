<?php

declare(strict_types=1);

namespace App\Support;

final class CommissionBuildDate
{
  /** @var array<string, int> */
    private const MONTH_MAP = [
        'janvier' => 1,
        'fevrier' => 2,
        'mars' => 3,
        'avril' => 4,
        'mai' => 5,
        'juin' => 6,
        'juillet' => 7,
        'aout' => 8,
        'septembre' => 9,
        'octobre' => 10,
        'novembre' => 11,
        'decembre' => 12,
    ];

    public static function normalize(string $value, bool $endOfMonth = false, int $defaultYear = 2025): string
    {
        $trimmed = trim($value);
        if ($trimmed === '') {
            return '';
        }

        if (preg_match('/^(\d{4})-(\d{2})-(\d{2})/', $trimmed, $matches) === 1) {
            $year = (int) $matches[1];
            $month = (int) $matches[2];
            $day = (int) $matches[3];

            if ($year < 1900 || $year > 2100 || $month < 1 || $month > 12 || $day < 1 || $day > 31) {
                return '';
            }

            return sprintf('%04d-%02d-%02d', $year, $month, $day);
        }

        $monthKey = self::normalizeMonthKey($trimmed);
        if ($monthKey === null) {
            return $trimmed;
        }

        $month = self::MONTH_MAP[$monthKey];
        if ($endOfMonth) {
            return date('Y-m-t', mktime(0, 0, 0, $month, 1, $defaultYear));
        }

        return sprintf('%04d-%02d-01', $defaultYear, $month);
    }

    public static function isFrenchMonthName(string $value): bool
    {
        return self::normalizeMonthKey($value) !== null;
    }

    public static function needsNormalization(string $value, bool $endOfMonth = false, int $defaultYear = 2025): bool
    {
        $trimmed = trim($value);
        if ($trimmed === '') {
            return false;
        }

        $normalized = self::normalize($trimmed, $endOfMonth, $defaultYear);
        return $normalized !== '' && $normalized !== $trimmed;
    }

    private static function normalizeMonthKey(string $value): ?string
    {
        $key = mb_strtolower(trim($value));
        $key = str_replace(
            ['é', 'è', 'ê', 'ë', 'û', 'ô', 'à', 'â', 'ù', 'ï', 'î'],
            ['e', 'e', 'e', 'e', 'u', 'o', 'a', 'a', 'u', 'i', 'i'],
            $key
        );

        return isset(self::MONTH_MAP[$key]) ? $key : null;
    }
}
