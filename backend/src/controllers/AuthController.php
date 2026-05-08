<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Http\JsonResponse;
use App\Http\Request;
use App\Services\AuthService;
use App\Support\Validator;

final class AuthController
{
    public function __construct(private readonly AuthService $auth)
    {
    }

    public function login(Request $request, array $params): JsonResponse
    {
        Validator::requireFields($request->body, ['email', 'password']);
        Validator::ensureEmail((string) $request->body['email']);

        $session = $this->auth->login(
            (string) $request->body['email'],
            (string) $request->body['password'],
            $request
        );

        return new JsonResponse([
            'message' => 'Connexion reussie',
            ...$session,
        ]);
    }

    public function me(Request $request, array $params): JsonResponse
    {
        return new JsonResponse([
            'user' => $this->auth->authenticate($request),
        ]);
    }

    public function refresh(Request $request, array $params): JsonResponse
    {
        Validator::requireFields($request->body, ['refreshToken']);

        return new JsonResponse([
            'message' => 'Session renouvelee',
            ...$this->auth->refresh((string) $request->body['refreshToken'], $request),
        ]);
    }

    public function logout(Request $request, array $params): JsonResponse
    {
        Validator::requireFields($request->body, ['refreshToken']);
        $this->auth->logout((string) $request->body['refreshToken']);

        return new JsonResponse([
            'message' => 'Deconnexion reussie',
        ]);
    }

    public function changePassword(Request $request, array $params): JsonResponse
    {
        $user = $this->auth->authenticate($request);
        Validator::requireFields($request->body, ['currentPassword', 'newPassword']);

        $this->auth->rotatePassword(
            $user['id'],
            (string) $request->body['currentPassword'],
            (string) $request->body['newPassword']
        );

        return new JsonResponse([
            'message' => 'Mot de passe mis a jour',
        ]);
    }
}
