<?php

declare(strict_types=1);

namespace App;

use App\Controllers\AgentsController;
use App\Controllers\AccountController;
use App\Controllers\AuthController;
use App\Controllers\CommissionsController;
use App\Controllers\ExpensesController;
use App\Controllers\HealthController;
use App\Controllers\TodosController;
use App\Controllers\UsersController;
use App\Exceptions\HttpException;
use App\Http\JsonResponse;
use App\Http\Request;
use App\Http\Router;
use App\Repositories\AgentRepository;
use App\Repositories\CommissionRepository;
use App\Repositories\ExpenseRepository;
use App\Repositories\RefreshTokenRepository;
use App\Repositories\TodoRepository;
use App\Repositories\UserRepository;
use App\Services\AuthService;
use App\Services\HistoricalImportService;
use App\Services\JwtService;
use MongoDB\Database;

final class App
{
    private Router $router;

    public function __construct(
        private readonly array $config,
        private readonly Database $database
    ) {
        $this->router = new Router();
        $this->registerRoutes();
    }

    public function run(): void
    {
        $request = Request::capture();

        header('Access-Control-Allow-Origin: ' . $this->config['frontend_url']);
        header('Access-Control-Allow-Headers: Content-Type, Authorization');
        header('Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS');

        if ($request->method === 'OPTIONS') {
            http_response_code(204);
            return;
        }

        try {
            $response = $this->router->dispatch($request);
        } catch (HttpException $exception) {
            $response = new JsonResponse([
                'message' => $exception->getMessage(),
                'details' => $exception->details(),
            ], $exception->statusCode());
        } catch (\Throwable $exception) {
            $response = new JsonResponse([
                'message' => $this->config['app_env'] === 'production'
                    ? 'Erreur interne du serveur'
                    : $exception->getMessage(),
            ], 500);
        }

        $response->send();
    }

    private function registerRoutes(): void
    {
        $userRepository = new UserRepository($this->database);
        $refreshTokenRepository = new RefreshTokenRepository($this->database);
        $agentRepository = new AgentRepository($this->database);
        $commissionRepository = new CommissionRepository($this->database);
        $expenseRepository = new ExpenseRepository($this->database);
        $todoRepository = new TodoRepository($this->database);

        $jwt = new JwtService($this->config);
        $auth = new AuthService($this->config, $userRepository, $refreshTokenRepository, $jwt);
        $historicalImport = new HistoricalImportService($this->database, dirname(__DIR__));
        $historicalImport->importIfAvailable();
        $auth->ensureSuperadmin();

        $health = new HealthController();
        $authController = new AuthController($auth);
        $account = new AccountController($agentRepository, $userRepository, $auth);
        $users = new UsersController($userRepository, $agentRepository, $auth);
        $agents = new AgentsController($agentRepository, $userRepository, $auth);
        $commissions = new CommissionsController($commissionRepository, $agentRepository, $auth);
        $expenses = new ExpensesController($expenseRepository, $auth);
        $todos = new TodosController($todoRepository, $auth);

        $this->router->add('GET', '/api/health', $health);

        $this->router->add('POST', '/api/auth/login', [$authController, 'login']);
        $this->router->add('GET', '/api/auth/me', [$authController, 'me']);
        $this->router->add('POST', '/api/auth/refresh', [$authController, 'refresh']);
        $this->router->add('POST', '/api/auth/logout', [$authController, 'logout']);
        $this->router->add('POST', '/api/auth/change-password', [$authController, 'changePassword']);
        $this->router->add('GET', '/api/account', [$account, 'show']);
        $this->router->add('PATCH', '/api/account', [$account, 'update']);

        $this->router->add('GET', '/api/users', [$users, 'list']);
        $this->router->add('POST', '/api/users', [$users, 'create']);
        $this->router->add('PATCH', '/api/users/:id', [$users, 'update']);

        $this->router->add('GET', '/api/agents', [$agents, 'list']);
        $this->router->add('GET', '/api/agents/:id', [$agents, 'show']);
        $this->router->add('POST', '/api/agents', [$agents, 'create']);
        $this->router->add('PATCH', '/api/agents/:id', [$agents, 'update']);
        $this->router->add('DELETE', '/api/agents/:id', [$agents, 'delete']);

        $this->router->add('GET', '/api/commissions', [$commissions, 'list']);
        $this->router->add('GET', '/api/commissions/:id', [$commissions, 'show']);
        $this->router->add('POST', '/api/commissions', [$commissions, 'create']);
        $this->router->add('PATCH', '/api/commissions/:id', [$commissions, 'update']);
        $this->router->add('DELETE', '/api/commissions/:id', [$commissions, 'delete']);

        $this->router->add('GET', '/api/expenses', [$expenses, 'list']);
        $this->router->add('POST', '/api/expenses', [$expenses, 'create']);
        $this->router->add('PATCH', '/api/expenses/:id', [$expenses, 'update']);
        $this->router->add('DELETE', '/api/expenses/:id', [$expenses, 'delete']);

        $this->router->add('GET', '/api/todos', [$todos, 'list']);
        $this->router->add('POST', '/api/todos', [$todos, 'create']);
        $this->router->add('PATCH', '/api/todos/:id', [$todos, 'update']);
        $this->router->add('DELETE', '/api/todos/:id', [$todos, 'delete']);
    }
}
