<?php

// This example shows how to get the PHP version and list all loaded PHP extensions.

echo 'PHP Version: ' . phpversion() . "\n \n";
echo 'Loaded Modules: ' . "\n - " . implode("\n - ", get_loaded_extensions()) . "\n";
