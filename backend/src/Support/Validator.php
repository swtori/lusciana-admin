<?php

declare(strict_types=1);

namespace App\Support;

use App\Exceptions\HttpException;

final class Validator
{
    public static function requireFields(array $data, array $fields): void
    {
        $missing = [];

        foreach ($fields as $field) {
            if (!array_key_exists($field, $data) || $data[$field] === '' || $data[$field] === null) {
                $missing[] = $field;
            }
        }

        if ($missing !== []) {
            throw new HttpException('Champs obligatoires manquants', 422, ['fields' => $missing]);
        }
    }

    public static function ensureEmail(string $email): void
    {
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new HttpException('Adresse email invalide', 422);
        }
    }

    public static function ensureInArray(string $value, array $allowed, string $field): void
    {
        if (!in_array($value, $allowed, true)) {
            throw new HttpException(sprintf('Valeur invalide pour %s', $field), 422);
        }
    }
}
