<?php

declare(strict_types=1);

namespace App\Config;

use MongoDB\Client;
use MongoDB\Database as MongoDatabase;

final class Database
{
    public function __construct(private readonly array $config)
    {
    }

    public function database(): MongoDatabase
    {
        $client = new Client(
            $this->config['mongodb_uri'],
            [],
            [
                'typeMap' => [
                    'root' => 'array',
                    'document' => 'array',
                    'array' => 'array',
                ],
            ]
        );

        return $client->selectDatabase($this->config['database_name']);
    }
}
