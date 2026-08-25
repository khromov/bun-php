<?php

declare(strict_types=1);

use League\Csv\Reader;
use League\Csv\Writer;

function parseCsv(string $csv): array
{
    $reader = Reader::fromString($csv);
    $reader->setHeaderOffset(0);

    return array_values(iterator_to_array($reader->getRecords()));
}

function buildCsv(array $header, array $rows): string
{
    $writer = Writer::fromString();
    $writer->insertOne($header);
    $writer->insertAll($rows);

    return trim($writer->toString());
}
