#!/usr/bin/env bash
set -euo pipefail
[ -f .env ] || cp .env.example .env
npm install
npm run realm:probe
