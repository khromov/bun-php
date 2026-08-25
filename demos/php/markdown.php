<?php

declare(strict_types=1);

use League\CommonMark\CommonMarkConverter;
use League\CommonMark\GithubFlavoredMarkdownConverter;

function renderMarkdown(string $markdown): string
{
    $converter = new CommonMarkConverter([
        'html_input' => 'strip',
        'allow_unsafe_links' => false,
    ]);

    return trim((string) $converter->convert($markdown));
}

function renderGfm(string $markdown): string
{
    $converter = new GithubFlavoredMarkdownConverter(['html_input' => 'strip']);

    return trim((string) $converter->convert($markdown));
}
