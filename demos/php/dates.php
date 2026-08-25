<?php

declare(strict_types=1);

use Carbon\CarbonImmutable;

function humanDiff(string $iso, string $relativeTo): string
{
    $then = CarbonImmutable::parse($iso, 'UTC');
    $now = CarbonImmutable::parse($relativeTo, 'UTC');

    return $then->diffForHumans($now);
}

function formatIn(string $iso, string $timezone, string $format = 'D, d M Y H:i T'): string
{
    return CarbonImmutable::parse($iso, 'UTC')->setTimezone($timezone)->format($format);
}

function addWeekdays(string $iso, int $days): string
{
    return CarbonImmutable::parse($iso, 'UTC')->addWeekdays($days)->toDateString();
}
