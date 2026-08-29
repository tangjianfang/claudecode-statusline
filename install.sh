#!/bin/sh
# macOS/Linux entry point — mirrors install.bat (same Node check + install flow).
set -e

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Please install Node.js and try again."
    exit 1
fi

node "$(dirname "$0")/statusline.js" --install || {
    echo "Installation failed."
    exit 1
}

echo "Done. Restart Claude Code to see the new status line."
