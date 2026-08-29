<?php

const GREETING = 'Hello';

/**
 * Greets someone by name.
 */
function greet(string $name, string $greeting = GREETING): string
{
    return "$greeting, $name!";
}

/**
 * Sums any number of integers.
 */
function addAll(int ...$numbers): int
{
    return array_sum($numbers);
}

/**
 * Summarises a list of numbers.
 */
function stats(array $values): array
{
    if ($values === []) {
        return ['count' => 0, 'mean' => 0.0, 'max' => 0.0];
    }

    return [
        'count' => count($values),
        'mean' => array_sum($values) / count($values),
        'max' => max($values),
    ];
}

/** Formats a number the way PHP's intl-free number_format does. */
function money(float $amount, int $decimals = 2): string
{
    return number_format($amount, $decimals, '.', ',');
}
