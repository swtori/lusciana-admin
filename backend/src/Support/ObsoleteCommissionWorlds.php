<?php

declare(strict_types=1);

namespace App\Support;

/**
 * Commissions importées par erreur (doublons compta / render / mauvais regroupement).
 * Garder synchronisé avec pages/assets/obsolete-commission-worlds.json
 */
final class ObsoleteCommissionWorlds
{
    /** @return list<string> */
    public static function all(): array
    {
        return [
            'c-Ved-map-tower-x3',
            'c-Ved',
            'c-WanoKuni-soymemox-guillrmo-armenta',
            'c-Scale-soymemox-guillrmo-armenta',
            'c-soymemox-guillrmo-armenta',
        ];
    }
}
