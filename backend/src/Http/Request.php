<?php

declare(strict_types=1);

namespace App\Http;

final class Request
{
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $query,
        public readonly array $body,
        public readonly array $headers,
        public readonly string $rawBody,
        public readonly array $cookies,
        public readonly string $ip,
        public readonly string $userAgent
    ) {
    }

    public static function capture(): self
    {
        $rawBody = file_get_contents('php://input') ?: '';
        $decoded = json_decode($rawBody, true);
        $body = is_array($decoded) ? $decoded : $_POST;

        $headers = function_exists('getallheaders') ? getallheaders() : [];
        $uriPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

        return new self(
            strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET'),
            rtrim($uriPath, '/') ?: '/',
            $_GET,
            is_array($body) ? $body : [],
            array_change_key_case($headers, CASE_LOWER),
            $rawBody,
            $_COOKIE,
            $_SERVER['REMOTE_ADDR'] ?? '',
            $_SERVER['HTTP_USER_AGENT'] ?? ''
        );
    }

    public function bearerToken(): ?string
    {
        $authorization = $this->headers['authorization'] ?? '';

        if (!str_starts_with($authorization, 'Bearer ')) {
            return null;
        }

        return substr($authorization, 7);
    }
}
