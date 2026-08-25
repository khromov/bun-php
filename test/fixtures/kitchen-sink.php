<?php
declare(strict_types=1);

namespace App\Tools;

const GREETING = 'hello';
const LIMIT = 1_000;
const OPTS = ['a' => 1, 'b' => [2, 3]];
const COMPUTED = 'a' . 'b';
define('DEFINED_ONE', 99);

/**
 * Greets a person warmly.
 *
 * @param string $name Who to greet
 * @return string
 */
function greet(string $name, string $greeting = 'Hi'): string {
    return "$greeting, $name!";
}

function untyped($a, $b) { return $a + $b; }

/**
 * @param int[] $nums
 * @return array<string, int>
 */
function stats($nums) { return ['n' => count($nums)]; }

function nullableA(?int $x): ?string { return $x === null ? null : (string) $x; }
function nullableB(int|null $x): string|null { return null; }
function unions(int|float $n, Countable&\ArrayAccess $c): int|string { return 1; }
function variadic(string $sep, int ...$rest): string { return $sep; }
function byref(array &$out): void {}
function classy(\App\Thing $t): \App\Thing { return $t; }
function noReturn(): void {}

class Ignored {
    public function shouldNotAppear(): string { return 'x'; }
}

interface AlsoIgnored { public function nope(): void; }
