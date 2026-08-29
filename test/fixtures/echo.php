<?php

/**
 * Hands its argument straight back, so a generated value can be checked for surviving the whole
 * call protocol rather than just the encoder.
 */
function echoBack(mixed $value): mixed
{
    return $value;
}

/** Prints and returns, so streamed output and the return value can be checked against each other. */
function speakBack(string $text): string
{
    echo $text;
    return $text;
}

/** Reports the PHP type the value arrived as, so a silent coercion cannot pass unnoticed. */
function typeOf(mixed $value): string
{
    return get_debug_type($value);
}
