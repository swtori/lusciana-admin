<?php

declare(strict_types=1);

namespace App\Services;

use App\Exceptions\HttpException;
use App\Http\Request;
use App\Repositories\AgentRepository;
use App\Repositories\RefreshTokenRepository;
use App\Repositories\UserRepository;
use App\Support\MongoSerializer;
use App\Support\Roles;
use App\Support\Validator;
use MongoDB\BSON\UTCDateTime;

final class TeamMemberOnboardService
{
    private const TEAM_CATEGORIES = [
        Roles::AGENT_TRIAL,
        Roles::AGENT_APPRENTICE,
        Roles::AGENT_BUILDER,
        Roles::AGENT_MANAGER,
    ];

    private const ONBOARD_CATEGORIES = [
        Roles::AGENT_TRIAL,
        Roles::AGENT_APPRENTICE,
    ];

    public function __construct(
        private readonly array $config,
        private readonly AgentRepository $agents,
        private readonly UserRepository $users,
        private readonly RefreshTokenRepository $refreshTokens
    ) {
    }

    public function isConfigured(): bool
    {
        return $this->botSecret() !== '';
    }

    public function assertBotKey(Request $request): void
    {
        $expected = $this->botSecret();
        if ($expected === '') {
            throw new HttpException(
                'API bot non configure. Ajoutez DISCORD_TICKETS_INGEST_SECRET dans .env',
                503
            );
        }

        $provided = trim((string) ($request->headers['x-lusciana-tickets-key'] ?? ''));
        if ($provided === '' || !hash_equals($expected, $provided)) {
            throw new HttpException('Cle API bot invalide', 401);
        }
    }

    /**
     * @param array<string, mixed> $body
     * @return array<string, mixed>
     */
    public function onboardFromBot(array $body): array
    {
        Validator::requireFields($body, ['minecraftIgn', 'category']);
        $minecraftIgn = trim((string) $body['minecraftIgn']);
        $category = $this->normalizeCategory((string) $body['category']);

        Validator::ensureInArray($category, self::ONBOARD_CATEGORIES, 'category');

        if ($minecraftIgn === '' || !preg_match('/^[a-zA-Z0-9_]{1,16}$/', $minecraftIgn)) {
            throw new HttpException(
                'Le pseudo Minecraft doit contenir entre 1 et 16 caracteres (lettres, chiffres, underscore)',
                422
            );
        }

        $existing = $this->agents->findByPseudo($minecraftIgn);
        if ($existing !== null) {
            throw new HttpException('Un agent avec ce pseudo existe deja sur le site', 409);
        }

        $discordUserId = trim((string) ($body['discordUserId'] ?? ''));
        $discordTag = trim((string) ($body['discordTag'] ?? ''));
        $discordField = $this->formatDiscordField($discordUserId, $discordTag);

        $now = new UTCDateTime();
        $agentId = $this->agents->insert([
            'pseudo' => $minecraftIgn,
            'discord' => $discordField,
            'discordUserId' => $discordUserId !== '' ? $discordUserId : null,
            'paymentMethods' => [],
            'pf' => '',
            'category' => $category,
            'isCurrentTeamMember' => true,
            'commissionRate' => 0.0,
            'memberSince' => (string) ($body['memberSince'] ?? date('Y-m-d')),
            'isCompany' => false,
            'iban' => '',
            'country' => '',
            'address' => '',
            'companyName' => '',
            'teamOnboardAt' => $now,
            'teamOnboardBy' => $this->formatExecutor($body),
            'teamOnboardReason' => $this->normalizeReason($body),
            'createdAt' => $now,
            'updatedAt' => $now,
        ]);

        try {
            $agent = MongoSerializer::normalize($this->agents->findById($agentId));
            $credentials = $this->createLinkedUserForAgent($agent, $now);
        } catch (\Throwable $exception) {
            $this->agents->delete($agentId);
            throw $exception;
        }

        return [
            'message' => 'Membre integre sur le site',
            'agent' => MongoSerializer::normalize($this->agents->findById($agentId)),
            'credentials' => $credentials,
            'loginUrl' => rtrim((string) ($this->config['frontend_url'] ?? ''), '/'),
            'executedBy' => $this->formatExecutor($body),
            'reason' => $this->normalizeReason($body),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function lookupByDiscordUserId(string $discordUserId): array
    {
        $agent = $this->resolveTeamAgentByDiscordUserId($discordUserId);

        return [
            'item' => MongoSerializer::normalize($agent),
            'minecraftIgn' => (string) ($agent['pseudo'] ?? ''),
        ];
    }

    /**
     * @param array<string, mixed> $body
     * @return array<string, mixed>
     */
    public function removeFromBot(array $body): array
    {
        Validator::requireFields($body, ['discordUserId']);
        $discordUserId = trim((string) $body['discordUserId']);

        $rawAgent = $this->agents->findByDiscordUserId($discordUserId);
        if ($rawAgent === null) {
            throw new HttpException('Aucun agent trouve pour ce membre Discord sur le site', 404);
        }

        $agent = MongoSerializer::normalize($rawAgent);
        $category = (string) ($agent['category'] ?? '');
        if (!in_array($category, self::TEAM_CATEGORIES, true)) {
            throw new HttpException(
                'Cet agent n est pas un membre equipe (trial, apprentice, builder ou manager)',
                422
            );
        }

        $agentId = (string) ($agent['id'] ?? '');
        $pseudo = (string) ($agent['pseudo'] ?? '');
        if ($agentId === '' || $pseudo === '') {
            throw new HttpException('Agent introuvable', 404);
        }

        $removedEmail = null;
        $userDeleted = false;
        $linkedUser = $this->users->findByAgentId($agentId);
        if ($linkedUser !== null) {
            $userId = (string) ($linkedUser['_id'] ?? '');
            $removedEmail = (string) ($linkedUser['email'] ?? '');
            if ($userId !== '') {
                try {
                    $this->refreshTokens->revokeAllByUserId($userId);
                } catch (\Throwable) {
                    // tokens optionnels — on continue la suppression
                }
                $userDeleted = $this->users->deleteByAgentId($agentId);
            }
        }

        try {
            if (!$this->agents->delete($agentId)) {
                throw new HttpException('Agent introuvable', 404);
            }
        } catch (\MongoDB\Driver\Exception\Exception $exception) {
            throw new HttpException('Suppression agent impossible : ' . $exception->getMessage(), 500);
        }

        return [
            'message' => 'Membre retire du site — compte et identifiants supprimes',
            'minecraftIgn' => $pseudo,
            'pseudo' => $pseudo,
            'category' => $category,
            'removedEmail' => $removedEmail,
            'userDeleted' => $userDeleted,
            'executedBy' => $this->formatExecutor($body),
            'reason' => $this->normalizeReason($body),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function resolveTeamAgentByDiscordUserId(string $discordUserId): array
    {
        $discordUserId = trim($discordUserId);
        if ($discordUserId === '' || !ctype_digit($discordUserId)) {
            throw new HttpException('discordUserId invalide', 422);
        }

        $rawAgent = $this->agents->findByDiscordUserId($discordUserId);
        if ($rawAgent === null) {
            throw new HttpException('Aucun agent trouve pour ce membre Discord sur le site', 404);
        }

        $agent = MongoSerializer::normalize($rawAgent);
        $category = (string) ($agent['category'] ?? '');
        if (!in_array($category, self::TEAM_CATEGORIES, true)) {
            throw new HttpException(
                'Cet agent n est pas un membre equipe (trial, apprentice, builder ou manager)',
                422
            );
        }

        return $agent;
    }

    private function botSecret(): string
    {
        return trim((string) ($this->config['discord_tickets_ingest_secret'] ?? ''));
    }

    private function normalizeCategory(string $raw): string
    {
        return strtolower(trim($raw));
    }

    /**
     * @param array<string, mixed> $body
     */
    private function normalizeReason(array $body): string
    {
        return trim((string) ($body['reason'] ?? ''));
    }

    /**
     * @param array<string, mixed> $body
     */
    private function formatExecutor(array $body): string
    {
        $discordUserId = trim((string) ($body['executedByDiscordId'] ?? ''));
        $tag = trim((string) ($body['executedByTag'] ?? ''));
        $username = trim((string) ($body['executedByUsername'] ?? ''));

        if ($discordUserId !== '') {
            $mention = '<@' . $discordUserId . '>';
            $label = $username !== '' ? $username : ($tag !== '' ? $tag : $discordUserId);

            return $mention . ' (' . $label . ')';
        }

        if ($tag !== '') {
            return $tag;
        }

        return $username;
    }

    private function formatDiscordField(string $discordUserId, string $discordTag): string
    {
        if ($discordUserId !== '') {
            $mention = '<@' . $discordUserId . '>';
            if ($discordTag !== '') {
                return $mention . ' (' . $discordTag . ')';
            }

            return $mention;
        }

        return $discordTag;
    }

    /**
     * @param array<string, mixed> $agent
     * @return array{email: string, password: string}|null
     */
    private function createLinkedUserForAgent(array $agent, UTCDateTime $now): ?array
    {
        $agentId = (string) ($agent['id'] ?? '');
        if ($agentId === '') {
            throw new HttpException('Agent introuvable', 404);
        }

        if ($this->users->findByAgentId($agentId) !== null) {
            throw new HttpException('Cet agent possede deja un compte', 409);
        }

        $email = $this->buildAgentEmail((string) ($agent['pseudo'] ?? ''));
        $role = Roles::BUILDER;
        $existingUser = $this->users->findByEmail($email);

        if ($existingUser !== null) {
            $existingUserId = (string) ($existingUser['_id'] ?? '');
            $existingAgentId = (string) ($existingUser['agentId'] ?? '');
            $existingAssignedAgentIds = array_values(array_filter(
                array_map('strval', $existingUser['assignedAgentIds'] ?? []),
                static fn (string $value): bool => $value !== ''
            ));
            $existingRole = (string) ($existingUser['role'] ?? '');

            if ($existingAgentId !== '' || $existingAssignedAgentIds !== []) {
                throw new HttpException('Cet email existe deja', 409);
            }

            if ($existingRole !== $role) {
                throw new HttpException('Un compte avec cet email existe deja avec un role incompatible', 409);
            }

            if ($existingUserId === '') {
                throw new HttpException('Utilisateur introuvable', 404);
            }

            $this->users->update($existingUserId, [
                'name' => (string) ($agent['pseudo'] ?? ''),
                'email' => $email,
                'role' => $role,
                'agentId' => $agentId,
                'assignedAgentIds' => [$agentId],
                'updatedAt' => $now,
            ]);

            return null;
        }

        $plainPassword = $this->generateInitialPassword();

        $this->users->insert([
            'name' => (string) ($agent['pseudo'] ?? ''),
            'email' => $email,
            'passwordHash' => password_hash($plainPassword, PASSWORD_BCRYPT),
            'role' => $role,
            'isActive' => true,
            'tokenVersion' => 0,
            'assignedAgentIds' => [$agentId],
            'agentId' => $agentId,
            'lastLoginAt' => null,
            'createdAt' => $now,
            'updatedAt' => $now,
        ]);

        return [
            'email' => $email,
            'password' => $plainPassword,
        ];
    }

    private function buildAgentEmail(string $pseudo): string
    {
        $localPart = strtolower(trim($pseudo));
        $localPart = preg_replace('/[^a-z0-9._-]+/i', '.', $localPart) ?? '';
        $localPart = trim($localPart, '.');

        if ($localPart === '') {
            throw new HttpException('Le pseudo ne permet pas de generer un email valide', 422);
        }

        return $localPart . '@lusciana.fr';
    }

    private function generateInitialPassword(): string
    {
        return 'Lus!' . strtoupper(bin2hex(random_bytes(4))) . '9a';
    }
}
