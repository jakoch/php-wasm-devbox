<?php

// This example shows how to get the PHP version and list all loaded PHP extensions.

echo 'PHP Version: ' . phpversion() . "\n \n";

$loaded_modules = get_loaded_extensions();

$number_of_modules = count($loaded_modules);

$linewise_modules = implode("\n - ", $loaded_modules);

printf("Loaded Modules (%d):\n - %s\n", $number_of_modules, $linewise_modules);
