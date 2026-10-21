#!/usr/bin/env bash
# Build a PHP-WASM module for a given PHP version, mirroring the steps in
# .devcontainer/debian/*/Dockerfile exactly (emscripten 6.0.10, same flags,
# same bridge compile/link). Produces php-<version>-web.{mjs,wasm} under
# a temporary workdir — copy the results into
# playground/assets/wasm/ when satisfied.
#
# Prerequisites: an activated emsdk (6.0.10), git, make, bison, flex, re2c,
# gcc/g++, python3, curl, and network access. Go grab a coffee, it takes some time.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <PHP_VERSION>" >&2
  exit 1
fi
PHP_VERSION="$1"

WORK="/tmp/opencode/php-wasm-build-${PHP_VERSION}"
SRC="$WORK/php-src"
INSTALL="$WORK/install"
BRIDGE_SRC="$(dirname "$0")/../../src/php-wasm-bridge.c"
BRIDGE_SRC="$(cd "$(dirname "$BRIDGE_SRC")" && pwd)/$(basename "$BRIDGE_SRC")"

ONIGURUMA_VERSION=6.9.10
LIBXML_VERSION=2.15.4
VLD_VERSION=0.19.1
EMSCRIPTEN_VERSION=6.0.10
SQLITE_VERSION=3530400
SQLITE_SHA256=0e9483900e92cd5de8fd48d16bf9200145a61f7fd5be542a5ac81d8a9516eb9c
ENABLE_VLD=1

# Use the activated emsdk already on PATH; fall back to sourcing emsdk_env.
if ! command -v emcc >/dev/null 2>&1; then
  source /local/src/emsdk/emsdk_env.sh >/dev/null 2>&1 || true
fi
export EMSDK="${EMSDK:-/local/src/emsdk}"
export EM_CONFIG="${EM_CONFIG:-$EMSDK/.emscripten}"
export PATH="$EMSDK:$EMSDK/upstream/emscripten:/usr/local/bin:/usr/bin:$PATH"

echo "==> [$PHP_VERSION] setup dirs"
rm -rf "$WORK"
mkdir -p "$WORK" "$INSTALL" "$WORK/build"

echo "==> [$PHP_VERSION] clone php-src PHP-${PHP_VERSION}"
git clone https://github.com/php/php-src.git "$SRC" --branch "PHP-${PHP_VERSION}" --single-branch --depth 1

echo "==> [$PHP_VERSION] build oniguruma"
git clone https://github.com/kkos/oniguruma --branch "v${ONIGURUMA_VERSION}" --single-branch --depth 1 "$WORK/oniguruma"
cd "$WORK/oniguruma"
autoreconf -vfi
emconfigure ./configure --host="$(emcc -dumpmachine)" --prefix="$INSTALL" --disable-shared
emmake make
emmake make install

echo "==> [$PHP_VERSION] build libxml2"
git clone https://gitlab.gnome.org/GNOME/libxml2.git "$WORK/libxml2" --branch "v${LIBXML_VERSION}" --single-branch --depth 1
cd "$WORK/libxml2"
emconfigure ./autogen.sh --host="$(emcc -dumpmachine)" --prefix="$INSTALL" --enable-static --disable-shared --with-python=no --with-threads=no
emmake make -j"$(nproc)"
emmake make install

echo "==> [$PHP_VERSION] build sqlite3"
mkdir -p "$WORK/sqlite"
curl -fsSL -o "/tmp/sqlite-autoconf-${SQLITE_VERSION}.tar.gz" \
  "https://www.sqlite.org/2026/sqlite-autoconf-${SQLITE_VERSION}.tar.gz"
echo "${SQLITE_SHA256}  /tmp/sqlite-autoconf-${SQLITE_VERSION}.tar.gz" > /tmp/sqlite.sha256
sha256sum -c /tmp/sqlite.sha256
tar -xzf "/tmp/sqlite-autoconf-${SQLITE_VERSION}.tar.gz" -C "$WORK/sqlite" --strip-components=1
cd "$WORK/sqlite"
emconfigure ./configure --host="$(emcc -dumpmachine)" --prefix="$INSTALL" --enable-static --disable-shared
emmake make -j"$(nproc)"
emmake make install

echo "==> [$PHP_VERSION] clone VLD"
git clone https://github.com/derickr/vld.git "$SRC/ext/vld" --branch "$VLD_VERSION" --single-branch --depth 1

echo "==> [$PHP_VERSION] buildconf + configure PHP"
cd "$SRC"
./buildconf --force

# VLD stub php-config (mirrors Dockerfile)
printf '%s\n' \
	'#!/bin/sh' \
	"case \"\${1:-}\" in" \
	"	--version) echo \"${PHP_VERSION}\" ;;" \
	"	*) exit 1 ;;" \
	'esac' \
	> /usr/local/bin/php-config-vld-stub && \
	chmod +x /usr/local/bin/php-config-vld-stub

export PHP_CONFIG=/usr/local/bin/php-config-vld-stub
VLD_FLAG=""
if [ "${ENABLE_VLD}" = "1" ]; then VLD_FLAG="--enable-vld"; fi
emconfigure ./configure \
--host="$(emcc -dumpmachine)" \
CFLAGS='-O3 -g0 -D_GNU_SOURCE' \
--enable-embed=static \
--disable-all \
--disable-cgi \
--disable-cli \
--disable-fiber-asm \
--disable-phpdbg \
--enable-calendar \
--enable-ctype \
--enable-dom \
--enable-mbstring \
--enable-simplexml \
--enable-xmlreader \
--enable-pdo \
${VLD_FLAG} \
--enable-xml \
--with-libxml \
--with-pdo-sqlite \
--with-sqlite3 \
--without-pcre-jit \
--without-pear \
ac_cv_func_reallocarray=yes \
ac_cv_func__FPU_SETCW=no

echo "==> [$PHP_VERSION] compile bridge"
mkdir -p "$WORK/build/php-wasm-bridge"
emcc -O2 \
-I "$SRC/." \
-I "$SRC/Zend" \
-I "$SRC/main" \
-I "$SRC/TSRM" \
-I "$EMSDK/upstream/sysroot/include" \
-c "$BRIDGE_SRC" \
-o "$WORK/build/php-wasm-bridge/php-wasm-bridge.o"

echo "==> [$PHP_VERSION] compile PHP (libphp.a)"
cd "$SRC"
emmake make -j"$(nproc)"

echo "==> [$PHP_VERSION] link wasm module"
mkdir -p "$WORK/php-wasm"
emcc -o "$WORK/php-wasm/php-${PHP_VERSION}-web.mjs" \
-O3 \
-g0 \
-flto=full \
-v \
-s EXPORTED_FUNCTIONS='["_phpw", "_phpw_exec", "_phpw_run", "_phpw_init", "_phpw_destroy", "_phpw_request_init", "_phpw_last_error", "_phpw_free", "_phpw_php_version", "_phpw_vld_config", "_chdir", "_setenv"]' \
-s EXPORTED_RUNTIME_METHODS='["ccall", "UTF8ToString", "lengthBytesUTF8", "FS", "HEAPU8"]' \
-s ENVIRONMENT=web,worker,node \
-s STACK_SIZE=8mb \
-s MAXIMUM_MEMORY=2gb \
-s INITIAL_MEMORY=256mb \
-s ALLOW_MEMORY_GROWTH=1 \
-s ASSERTIONS=0 \
-s ERROR_ON_UNDEFINED_SYMBOLS=0 \
-s EXPORT_ES6=1 \
-s MODULARIZE=1 \
-s EXPORT_NAME=createPhpModule \
-s INVOKE_RUN=0 \
-s LZ4=1 \
"$WORK/build/php-wasm-bridge/php-wasm-bridge.o" \
"$SRC/.libs/libphp.a" \
"$INSTALL/lib/libxml2.a" \
"$INSTALL/lib/libonig.a" \
"$INSTALL/lib/libsqlite3.a"

echo "==> [$PHP_VERSION] DONE: $WORK/php-wasm/php-${PHP_VERSION}-web.{mjs,wasm}"
ls -la "$WORK/php-wasm/"
