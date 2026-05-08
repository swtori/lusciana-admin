<?php

declare(strict_types=1);

namespace App\Http;

use App\Exceptions\HttpException;

final class Router
{
    /** @var array<int, array{method: string, path: string, handler: callable}> */
    private array $routes = [];

    public function add(string $method, string $path, callable $handler): void
    {
        $this->routes[] = [
            'method' => strtoupper($method),
            'path' => rtrim($path, '/') ?: '/',
            'handler' => $handler,
        ];
    }

    public function dispatch(Request $request): JsonResponse
    {
        foreach ($this->routes as $route) {
            if ($route['method'] !== $request->method) {
                continue;
            }

            $params = $this->match($route['path'], $request->path);

            if ($params === null) {
                continue;
            }

            return $route['handler']($request, $params);
        }

        throw new HttpException('Route introuvable', 404);
    }

    private function match(string $routePath, string $requestPath): ?array
    {
        $routeParts = explode('/', trim($routePath, '/'));
        $requestParts = explode('/', trim($requestPath, '/'));

        if ($routePath === '/' && $requestPath === '/') {
            return [];
        }

        if (count($routeParts) !== count($requestParts)) {
            return null;
        }

        $params = [];

        foreach ($routeParts as $index => $routePart) {
            $requestPart = $requestParts[$index] ?? '';

            if (str_starts_with($routePart, ':')) {
                $params[substr($routePart, 1)] = $requestPart;
                continue;
            }

            if ($routePart !== $requestPart) {
                return null;
            }
        }

        return $params;
    }
}
