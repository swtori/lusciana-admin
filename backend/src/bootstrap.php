<?php

declare(strict_types=1);

use App\App;
use App\Config\Config;
use App\Config\Database;

$config = Config::load(dirname(__DIR__));
$database = (new Database($config))->database();

return new App($config, $database);
