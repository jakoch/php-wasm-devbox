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

// build accept list of files
// 1. get all files in the examples directory using scandir
// 2. filter out the current and parent directory (dots) and the current file
// 3. remove the .php extension from the files
$reduced_file_set = array_diff(scandir(__DIR__), ['.', '..', '_get_file.php', 'examples.json']);
$accepted_files = array_map(
    fn($file) => str_replace('.php', '', $file),
    $reduced_file_set
);

// now check if the requested file is in the list of accepted files
if (!in_array($example, $accepted_files)) {
    exit_with_statuscode("File not found.", 404);
}

// file must be in the examples directory, resolve via realpath
$filePath = realpath(__DIR__ . DIRECTORY_SEPARATOR . "$example.php");

if (file_exists($filePath)) {
    //echo 'Example file: ' . $filePath . PHP_EOL; // debug
    return_file_as_plaintext($filePath);
} else {
    exit_with_statuscode("File not found.", 404);
}
