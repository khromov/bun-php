<?php

declare(strict_types=1);

function phpInfoHtml(): string
{
    ob_start();
    phpinfo();

    return (string) ob_get_clean();
}

function runtimeSummary(): array
{
    return [
        'php' => PHP_VERSION,
        'sapi' => php_sapi_name(),
        'extensions' => count(get_loaded_extensions()),
        'memory_limit' => ini_get('memory_limit'),
    ];
}
