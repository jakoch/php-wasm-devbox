#!/usr/bin/env bash
#
# SPDX-FileCopyrightText: 2025 Jens A. Koch
# SPDX-License-Identifier: MIT
#
# This file is part of https://github.com/jakoch/php-wasm-devbox
#
# Build src/php-wasm-bridge.c against the PHP static library that the
# devcontainer image already contains, then run the bridge test suite.
#
# This is the fast path for iterating on the bridge: the Dockerfile spends most
# of its time compiling PHP itself, which is unnecessary when only the C bridge
# changed. Re-run `./build.sh` inside the build stage after modifying the
# bridge.
#
# Requirements: the build-stage image, i.e. the devcontainer.
#
# Usage:
#   ./build-tools/scripts/test-bridge.sh [output-dir]
#
# The default output directory is /tmp/php-wasm-bridge-test.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${1:-/tmp/php-wasm-bridge-test}"

PHP_SRC="${PHP_SRC:-/local/src/php-src}"
PREFIX="${PREFIX:-/local/install}"
EMSDK="${EMSDK:-/local/src/emsdk}"

# shellcheck source=/dev/null
source "${EMSDK}/emsdk_env.sh" > /dev/null 2>&1

if [ ! -f "${PHP_SRC}/.libs/libphp.a" ]; then
    echo "error: ${PHP_SRC}/.libs/libphp.a not found."
    echo "       Run this inside the build-stage devcontainer."
    exit 1
fi

# Kept in step with the final emcc invocation in the Dockerfile.
LINK_FLAGS=(
    -O3
    -g0
    -flto=full
    -s EXPORTED_FUNCTIONS='["_phpw","_phpw_exec","_phpw_run","_phpw_init","_phpw_destroy","_phpw_request_init","_phpw_last_error","_phpw_free","_phpw_php_version","_chdir","_setenv"]'
    -s EXPORTED_RUNTIME_METHODS='["ccall","UTF8ToString","lengthBytesUTF8","FS"]'
    -s ENVIRONMENT=web,worker,node
    -s STACK_SIZE=8mb
    -s INITIAL_MEMORY=256mb
    -s MAXIMUM_MEMORY=2gb
    -s ALLOW_MEMORY_GROWTH=1
    -s ASSERTIONS=0
    -s ERROR_ON_UNDEFINED_SYMBOLS=0
    -s EXPORT_ES6=1
    -s MODULARIZE=1
    -s EXPORT_NAME=createPhpModule
    -s INVOKE_RUN=0
    -s LZ4=1
)

echo "==> Compiling the bridge"
mkdir -p "${OUT_DIR}"
emcc -O3 -g0 \
    -I "${PHP_SRC}/." \
    -I "${PHP_SRC}/Zend" \
    -I "${PHP_SRC}/main" \
    -I "${PHP_SRC}/TSRM" \
    -I "${EMSDK}/upstream/sysroot/include" \
    -Wall -Wextra -Wno-unused-parameter \
    -c "${REPO_ROOT}/src/php-wasm-bridge.c" \
    -o "${OUT_DIR}/php-wasm-bridge.o"

echo "==> Linking"
# shellcheck disable=SC2086
emcc -o "${OUT_DIR}/php-wasm-bridge.mjs" \
    "${LINK_FLAGS[@]}" \
    "${OUT_DIR}/php-wasm-bridge.o" \
    "${PHP_SRC}/.libs/libphp.a" \
    "${PREFIX}/lib/libxml2.a" \
    "${PREFIX}/lib/libonig.a" \
    "${PREFIX}/lib/libsqlite3.a"

# Prefer the image's Node 24 over the one emsdk ships, for the test run only.
# emcc and `make` keep using emsdk's node, which is the version it is pinned to.
if [ -x /usr/local/node24/bin/node ]; then
    PATH="/usr/local/node24/bin:$PATH"
    export PATH
fi

echo "==> Running the test suite with $(node --version)"
node "${REPO_ROOT}/test/php-wasm-bridge.test.mjs" "${OUT_DIR}/php-wasm-bridge.mjs"
