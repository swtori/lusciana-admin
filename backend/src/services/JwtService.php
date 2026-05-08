<?php

declare(strict_types=1);

namespace App\Services;

use App\Exceptions\HttpException;

final class JwtService
{
    public function __construct(private readonly array $config)
    {
    }

    public function createAccessToken(array $user): string
    {
        $now = time();

        return $this->encode([
            'iss' => $this->config['app_url'],
            'sub' => $user['id'],
            'email' => $user['email'],
            'role' => $user['role'],
            'iat' => $now,
            'exp' => $now + $this->config['jwt_access_ttl'],
        ], $this->config['jwt_access_secret']);
    }

    public function createRefreshToken(array $user): array
    {
        $now = time();
        $tokenId = bin2hex(random_bytes(16));

        $token = $this->encode([
            'iss' => $this->config['app_url'],
            'sub' => $user['id'],
            'type' => 'refresh',
            'tokenVersion' => $user['tokenVersion'] ?? 0,
            'iat' => $now,
            'exp' => $now + $this->config['jwt_refresh_ttl'],
            'jti' => $tokenId,
        ], $this->config['jwt_refresh_secret']);

        return [
            'token' => $token,
            'tokenId' => $tokenId,
            'expiresAt' => $now + $this->config['jwt_refresh_ttl'],
        ];
    }

    public function decodeAccessToken(string $token): array
    {
        return $this->decode($token, $this->config['jwt_access_secret']);
    }

    public function decodeRefreshToken(string $token): array
    {
        return $this->decode($token, $this->config['jwt_refresh_secret']);
    }

    private function encode(array $payload, string $secret): string
    {
        $header = ['typ' => 'JWT', 'alg' => 'HS256'];

        $segments = [
            $this->base64UrlEncode(json_encode($header, JSON_UNESCAPED_SLASHES)),
            $this->base64UrlEncode(json_encode($payload, JSON_UNESCAPED_SLASHES)),
        ];

        $signature = hash_hmac('sha256', implode('.', $segments), $secret, true);
        $segments[] = $this->base64UrlEncode($signature);

        return implode('.', $segments);
    }

    private function decode(string $token, string $secret): array
    {
        $parts = explode('.', $token);

        if (count($parts) !== 3) {
            throw new HttpException('Token invalide', 401);
        }

        [$encodedHeader, $encodedPayload, $encodedSignature] = $parts;

        $header = json_decode($this->base64UrlDecode($encodedHeader), true);
        $payload = json_decode($this->base64UrlDecode($encodedPayload), true);

        if (!is_array($header) || !is_array($payload) || ($header['alg'] ?? null) !== 'HS256') {
            throw new HttpException('Token invalide', 401);
        }

        $expectedSignature = $this->base64UrlEncode(
            hash_hmac('sha256', $encodedHeader . '.' . $encodedPayload, $secret, true)
        );

        if (!hash_equals($expectedSignature, $encodedSignature)) {
            throw new HttpException('Token invalide', 401);
        }

        if (isset($payload['exp']) && time() >= (int) $payload['exp']) {
            throw new HttpException('Token expire', 401);
        }

        return $payload;
    }

    private function base64UrlEncode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    private function base64UrlDecode(string $data): string
    {
        $remainder = strlen($data) % 4;
        if ($remainder > 0) {
            $data .= str_repeat('=', 4 - $remainder);
        }

        return base64_decode(strtr($data, '-_', '+/')) ?: '';
    }
}
