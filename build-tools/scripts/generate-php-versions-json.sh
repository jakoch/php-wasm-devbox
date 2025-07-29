#!/usr/bin/env bash

cd "$(dirname "$0")/../../assets/wasm" || exit 1

echo "[" > php-versions.json
first=1
for file in php-*-web.wasm; do
  [ -e "$file" ] || continue
  # Extract version from filename, e.g. php-8.4.8-web.wasm -> 8.4.8
  version=$(echo "$file" | sed -E 's/^php-([0-9]+\.[0-9]+\.[0-9]+)-web\.wasm$/\1/')
  if [ $first -eq 0 ]; then echo "," >> php-versions.json; fi
  echo "  {\"version\": \"$version\"}" >> php-versions.json
  first=0
done
echo "]" >> php-versions.json
cat php-versions.json
