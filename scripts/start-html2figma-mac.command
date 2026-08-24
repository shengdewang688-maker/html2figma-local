#!/bin/zsh
set -e

cd "$(dirname "$0")/.."

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js/npm was not found. Install Node.js 20 or newer, then run this launcher again."
  read -r "reply?Press Enter to close..."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
  echo "Installing Playwright Chromium..."
  npx playwright install chromium
fi

npm run app

