#!/bin/bash

# Install Node.js using apt
sudo apt update
sudo apt install -y nodejs

# Get PNPM
wget -qO- https://get.pnpm.io/install.sh | ENV="$HOME/.zshrc" SHELL="$(which zsh)" bash -

export PNPM_HOME="$HOME/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac

# Install the project
pnpm add playwright
