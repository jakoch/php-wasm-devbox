#!/bin/bash

# Generate version list for PHP-WASM modules (php-versions.json)
./build-tools/scripts/generate-php-versions-json.sh

# Set Application Version (version.json)
./build-tools/scripts/generate-app-version-json.sh

# Start a PHP server to serve the playground
php -S 127.0.0.1:8000 &

# Open the playground in the browser
# xdg-open http://127.0.0.1:8000 -t playground &
