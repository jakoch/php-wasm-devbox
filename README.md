# PHP-WASM-DEVBOX [![Build Docker Image](https://github.com/jakoch/php-wasm-devbox/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/jakoch/php-wasm-devbox/actions/workflows/build.yml)

## What is this?

This repository provides a streamlined development environment for building and deploying the PHP-WASM module.

It builds upon Derick Rethans [php-wasm-builder](https://github.com/derickr/php-wasm-builder),
using its Dockerfile and `phpw.c` source file as a foundation.
From there, I made extensive modifications to enhance flexibility, efficiency, and automation.

### What is PHP-WASM?

PHP-WASM is a WebAssembly module that runs PHP directly in the browser, compiled
using Emscripten. It eliminates the need for a server, allowing PHP code to
execute entirely on the client side.

You can call PHP functions from JavaScript by interacting with the WebAssembly
module, enabling seamless integration between both languages.

A great example of its use is interactive PHP documentation, where small code
snippets can be executed instantly on the client side, or an online PHP
playground—similar to [3v4l](https://3v4l.org/), but running entirely in the browser, such as my
[https://jakoch.github.io/php-wasm-devbox/](jakoch.github.io/php-wasm-devbox/) project.

#### Key Features

- **Devcontainer support**: Seamless PHP-WASM development using VSCode or any Devcontainer-compatible editor.
- **Multi-stage Dockerfile**:
  - **Build stage**: Customizable compilation settings for PHP-WASM.
  - **Deploy stage**: Minimal, production-ready image based on **Debian Bookworm-slim**.
- **Automated CI/CD releases**: GitHub Actions workflows for publishing artifacts, releases, and container images.
- **PHP Language Playground**: Provides a small language playground which is released to Github Pages.

## Modifications

This project significantly refactors the original **php-wasm-builder**
repository to improve structure, maintainability, and deployment efficiency.

### Code & Structure Changes

- **Renamed** `phpw.c` → `php-wasm-bridge.c` and moved it to `/src`.
- **Added comments** to clarify bridge functionality and interactions with PHP.

### Optimized Dockerfile

- **Reduced image size** by minimizing layers and merging `RUN` sections.
- **Improved documentation** of compiler flags.
- **Implemented Hadolint recommendations** for best practices.
- **Introduced multi-stage build**:
  - **Build stage:** Sets up the compilation toolchain with all necessary
    dependencies for building the PHP-WASM module. This allows customization of
    compilation settings and recompilation if needed. This is the image used by
    the devcontainer.
  - **Deploy stage:** A lightweight environment containing only the PHP-WASM
    module, optimized for running PHP-WASM in a minimal container.

### Development & CI/CD Integration

- **Devcontainer support** for an instant development environment.
- **GitHub Actions workflows** for automated:
  - Artifact uploads
  - Release publishing
  - Container deployment to GHCR
  - Playground deployment to Github Pages

### Linting & Best Practices

- Integrated **Hadolint** for Dockerfile linting.

### Developing the playground

- Open the `/playground` folder as a standalone project in VS Code.
- The playground provides its own devcontainer for isolated development.
- Once inside the devcontainer, you can freely edit files within `/playground`.
- To launch the local development server, run `./serve.sh` from the `/playground` directory.
  This start script will also build required JSON data files, which are loaded by the static web page.
- Visit [http://127.0.0.1:8000](http://127.0.0.1:8000) in your browser to access the playground.
- For the feature roadmap and todos, see the [playground README](./playground/readme.md).
