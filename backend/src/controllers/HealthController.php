<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Http\JsonResponse;
use App\Http\Request;

final class HealthController
{
    public function __invoke(Request $request, array $params): JsonResponse
    {
        return new JsonResponse([
            'status' => 'ok',
            'service' => 'lusciana-backend-php',
            'timestamp' => gmdate(DATE_ATOM),
        ]);
    }
}
