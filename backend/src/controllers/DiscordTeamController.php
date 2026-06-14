<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Http\JsonResponse;
use App\Http\Request;
use App\Services\TeamMemberOnboardService;

final class DiscordTeamController
{
    public function __construct(
        private readonly TeamMemberOnboardService $onboard
    ) {
    }

    public function onboard(Request $request, array $params): JsonResponse
    {
        $this->onboard->assertBotKey($request);
        $result = $this->onboard->onboardFromBot($request->body);

        return new JsonResponse($result, 201);
    }

    public function lookup(Request $request, array $params): JsonResponse
    {
        $this->onboard->assertBotKey($request);
        $discordUserId = (string) ($params['discordUserId'] ?? '');
        $result = $this->onboard->lookupByDiscordUserId($discordUserId);

        return new JsonResponse($result);
    }

    public function remove(Request $request, array $params): JsonResponse
    {
        $this->onboard->assertBotKey($request);
        $result = $this->onboard->removeFromBot($request->body);

        return new JsonResponse($result);
    }
}
