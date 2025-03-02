<?php

// This script serves the content of the example files located in the examples directory.
// It is used by the playground to display the source code of the examples as plain text.
// Directly fetching PHP files from the browser against the PHP test server
// would result in the PHP code being executed.

function exit_with_statuscode($message, $code = 400)
{
    http_response_code($code);
    exit($message);
}

function return_file_as_plaintext($file)
{
    header("Content-Type: text/plain");
    header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");
    header("Pragma: no-cache");
    readfile($file);
    exit(0);
}

if (!isset($_GET['file'])) {
    exit_with_statuscode("Bad Request.", 400);
}

// accept only filename
$example = basename($_GET['file']);

// disallow directory traversal
if (strpos($example, '..') !== false) {
    exit_with_statuscode("Forbidden.", 403);
}

// disallow PHP extension, only file basenames are allowed
if (strpos($example, '.php') !== false) {
    exit_with_statuscode("Forbidden.", 403);
}

// file must be in the examples directory, resolve via realpath
$filePath = realpath(__DIR__ . DIRECTORY_SEPARATOR . "$example.php");

if (file_exists($filePath)) {
    //echo 'Example file: ' . $filePath . PHP_EOL; // debug
    return_file_as_plaintext($filePath);
} else {
    exit_with_statuscode("File not found.", 404);
}
