#!/bin/sh
# Make a tiny throwaway project and home folder for the captures.
# Usage: sh make-project.sh <dir>   (creates <dir>/home and <dir>/project)
set -e
dir="$1"; casper="$(cd "$(dirname "$0")/../.." && pwd)"; bun="${BUN:-$(command -v bun)}"
rm -rf "$dir"; mkdir -p "$dir/home/.casper" "$dir/project/src" "$dir/project/tests" "$dir/project/.casper"
cd "$dir/project"
printf 'export const sum = (a, b) => a - b;\n' > src/sum.js
printf 'import { expect, test } from "bun:test";\nimport { sum } from "../src/sum.js";\n\ntest("zero plus zero", () => expect(sum(0, 0)).toBe(0));\n' > tests/sum.test.js
printf '{ "name": "sum-demo", "type": "module" }\n' > package.json
printf 'commands:\n  test: bun test\nverification:\n  mode: auto\nrepair:\n  maxAttempts: 1\n' > .casper/project.yaml
printf '{"mcpServers":{"fixture":{"command":"%s","args":["%s/tests/fixtures/mcp-server.ts"]}}}\n' "$bun" "$casper" > "$dir/home/.casper/mcp.json"
git init -q && git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm start
