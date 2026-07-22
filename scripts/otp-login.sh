#!/usr/bin/env bash
# Demo/QA helper: get an OTP login code for a seeded business.
#
#   ./scripts/otp-login.sh "+2349011100001"                # code only
#   ./scripts/otp-login.sh "+2349011100001" --login        # code + full session
#
# How it works: asks the API for an OTP the way the app does, then reveals it
# through the admin auth-monitor. Reveal ONLY works for businesses flagged as
# test accounts (isTest) — flag the business in the dashboard first otherwise.
#
# Override the defaults with env vars if you point at another environment:
#   API=... ADMIN_EMAIL=... ADMIN_PASSWORD=... ./scripts/otp-login.sh "+234..."
set -euo pipefail

API="${API:-https://qz7v4k-api-production.up.railway.app}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@oweme.app}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-OweMeAdmin!2026}"

PHONE="${1:-}"
if [ -z "$PHONE" ]; then
  echo "usage: $0 <phone e.g. +2349011100001> [--login]" >&2
  exit 1
fi

json() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

# 1. Admin session (needed to reveal the code).
TOKEN=$(curl -sS -X POST "$API/admin/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | json accessToken)
[ -n "$TOKEN" ] || { echo "admin login failed — check ADMIN_EMAIL/ADMIN_PASSWORD" >&2; exit 1; }

# 2. Find the business by phone. The list masks phones, so match on the last 4 digits.
LAST4="${PHONE: -4}"
BID=$(curl -sS "$API/admin/businesses?limit=100" -H "Authorization: Bearer $TOKEN" \
  | tr '{' '\n' | grep -m1 "$LAST4" | json id || true)
[ -n "$BID" ] || { echo "no business found for $PHONE" >&2; exit 1; }

# 3. Ask for the OTP exactly as the app does (always 202, never enumerates).
curl -sS -o /dev/null -X POST "$API/auth/request-otp" \
  -H 'Content-Type: application/json' -d "{\"phone\":\"$PHONE\"}"

# 4. Reveal it. 404 here means the business is not flagged as a test account.
REVEAL=$(curl -sS -X POST "$API/admin/auth-monitor/test-numbers/$BID/reveal" \
  -H "Authorization: Bearer $TOKEN")
# Extract the code ONLY from a success shape — the error envelope also carries a
# "code" field (e.g. NOT_FOUND), which would otherwise be printed as an OTP.
CODE=""
case "$REVEAL" in
  *'"expiresInSeconds"'*) CODE=$(printf '%s' "$REVEAL" | json code) ;;
esac
if [ -z "$CODE" ]; then
  echo "could not reveal a code: $REVEAL" >&2
  echo "hint: flag this business as a test account in the dashboard, then retry." >&2
  exit 1
fi

echo "phone : $PHONE"
echo "code  : $CODE   (valid ~10 minutes)"

# 5. Optionally complete the login and print the session.
if [ "${2:-}" = "--login" ]; then
  echo "--- session ---"
  curl -sS -X POST "$API/auth/verify-otp" -H 'Content-Type: application/json' \
    -d "{\"phone\":\"$PHONE\",\"code\":\"$CODE\"}"
  echo
fi
