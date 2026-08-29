#!/bin/sh
# macOS/Linux entry point — mirrors install-loopctl.bat (same Node check + install flow).
set -e

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Please install Node.js and try again."
    exit 1
fi

node "$(dirname "$0")/loopctl.js" --install || {
    echo "Installation failed."
    exit 1
}

echo "Done. Run \"loopctl on\" in a project directory to enable the auto-loop there."
