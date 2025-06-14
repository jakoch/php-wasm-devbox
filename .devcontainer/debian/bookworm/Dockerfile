#
# SPDX-FileCopyrightText: 2025 Derick Rethans
# SPDX-FileCopyrightText: 2025 Jens A. Koch
# SPDX-License-Identifier: MIT
#
# This file is part of https://github.com/jakoch/php-wasm-devbox
#

FROM debian:bookworm-slim AS build-stage

# +-----------------------------+
# | ARGS                        |
# +-----------------------------+

ARG PHP_VERSION=8.4.8
ARG ONIGURUMA_VERSION=6.9.10
ARG LIBXML_VERSION=2.13.5
ARG EMSCRIPTEN_VERSION=4.0.4

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
	ca-certificates \
	python3 && \
    echo "Cleanup" && \
    apt-get autoremove -y && \
    apt-get clean autoclean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* && \
    echo "Configure git to avoid warnings" && \
    git config --global advice.detachedHead false && \
    echo "Install Emscripten SDK" && \
	git clone  https://github.com/emscripten-core/emsdk.git --branch $EMSCRIPTEN_VERSION --single-branch --depth 1 && \
	cd emsdk && \
	./emsdk install latest && \
	./emsdk activate latest && \
    echo "Download PHP and prepare build system" && \
	git clone https://github.com/php/php-src.git /local/src/php-src/ --branch PHP-$PHP_VERSION --single-branch --depth 1 && \
	cd /local/src/php-src/ && \
	./buildconf --force && \
    echo "Create install directory" && \
    mkdir -p /local/install && \
    echo "Create build directory" && \
    mkdir -p /local/build

# Set ENV vars for Emscripten SDK and set global compiler flags
ENV PATH=/local/src/emsdk:/local/src/emsdk/upstream/emscripten:/usr/local/bin:/usr/bin \
	EMSDK=/local/src/emsdk \
	EMSDK_NODE=/local/src/emsdk/node/20.18.0_64bit/bin/node \
	EM_CONFIG=/local/src/emsdk/.emscripten \
    CFLAGS="-O3 -g0" CXXFLAGS="-O3 -g0" LDFLAGS="-O3 -g0"

RUN echo "Compile oniguruma (mbstring regex library)" && \
    git clone https://github.com/kkos/oniguruma --branch v$ONIGURUMA_VERSION --single-branch --depth 1 && \
	cd oniguruma && \
	autoreconf -vfi && \
	emconfigure ./configure --prefix=/local/install --disable-shared && \
	emmake make && \
	emmake make install &&\
    echo "Compile libxml2" && \
    git clone https://gitlab.gnome.org/GNOME/libxml2.git libxml2 --branch v$LIBXML_VERSION  --single-branch --depth 1 && \
	cd libxml2 && \
	emconfigure ./autogen.sh --prefix=/local/install --enable-static --disable-shared --with-python=no --with-threads=no && \
	emmake make -j"$(nproc)" && \
	emmake make install

# Setting ENV vars for oniguruma and libxml
ENV ONIG_LIBS="-L/local/install" \
	ONIG_CFLAGS="-I/local/install/include" \
	LIBXML_LIBS="-L/local/install" \
	LIBXML_CFLAGS="-I/local/install/include/libxml2"

# https://www.php.net/manual/en/configure.about.php
RUN echo "Configure PHP" && \
    cd /local/src/php-src/ && \
	emconfigure ./configure \
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
	--enable-xml \
	--enable-xmlreader \
    --with-libxml \
    --without-pcre-jit \
    --without-pear && \
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
# - ENVIRONMENT=web: compile for web environment
# - MAXIMUM_MEMORY=128mb: set maximum memory limit
# - INITIAL_MEMORY=128mb: set initial memory limit
# - ALLOW_MEMORY_GROWTH=0: disable automatic memory growth
# - EXPORT_ES6=1: export as ES6 JavaScript module
# - MODULARIZE=1: export as ES6 JavaScript module
# - EXPORT_NAME=createPhpModule: export as ES6 JavaScript module
# - INVOKE_RUN=0: disable automatic run
# - LZ4=1: enable LZ4 compression
# - ASSERTIONS=0: disable assertions
# - ERROR_ON_UNDEFINED_SYMBOLS=0: disable error on undefined symbols
#
# Notes on Memory Limit:
# - Memory is fixed at 128MB memory limit for performance with no automatic memory growth.
# Ignore the following warning, automatic memory growth is intentionally disabled:
# - emcc: warning: MAXIMUM_MEMORY is only meaningful with ALLOW_MEMORY_GROWTH [-Wunused-command-line-argument]
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
RUN echo "Create PHP-WASM (ES6 JavaScript module)" && \
    mkdir -p /php-wasm && \
 	emcc -o /php-wasm/php-$PHP_VERSION-web.mjs \
 	-O3 \
    -g0 \
    -flto=full \
    -v \
 	-s EXPORTED_FUNCTIONS='["_phpw", "_phpw_exec", "_phpw_run", "_chdir", "_setenv", "_php_embed_init", "_php_embed_shutdown", "_zend_eval_string"]' \
 	-s EXPORTED_RUNTIME_METHODS='["ccall", "UTF8ToString", "lengthBytesUTF8", "FS"]' \
 	-s ENVIRONMENT=web \
 	-s MAXIMUM_MEMORY=128mb \
    -s INITIAL_MEMORY=128mb \
    -s ALLOW_MEMORY_GROWTH=0 \
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
 	/local/install/lib/libonig.a

#
# Deploy Stage
#
# The deploy stage is used to create a minimal image for deployment.
# The folder /php-wasm contains the compiled PHP-WASM module.
#

FROM debian:bookworm-slim AS deploy-stage

COPY --from=build-stage /php-wasm /php-wasm
