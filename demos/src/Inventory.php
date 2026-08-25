<?php

declare(strict_types=1);

namespace Demo;

use Ramsey\Uuid\Uuid;

final class Inventory
{
    private array $items = [];

    public function add(string $name, int $qty, float $price): string
    {
        $id = Uuid::uuid5(Uuid::NAMESPACE_DNS, $name)->toString();

        $this->items[] = [
            'id' => $id,
            'name' => $name,
            'qty' => $qty,
            'price' => $price,
        ];

        return $id;
    }

    public function total(): float
    {
        return array_sum(
            array_map(static fn (array $item): float => $item['qty'] * $item['price'], $this->items)
        );
    }

    public function items(): array
    {
        return $this->items;
    }

    public function summary(): string
    {
        $lines = array_map(
            static fn (array $i): string => sprintf('%-12s x%-3d %8.2f', $i['name'], $i['qty'], $i['qty'] * $i['price']),
            $this->items
        );

        return implode("\n", $lines);
    }
}
