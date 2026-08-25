<?php

declare(strict_types=1);

use Ramsey\Uuid\Uuid;

function randomId(): string
{
    return Uuid::uuid4()->toString();
}

function stableId(string $name): string
{
    return Uuid::uuid5(Uuid::NAMESPACE_DNS, $name)->toString();
}

function idVersion(string $uuid): ?int
{
    if (!Uuid::isValid($uuid)) {
        return null;
    }

    return Uuid::fromString($uuid)->getFields()->getVersion();
}
