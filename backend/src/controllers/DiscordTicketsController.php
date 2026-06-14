<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Exceptions\HttpException;
use App\Http\JsonResponse;
use App\Http\Request;
use App\Repositories\DiscordTicketRepository;
use App\Services\AuthService;
use App\Services\DiscordBotTicketNotifyService;
use App\Services\DiscordSyncService;
use App\Services\DiscordTicketIngestService;
use App\Support\MongoSerializer;
use App\Support\Roles;
use App\Support\Validator;
use MongoDB\BSON\UTCDateTime;

final class DiscordTicketsController
{
    private const STATUSES = ['open', 'in_progress', 'quoted', 'handled', 'archived'];
    private const CLIENT_WL = ['none', 'whitelist', 'blacklist'];
    private const WL_ACTIONS = ['add', 'remove'];

    public function __construct(
        private readonly DiscordTicketRepository $tickets,
        private readonly DiscordSyncService $discordSync,
        private readonly DiscordTicketIngestService $ticketIngest,
        private readonly DiscordBotTicketNotifyService $botNotify,
        private readonly AuthService $auth
    ) {
    }

    public function list(Request $request, array $params): JsonResponse
    {
        $this->auth->authenticate($request);

        return new JsonResponse([
            'items' => array_map(
                fn (array $item) => MongoSerializer::normalize($item),
                $this->tickets->findAll()
            ),
            'discordConfigured' => $this->discordSync->isConfigured(),
            'botIngestConfigured' => $this->ticketIngest->isConfigured(),
            'integrationMode' => $this->ticketIngest->integrationMode(),
        ]);
    }

    /**
     * Appelé par ton bot Discord (cle X-Lusciana-Tickets-Key).
     */
    public function ingest(Request $request, array $params): JsonResponse
    {
        $this->ticketIngest->assertIngestKey($request);
        $stats = $this->ticketIngest->ingestPayload($request->body);

        return new JsonResponse([
            'message' => 'Ticket(s) ingere(s)',
            'stats' => $stats,
        ]);
    }

    /**
     * Ton bot recupere les changements faits dans l admin (statut, desc, WL).
     */
    public function pending(Request $request, array $params): JsonResponse
    {
        $this->ticketIngest->assertIngestKey($request);

        return new JsonResponse([
            'items' => array_map(
                fn (array $item) => MongoSerializer::normalize($item),
                $this->ticketIngest->pendingForBot()
            ),
        ]);
    }

    /**
     * Ton bot confirme avoir applique les changements admin.
     */
    public function ack(Request $request, array $params): JsonResponse
    {
        $this->ticketIngest->assertIngestKey($request);
        $channelIds = $request->body['channelIds'] ?? $request->body['discordChannelIds'] ?? [];
        if (!is_array($channelIds) || $channelIds === []) {
            throw new HttpException('channelIds obligatoire', 422);
        }

        $count = $this->ticketIngest->acknowledgeBotSync($channelIds);

        return new JsonResponse([
            'message' => 'Accuse de reception enregistre',
            'acknowledged' => $count,
        ]);
    }

    /**
     * Secours : import direct des salons Discord via l API (si le bot ne pousse pas).
     */
    public function sync(Request $request, array $params): JsonResponse
    {
        $this->auth->requireRole($request, Roles::MANAGER);
        $stats = $this->discordSync->sync();

        return new JsonResponse([
            'message' => 'Synchronisation Discord terminee',
            'stats' => $stats,
            'items' => array_map(
                fn (array $item) => MongoSerializer::normalize($item),
                $this->tickets->findAll()
            ),
        ]);
    }

    public function update(Request $request, array $params): JsonResponse
    {
        $user = $this->auth->requireRole($request, Roles::MANAGER);
        $body = $request->body;
        $payload = [];
        $now = new UTCDateTime();

        if (array_key_exists('status', $body)) {
            $status = (string) $body['status'];
            Validator::ensureInArray($status, self::STATUSES, 'status');
            $payload['status'] = $status;
        }

        if (array_key_exists('description', $body)) {
            $payload['description'] = trim((string) $body['description']);
            $payload['descriptionUpdatedBy'] = self::descriptionEditorLabel($user);
            $payload['descriptionUpdatedAt'] = $now;
        }

        if (array_key_exists('clientWl', $body)) {
            $clientWl = (string) $body['clientWl'];
            Validator::ensureInArray($clientWl, self::CLIENT_WL, 'clientWl');
            $payload['clientWl'] = $clientWl;
        }

        if (array_key_exists('wlAction', $body)) {
            $wlAction = (string) $body['wlAction'];
            Validator::ensureInArray($wlAction, self::WL_ACTIONS, 'wlAction');

            if (!array_key_exists('minecraftNicknames', $body)) {
                throw new HttpException('minecraftNicknames requis avec wlAction', 422);
            }

            $nicknames = self::normalizeMinecraftNicknames($body['minecraftNicknames']);
            if ($nicknames === []) {
                throw new HttpException('Au moins un pseudo Minecraft requis', 422);
            }

            $existing = $this->tickets->findById($params['id']);
            if ($existing === null) {
                throw new HttpException('Ticket introuvable', 404);
            }

            $current = self::normalizeMinecraftNicknames($existing['minecraftNicknames'] ?? []);

            $payload['pendingWlAction'] = $wlAction;
            $payload['pendingWlNicknames'] = self::mergePendingWlNicknames(
                $existing,
                $wlAction,
                $nicknames
            );

            if ($wlAction === 'add') {
                $merged = $current;
                foreach ($nicknames as $nickname) {
                    if (!in_array($nickname, $merged, true)) {
                        $merged[] = $nickname;
                    }
                }
                $payload['minecraftNicknames'] = $merged;
                $payload['clientWl'] = 'whitelist';
            } else {
                $payload['minecraftNicknames'] = array_values(array_filter(
                    $current,
                    static fn (string $nickname) => !in_array($nickname, $nicknames, true)
                ));
                if ($payload['minecraftNicknames'] === []) {
                    $payload['clientWl'] = 'none';
                }
            }
        }

        if ($payload === []) {
            throw new HttpException('Aucun champ modifiable fourni', 422);
        }

        $payload['updatedAt'] = $now;
        $payload['updatedBy'] = 'admin';

        $needsBotSync = array_key_exists('status', $body)
            || array_key_exists('clientWl', $body)
            || array_key_exists('wlAction', $body);
        if ($needsBotSync) {
            $payload['needsBotSync'] = true;
        }

        if (!$this->tickets->update($params['id'], $payload)) {
            throw new HttpException('Ticket introuvable', 404);
        }

        $botSyncTriggered = false;
        if ($needsBotSync) {
            $botSyncTriggered = $this->botNotify->triggerPendingSync();
        }

        $item = MongoSerializer::normalize($this->tickets->findById($params['id']));
        $response = [
            'message' => 'Ticket mis a jour',
            'item' => $item,
            'botSyncTriggered' => $botSyncTriggered,
        ];

        if (array_key_exists('wlAction', $body)) {
            if (!$botSyncTriggered) {
                $response['warning'] = 'Webhook bot injoignable ou RCON en echec. Verifiez DISCORD_BOT_TICKETS_WEBHOOK_URL (meme VPS que le bot) et MINECRAFT_RCON_* sur le bot.';
            } elseif (!empty($item['needsBotSync'])) {
                $response['warning'] = 'RCON Minecraft en echec — reessayez dans quelques secondes.';
            }
        }

        return new JsonResponse($response);
    }

    /**
     * @param array<string,mixed> $existing
     * @param list<string> $newNicknames
     * @return list<string>
     */
    private static function mergePendingWlNicknames(array $existing, string $wlAction, array $newNicknames): array
    {
        $previousAction = (string) ($existing['pendingWlAction'] ?? '');
        $previous = self::normalizeMinecraftNicknames($existing['pendingWlNicknames'] ?? []);

        if ($previousAction === $wlAction && $previous !== []) {
            $merged = $previous;
            foreach ($newNicknames as $nickname) {
                if (!in_array($nickname, $merged, true)) {
                    $merged[] = $nickname;
                }
            }

            return $merged;
        }

        return $newNicknames;
    }

    /**
     * @return list<string>
     */
    private static function normalizeMinecraftNicknames(mixed $raw): array
    {
        if (is_string($raw)) {
            $parts = preg_split('/[\s,;]+/', $raw) ?: [];
        } elseif (is_array($raw)) {
            $parts = $raw;
        } else {
            throw new HttpException('minecraftNicknames doit etre une liste ou une chaine', 422);
        }

        $out = [];
        foreach ($parts as $part) {
            $pseudo = trim((string) $part);
            if ($pseudo === '') {
                continue;
            }
            if (!preg_match('/^[a-zA-Z0-9_]{1,16}$/', $pseudo)) {
                throw new HttpException(sprintf('Pseudo Minecraft invalide: %s', $pseudo), 422);
            }
            if (!in_array($pseudo, $out, true)) {
                $out[] = $pseudo;
            }
        }

        return $out;
    }

    /**
     * @param array<string,mixed> $user
     */
    private static function descriptionEditorLabel(array $user): string
    {
        $name = trim((string) ($user['name'] ?? ''));
        if ($name !== '') {
            return $name;
        }

        $email = trim((string) ($user['email'] ?? ''));
        if ($email !== '') {
            return $email;
        }

        return 'admin';
    }
}
