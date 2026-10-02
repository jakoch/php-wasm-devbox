#
# SPDX-FileCopyrightText: 2025 Derick Rethans
# SPDX-FileCopyrightText: 2025 Jens A. Koch
# SPDX-License-Identifier: MIT
#
# This file is part of https://github.com/jakoch/php-wasm-devbox
#

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS build-stage

# +-----------------------------+
# | ARGS                        |
# +-----------------------------+

ARG PHP_VERSION=8.5.11
ARG ONIGURUMA_VERSION=6.9.10
ARG LIBXML_VERSION=2.15.4
ARG VLD_VERSION=0.19.1
ARG EMSCRIPTEN_VERSION=6.0.10
ARG SQLITE_VERSION=3530400
ARG SQLITE_SHA256=0e9483900e92cd5de8fd48d16bf9200145a61f7fd5be542a5ac81d8a9516eb9c
ARG NODE_VERSION=24.21.0
ARG NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
# VLD is a debug-only extension; it must not end up in the shipped artifact.
ARG ENABLE_VLD=0
# +-----------------------------+
# | METADATA                    |
# +-----------------------------+
# Standardized Docker Image Labels
# https://github.com/opencontainers/image-spec/blob/main/annotations.md

LABEL \
    org.opencontainers.image.title=php-wasm-devbox \
    org.opencontainers.image.description="A Docker-based devcontainer for building and deploying PHP-WASM module." \
    org.opencontainers.image.authors='Jens A. Koch <jakoch@web.de>' \
    org.opencontainers.image.licenses=MIT \
    org.opencontainers.image.url=https://github.com/jakoch/php-wasm-devbox \
    org.opencontainers.image.source=https://github.com/jakoch/php-wasm-devbox

WORKDIR /local/src

# Copy php-wasm-bridge source to /local/src
COPY src/php-wasm-bridge.c /local/src/php-wasm-bridge.c

ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

RUN echo "Packages" && \
    apt-get update && \
	apt-get --no-install-recommends -y install \
	build-essential \
	automake \
	autoconf \
	libtool \
	pkg-config \
	bison \
	flex \
	make \
	re2c \
	git \
	pv \
    curl \
	ca-certificates \
	python3 && \
    echo "Cleanup" && \
    apt-get autoremove -y && \
    apt-get clean autoclean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* && \
    echo "Configure git to avoid warnings" && \
    git config --global advice.detachedHead false

# Node for running the module, its tests and the CLI demo. Deliberately NOT on
# PATH ahead of emsdk: emscripten pins the node it ships with, and shadowing it
# would change what emcc and `make` use. build-tools/scripts/test-bridge.sh
# puts this one first on PATH for the test run only.
RUN set -e; \
    echo "Install Node ${NODE_VERSION}" && \
    curl -fsSL -o /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" && \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" > /tmp/node.sha256 && \
    sha256sum -c /tmp/node.sha256 && \
    mkdir -p /usr/local/node24 && \
    tar -xJf /tmp/node.tar.xz -C /usr/local/node24 --strip-components=1 && \
    rm -f /tmp/node.tar.xz /tmp/node.sha256 && \
    /usr/local/node24/bin/node --version

RUN set -e; \
    echo "Install Emscripten SDK" && \
	git clone  https://github.com/emscripten-core/emsdk.git --branch "${EMSCRIPTEN_VERSION}" --single-branch --depth 1 && \
	cd emsdk && \
	./emsdk install "${EMSCRIPTEN_VERSION}" && \
	./emsdk activate "${EMSCRIPTEN_VERSION}" && \
    echo "Download PHP and prepare build system" && \
	git clone https://github.com/php/php-src.git /local/src/php-src/ --branch "PHP-${PHP_VERSION}" --single-branch --depth 1 && \
	cd /local/src/php-src/ && \
	./buildconf --force && \
    echo "Create install directory" && \
    mkdir -p /local/install && \
    echo "Create build directory" && \
    mkdir -p /local/build

# Set ENV vars for Emscripten SDK and set global compiler flags
ENV PATH=/local/src/emsdk:/local/src/emsdk/upstream/emscripten:/usr/local/bin:/usr/bin \
	EMSDK=/local/src/emsdk \
	EM_CONFIG=/local/src/emsdk/.emscripten \
    CFLAGS="-O3 -g0" CXXFLAGS="-O3 -g0" LDFLAGS="-O3 -g0"

RUN set -e; \
    echo "Compile oniguruma (mbstring regex library)" && \
    git clone https://github.com/kkos/oniguruma --branch "v${ONIGURUMA_VERSION}" --single-branch --depth 1 && \
    cd oniguruma && \
    autoreconf -vfi && \
    emconfigure ./configure --host="$(emcc -dumpmachine)" --prefix=/local/install --disable-shared && \
    emmake make && \
    emmake make install && \
    echo "Compile libxml2 (XML library)" && \
    git clone https://gitlab.gnome.org/GNOME/libxml2.git libxml2 --branch "v${LIBXML_VERSION}"  --single-branch --depth 1 && \
    cd libxml2 && \
    emconfigure ./autogen.sh --host="$(emcc -dumpmachine)" --prefix=/local/install --enable-static --disable-shared --with-python=no --with-threads=no && \
    emmake make -j"$(nproc)" && \
    emmake make install && \
    echo "Compile sqlite3" && \
    mkdir -p /local/src/sqlite && \
    curl -fsSL -o "/tmp/sqlite-autoconf-${SQLITE_VERSION}.tar.gz" \
      "https://www.sqlite.org/2026/sqlite-autoconf-${SQLITE_VERSION}.tar.gz" && \
    echo "${SQLITE_SHA256}  /tmp/sqlite-autoconf-${SQLITE_VERSION}.tar.gz" > /tmp/sqlite.sha256 && \
    sha256sum -c /tmp/sqlite.sha256 && \
    tar -xzf "/tmp/sqlite-autoconf-${SQLITE_VERSION}.tar.gz" -C /local/src/sqlite --strip-components=1 && \
    rm -f "/tmp/sqlite-autoconf-${SQLITE_VERSION}.tar.gz" /tmp/sqlite.sha256 && \
    cd /local/src/sqlite && \
    emconfigure ./configure --host="$(emcc -dumpmachine)" --prefix=/local/install --enable-static --disable-shared && \
    emmake make -j"$(nproc)" && \
    emmake make install

# Setting ENV vars for oniguruma and libxml
# oniguruma is used by mbstring and libxml2 is used by the XML extension.
# both are fetched before, see above.
# sqlite3 is installed via libsqlite3-dev package.
ENV ONIG_LIBS="-L/local/install" \
	ONIG_CFLAGS="-I/local/install/include" \
	LIBXML_LIBS="-L/local/install" \
	LIBXML_CFLAGS="-I/local/install/include/libxml2" \
    SQLITE_LIBS="-L/local/install" \
    SQLITE_CFLAGS="-I/local/install/include"

RUN echo "Clone VLD extension" && \
    git clone https://github.com/derickr/vld.git /local/src/php-src/ext/vld --branch $VLD_VERSION --single-branch --depth 1

# https://www.php.net/manual/en/configure.about.php
RUN set -e; \
    echo "Configure PHP" && \
    cd /local/src/php-src/ && \
    VLD_FLAG=""; \
    if [ "${ENABLE_VLD}" = "1" ]; then VLD_FLAG="--enable-vld"; fi && \
	emconfigure ./configure \
    --host="$(emcc -dumpmachine)" \
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
    ac_cv_func_reallocarray=yes && \
    echo "Compile WASM bridge for PHP" && \
    mkdir -p /local/build/php-wasm-bridge && \
    emcc -O2 \
    -I /local/src/php-src/. \
    -I /local/src/php-src/Zend \
    -I /local/src/php-src/main \
    -I /local/src/php-src/TSRM \
    -I /local/src/emsdk/upstream/sysroot/include \
    -c /local/src/php-wasm-bridge.c \
    -o /local/build/php-wasm-bridge/php-wasm-bridge.o && \
    echo "Compile PHP" && \
    cd /local/src/php-src && \
	emmake make -j"$(nproc)"

# Compile PHP-WASM (ES6 JavaScript module)
#
# Flags:
# - o: output file
# - O3: optimization level
# - g0: disable debug information
# - flto=full: enable link-time optimization (LTO)
# - v: verbose
# - EXPORTED_FUNCTIONS: list of functions to export
# - EXPORTED_RUNTIME_METHODS: list of runtime methods to export
# - ENVIRONMENT=web,worker,node: target environments
# - STACK_SIZE=8mb: main thread stack size
# - INITIAL_MEMORY=256mb: initial heap size
# - MAXIMUM_MEMORY=2gb: upper bound for heap growth
# - ALLOW_MEMORY_GROWTH=1: allow the heap to grow
# - EXPORT_ES6=1: export as ES6 JavaScript module
# - MODULARIZE=1: export as ES6 JavaScript module
# - EXPORT_NAME=createPhpModule: export as ES6 JavaScript module
# - INVOKE_RUN=0: disable automatic run
# - LZ4=1: enable LZ4 compression
# - ASSERTIONS=0: disable assertions
# - ERROR_ON_UNDEFINED_SYMBOLS=0: disable error on undefined symbols
#
# Notes on ENVIRONMENT:
# `node` is included so that test/php-wasm-bridge.test.mjs can load the module
# and exercise it in CI. It adds a little size but nothing else depends on it;
# drop it if a browser-only build is preferred.
#
# Notes on Memory:
# The heap is allowed to grow up to MAXIMUM_MEMORY. With growth disabled a
# script that exhausts the heap aborts the whole Wasm instance, taking the
# playground down with it and forcing a page reload; growing the heap lets the
# allocation simply fail instead. The module is a long-lived instance that runs
# many requests, so its peak usage is not known up front.
#
# Notes on STACK_SIZE:
# The default 64KB stack is too small for real-world PHP. Deep recursion in
# application code overflows it.
#
# Notes on Debugging:
# - o2: optimization level would trigger a warning: running limited binaryen optimizations
# because DWARF info requested (or indirectly required) [-Wlimited-postlink-optimizations]
# - switched to o3 with g0 to disable debug information
# Maybe -gseparate-dwarf is an option to keep debug information in a separate file.
# Or -gsource-map to generate a source map.
#
# For debugging builds:
# -s ASSERTIONS=1 -s ERROR_ON_UNDEFINED_SYMBOLS=1 -s SAFE_HEAP=1 -s STACK_OVERFLOW_CHECK=2
#
# Emscripten compiler settings:
# https://emscripten.org/docs/tools_reference/settings_reference.html
#
RUN set -e; \
    echo "Create PHP-WASM (ES6 JavaScript module)" && \
    mkdir -p /php-wasm && \
 	emcc -o "/php-wasm/php-${PHP_VERSION}-web.mjs" \
 	-O3 \
    -g0 \
    -flto=full \
    -v \
 	-s EXPORTED_FUNCTIONS='["_phpw", "_phpw_exec", "_phpw_run", "_phpw_init", "_phpw_destroy", "_phpw_request_init", "_phpw_last_error", "_phpw_free", "_phpw_php_version", "_chdir", "_setenv"]' \
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
    /local/build/php-wasm-bridge/php-wasm-bridge.o \
    /local/src/php-src/.libs/libphp.a \
  	/local/install/lib/libxml2.a \
  	/local/install/lib/libonig.a \
  	/local/install/lib/libsqlite3.a

#
# Deploy Stage
#
# The deploy stage is used to create a minimal image for deployment.
# The folder /php-wasm contains the compiled PHP-WASM module.
#

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS deploy-stage

COPY --from=build-stage /php-wasm /php-wasm
