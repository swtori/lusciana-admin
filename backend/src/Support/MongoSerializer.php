<?php

declare(strict_types=1);

namespace App\Support;

use MongoDB\BSON\ObjectId;
use MongoDB\Model\BSONArray;
use MongoDB\Model\BSONDocument;

final class MongoSerializer
{
    public static function normalize(mixed $value): mixed
    {
        if ($value instanceof ObjectId) {
            return (string) $value;
        }

        if ($value instanceof BSONDocument || $value instanceof BSONArray) {
            $value = $value->getArrayCopy();
        }

        if (is_array($value)) {
            $normalized = [];

            foreach ($value as $key => $item) {
                $mappedKey = $key === '_id' ? 'id' : $key;
                $normalized[$mappedKey] = self::normalize($item);
            }

            return $normalized;
        }

        return $value;
    }
}
