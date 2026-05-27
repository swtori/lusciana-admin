<?php

declare(strict_types=1);

namespace App\Support;

final class AgentEngagementRules
{
    /** Historique pris en compte pour les compteurs et le statut */
    public const WINDOW_DAYS = 60;

    public const TYPE_MEETING_ABSENCE = 'meeting_absence';

    public const TYPE_SURVEY_NO_RESPONSE = 'survey_no_response';

    public const TYPE_TASK_MISSED = 'task_missed';

    public const TYPE_OTHER = 'other_inactivity';

    /** @return list<string> */
    public static function negativeTypes(): array
    {
        return [
            self::TYPE_MEETING_ABSENCE,
            self::TYPE_SURVEY_NO_RESPONSE,
            self::TYPE_TASK_MISSED,
            self::TYPE_OTHER,
        ];
    }

    /**
     * Statut dérivé du nombre d'incidents négatifs sur la fenêtre glissante.
     * active: 0–1 | attention: 2–3 | warn: 4–5 | sanction: 6+
     */
    public static function statusFromNegativeCount(int $count): string
    {
        if ($count <= 1) {
            return 'active';
        }
        if ($count <= 3) {
            return 'attention';
        }
        if ($count <= 5) {
            return 'warn';
        }

        return 'sanction';
    }
}
