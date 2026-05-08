<?php

declare(strict_types=1);

namespace App\Services;

use App\Exceptions\HttpException;
use App\Http\Request;
use App\Repositories\RefreshTokenRepository;
use App\Repositories\UserRepository;
use App\Support\MongoSerializer;
use App\Support\Roles;
use MongoDB\BSON\UTCDateTime;

final class AuthService
{
    public function __construct(
        private readonly array $config,
        private readonly UserRepository $users,
        private readonly RefreshTokenRepository $refreshTokens,
        private readonly JwtService $jwt
    ) {
    }

    public function ensureSuperadmin(): void
    {
        $existing = $this->users->findByEmail($this->config['superadmin_email']);

        if ($existing !== null) {
            return;
        }

        $now = new UTCDateTime();

        $this->users->insert([
            'name' => $this->config['superadmin_name'],
            'email' => strtolower($this->config['superadmin_email']),
            'passwordHash' => password_hash($this->config['superadmin_password'], PASSWORD_BCRYPT),
            'role' => Roles::SUPERADMIN,
            'isActive' => true,
            'tokenVersion' => 0,
            'assignedAgentIds' => [],
            'lastLoginAt' => null,
            'createdAt' => $now,
            'updatedAt' => $now,
        ]);
    }

    public function login(string $email, string $password, Request $request): array
    {
        $user = $this->users->findByEmail($email);

        if ($user === null || empty($user['isActive'])) {
            throw new HttpException('Identifiants invalides', 401);
        }

        if (!password_verify($password, (string) $user['passwordHash'])) {
            throw new HttpException('Identifiants invalides', 401);
        }

        $userId = (string) $user['_id'];
        $this->users->update($userId, [
            'lastLoginAt' => new UTCDateTime(),
            'updatedAt' => new UTCDateTime(),
        ]);

        return $this->issueSession($this->users->findById($userId), $request);
    }

    public function authenticate(Request $request): array
    {
        $token = $request->bearerToken();

        if ($token === null) {
            throw new HttpException('Token manquant', 401);
        }

        try {
            $payload = $this->jwt->decodeAccessToken($token);
            $user = $this->users->findById((string) $payload['sub']);

            if ($user === null || empty($user['isActive'])) {
                throw new HttpException('Utilisateur invalide', 401);
            }

            return $this->publicUser($user);
        } catch (\Throwable) {
            throw new HttpException('Token invalide ou expire', 401);
        }
    }

    public function requireRole(Request $request, string $minimumRole): array
    {
        $user = $this->authenticate($request);

        if (!Roles::can($user['role'], $minimumRole)) {
            throw new HttpException('Permissions insuffisantes', 403);
        }

        return $user;
    }

    public function refresh(string $refreshToken, Request $request): array
    {
        try {
            $payload = $this->jwt->decodeRefreshToken($refreshToken);
        } catch (\Throwable) {
            throw new HttpException('Refresh token invalide', 401);
        }

        $stored = $this->refreshTokens->findOneActiveByTokenId((string) ($payload['jti'] ?? ''));

        if ($stored === null) {
            throw new HttpException('Refresh token invalide', 401);
        }

        if (!password_verify($refreshToken, (string) $stored['tokenHash'])) {
            throw new HttpException('Refresh token invalide', 401);
        }

        $user = $this->users->findById((string) $stored['userId']);

        if ($user === null || empty($user['isActive'])) {
            throw new HttpException('Utilisateur introuvable', 401);
        }

        if (($user['tokenVersion'] ?? 0) !== ($payload['tokenVersion'] ?? -1)) {
            throw new HttpException('Refresh token invalide', 401);
        }

        $this->refreshTokens->revokeByTokenId((string) $stored['tokenId']);

        return $this->issueSession($user, $request);
    }

    public function logout(string $refreshToken): void
    {
        try {
            $payload = $this->jwt->decodeRefreshToken($refreshToken);
            $this->refreshTokens->revokeByTokenId((string) ($payload['jti'] ?? ''));
        } catch (\Throwable) {
        }
    }

    public function rotatePassword(string $userId, string $currentPassword, string $newPassword): void
    {
        $user = $this->users->findById($userId);

        if ($user === null) {
            throw new HttpException('Utilisateur introuvable', 404);
        }

        if (!password_verify($currentPassword, (string) $user['passwordHash'])) {
            throw new HttpException('Mot de passe actuel invalide', 401);
        }

        $nextVersion = ((int) ($user['tokenVersion'] ?? 0)) + 1;

        $this->users->update($userId, [
            'passwordHash' => password_hash($newPassword, PASSWORD_BCRYPT),
            'tokenVersion' => $nextVersion,
            'updatedAt' => new UTCDateTime(),
        ]);

        $this->refreshTokens->revokeAllByUserId($userId);
    }

    public function invalidateSessions(string $userId): void
    {
        $this->refreshTokens->revokeAllByUserId($userId);
    }

    public function publicUser(?array $user): array
    {
        if ($user === null) {
            throw new HttpException('Utilisateur introuvable', 404);
        }

        $normalized = MongoSerializer::normalize($user);
        unset($normalized['passwordHash']);

        return $normalized;
    }

    private function issueSession(?array $user, Request $request): array
    {
        $normalized = $this->publicUser($user);
        $refreshData = $this->jwt->createRefreshToken($normalized);

        $this->refreshTokens->insert([
            'tokenId' => $refreshData['tokenId'],
            'userId' => $normalized['id'],
            'tokenHash' => password_hash($refreshData['token'], PASSWORD_BCRYPT),
            'expiresAt' => new UTCDateTime($refreshData['expiresAt'] * 1000),
            'revokedAt' => null,
            'userAgent' => $request->userAgent,
            'ipAddress' => $request->ip,
            'createdAt' => new UTCDateTime(),
            'updatedAt' => new UTCDateTime(),
        ]);

        return [
            'user' => $normalized,
            'accessToken' => $this->jwt->createAccessToken($normalized),
            'refreshToken' => $refreshData['token'],
        ];
    }
}
