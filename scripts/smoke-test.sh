#!/usr/bin/env bash
# Post-deploy smoke test.  Usage: ./scripts/smoke-test.sh https://host
set -Eeuo pipefail
BASE="${1:?usage: smoke-test.sh <base-url>}"
FAIL=0

check() {
    local name="$1" url="$2" expect="${3:-200}"
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url" || echo 000)
    if [ "$code" = "$expect" ]; then
        printf '  ok    %-28s %s\n' "$name" "$code"
    else
        printf '  FAIL  %-28s %s (expected %s)\n' "$name" "$code" "$expect"
        FAIL=1
    fi
}

echo "smoke test against ${BASE}"
check "api liveness"      "${BASE}/api/health/"
check "api readiness"     "${BASE}/api/ready/"
check "storefront home"   "${BASE}/"
check "shop listing api"  "${BASE}/api/v1/shop/products/"
check "sitemap"           "${BASE}/sitemap.xml"
check "robots"            "${BASE}/robots.txt"
check "admin requires auth" "${BASE}/api/v1/products/" 401

echo
[ "$FAIL" = 0 ] && echo "smoke test passed" || { echo "SMOKE TEST FAILED"; exit 1; }
