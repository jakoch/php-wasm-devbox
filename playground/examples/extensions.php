<?php

// This example shows how to get the PHP version and list all loaded PHP extensions.

echo 'PHP Version: ' . phpversion() . "\n";
echo 'Loaded Modules: ' . implode(", ", get_loaded_extensions()) . "\n";


