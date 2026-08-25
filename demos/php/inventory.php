<?php

declare(strict_types=1);

use Demo\Inventory;

function priceBasket(array $basket): array
{
    $inventory = new Inventory();

    foreach ($basket as $line) {
        $inventory->add($line['name'], (int) $line['qty'], (float) $line['price']);
    }

    return [
        'total' => round($inventory->total(), 2),
        'summary' => $inventory->summary(),
        'items' => $inventory->items(),
    ];
}
