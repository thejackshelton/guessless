#!/usr/bin/env bash
# run-query.sh <label> <fileset.txt> <request.json>
#
# Builds a guessless query document from a file set + request, runs it through the
# already-built CLI, writes <label>.receipt.json next to this script, and prints
# wall time (ms) and receipt byte size to stderr.
#
# Reads markless read-only. Writes only inside this evidence directory (+ scratch).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUESSLESS="/Users/jacksm5pro/dev/open-source/guessless"
MARKLESS="/Users/jacksm5pro/dev/open-source/markless"

LABEL="$1"; FILESET="$2"; REQUEST="$3"
DOC="$HERE/$LABEL.query.json"
OUT="$HERE/$LABEL.receipt.json"

node "$HERE/build-query.mjs" --root "$MARKLESS" --files "$HERE/$FILESET" --request "$HERE/$REQUEST" --out "$DOC" || exit 1

START=$(node -e 'process.stdout.write(String(Date.now()))')
node "$GUESSLESS/packages/cli/dist/cli.js" query "$DOC" > "$OUT" 2>"$OUT.stderr"
STATUS=$?
END=$(node -e 'process.stdout.write(String(Date.now()))')

BYTES=$(wc -c < "$OUT" | tr -d ' ')
echo "[$LABEL] exit=$STATUS wall_ms=$((END-START)) receipt_bytes=$BYTES" >&2
if [ -s "$OUT.stderr" ]; then echo "[$LABEL] stderr:" >&2; cat "$OUT.stderr" >&2; fi
rm -f "$OUT.stderr"
