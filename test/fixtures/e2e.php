<?php

const APP_NAME = 'bun-php';

function greet(string $name): string
{
    return "Hello, $name!";
}

function addAll(int ...$numbers): int
{
    return array_sum($numbers);
}

function withDefault(string $a, string $b = 'default'): string
{
    return "$a/$b";
}

function makeList(): array
{
    return [1, 2, 3];
}

function makeAssoc(): array
{
    return ['a' => 1, 'nested' => ['b' => true]];
}

function echoNull(): ?string
{
    return null;
}

function roundTrip(array $data): array
{
    return $data;
}

function nothing(): void
{
}

function talks(string $s): string
{
    echo "spoken: $s\n";
    return strtoupper($s);
}

function boom(): void
{
    throw new \RuntimeException('kaboom');
}

function quits(): void
{
    exit(3);
}

function tick(): int
{
    static $n = 0;
    return ++$n;
}

function bigInt(): int
{
    return PHP_INT_MAX;
}
