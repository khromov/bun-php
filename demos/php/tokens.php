<?php

declare(strict_types=1);

use Firebase\JWT\JWT;
use Firebase\JWT\Key;

function signToken(array $claims, string $secret): string
{
    return JWT::encode($claims, $secret, 'HS256');
}

function verifyToken(string $token, string $secret): array
{
    return (array) JWT::decode($token, new Key($secret, 'HS256'));
}
