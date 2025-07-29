#!/usr/bin/env bash

cd "$(dirname "$0")/../../" || exit 1

git_hash=$(git rev-parse --short HEAD)
echo "Git hash: $git_hash"
version=$(node -p "require('./package.json').version")
echo "Version: $version"
echo "{\"version\": \"$version\", \"git_hash\": \"$git_hash\"}" > version.json
