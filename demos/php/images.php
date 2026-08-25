<?php

declare(strict_types=1);

function imageInfo(string $path): array
{
    $size = getimagesize($path);

    if ($size === false) {
        throw new RuntimeException("Not a readable image: $path");
    }

    return [
        'width' => $size[0],
        'height' => $size[1],
        'mime' => $size['mime'],
        'bytes' => filesize($path),
    ];
}

function thumbnail(string $source, string $target, int $maxWidth = 320, int $quality = 82): array
{
    $image = imagecreatefromjpeg($source);

    if ($image === false) {
        throw new RuntimeException("Could not decode $source");
    }

    $width = imagesx($image);
    $height = imagesy($image);
    $scale = min(1.0, $maxWidth / $width);
    $targetWidth = max(1, (int) round($width * $scale));
    $targetHeight = max(1, (int) round($height * $scale));

    $resized = imagescale($image, $targetWidth, $targetHeight);

    if ($resized === false) {
        throw new RuntimeException('Resize failed');
    }

    $ok = imagejpeg($resized, $target, $quality);

    if (!$ok) {
        throw new RuntimeException("Could not write $target");
    }

    return [
        'from' => ['width' => $width, 'height' => $height],
        'to' => ['width' => $targetWidth, 'height' => $targetHeight],
        'bytes' => filesize($target),
    ];
}

function toWebp(string $source, string $target, int $quality = 80): array
{
    $image = imagecreatefromjpeg($source);

    if ($image === false) {
        throw new RuntimeException("Could not decode $source");
    }

    $ok = imagewebp($image, $target, $quality);

    if (!$ok) {
        throw new RuntimeException("Could not write $target");
    }

    return [
        'bytes' => filesize($target),
        'mime' => getimagesize($target)['mime'] ?? 'unknown',
    ];
}
