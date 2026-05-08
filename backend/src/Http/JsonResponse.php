<?php

declare(strict_types=1);

namespace App\Http;

final class JsonResponse
{
    public function __construct(
        private readonly array $payload,
        private readonly int $status = 200
    ) {
    }

    public function send(): void
    {
        http_response_code($this->status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($this->payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }
}
