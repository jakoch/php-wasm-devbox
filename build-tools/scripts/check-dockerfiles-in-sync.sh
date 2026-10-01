#!/usr/bin/env bash
#
# SPDX-FileCopyrightText: 2025 Jens A. Koch
# SPDX-License-Identifier: MIT
#
# This file is part of https://github.com/jakoch/php-wasm-devbox
#
# The Dockerfiles under .devcontainer/debian/ are kept byte-identical apart from
# their FROM lines, so a change to one has to be made to the other. Nothing else
# enforces that, and the drift is invisible: both files still lint, and the one
# that is not the default is simply never built.
#
# Usage:
#   ./build-tools/scripts/check-dockerfiles-in-sync.sh
#
# Exits non-zero and prints a diff if they have diverged.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEBIAN_DIR="${REPO_ROOT}/.devcontainer/debian"

REFERENCE="trixie"
COPY="bookworm"

REFERENCE_FILE="${DEBIAN_DIR}/${REFERENCE}/Dockerfile"
COPY_FILE="${DEBIAN_DIR}/${COPY}/Dockerfile"

for file in "$REFERENCE_FILE" "$COPY_FILE"; do
    if [ ! -f "$file" ]; then
        echo "error: missing $file"
        exit 1
    fi
done

# Normalise the FROM line so only real content differences remain. Both the tag
# and the digest differ between the two, so both are collapsed.
normalise() {
    sed -E 's|^FROM debian:[a-z-]+(-slim)?(@sha256:[0-9a-f]+)? AS |FROM debian:<base> AS |' "$1"
}

if ! diff -u <(normalise "$REFERENCE_FILE") <(normalise "$COPY_FILE"); then
    echo
    echo "error: ${REFERENCE}/Dockerfile and ${COPY}/Dockerfile have diverged."
    echo "       They must differ only in the FROM lines. Apply the same change to both."
    exit 1
fi

echo "ok: ${REFERENCE} and ${COPY} Dockerfiles are in sync"
