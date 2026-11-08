#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PYTHONDONTWRITEBYTECODE=1
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git python3 procps util-linux xz-utils sudo
test -x /usr/bin/python3
git config --system --add safe.directory /src
source deploy/fnos/native-inputs.env
apt-get install -y --no-install-recommends "chromium=$CHROMIUM_VERSION" "chromium-common=$CHROMIUM_VERSION"
# Legacy isolated browser tests select Playwright's 'chrome' channel. Point that
# test-only expected location at Debian Chromium, never Google Chrome for Testing.
mkdir -p /opt/google/chrome
ln -s /usr/bin/chromium /opt/google/chrome/chrome
mkdir -p /opt/node
curl --fail --location --proto '=https' --retry 3 --output /tmp/node.tar.xz "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
printf '%s  %s\n' "$NODE_SHA256" /tmp/node.tar.xz | sha256sum --check --strict
tar -xJf /tmp/node.tar.xz --strip-components=1 -C /opt/node
export PATH=/opt/node/bin:$PATH
npm ci --ignore-scripts
for app in purchase sales overview; do npm ci --prefix "apps/$app" --ignore-scripts; done
useradd --create-home --uid 23002 erpchecks
printf '%s\n' 'erpchecks ALL=(root) NOPASSWD: /usr/bin/python3' > /etc/sudoers.d/erpchecks
chmod 440 /etc/sudoers.d/erpchecks
# Full suites remain available for manual/release verification. Iterative native
# payload fixes use the owning root/native/browser/release regressions after the
# recorded full Linux suites have passed; actual payload checks are always run.
tests_status=0
case "${ERP_CI_CHECK_SCOPE:-full}" in
 full)
  runuser -u erpchecks -- env PATH="$PATH" npm test || tests_status=1
  for app in purchase sales overview; do runuser -u erpchecks -- env PATH="$PATH" npm --prefix "apps/$app" test || tests_status=1; done;;
 focused)
  runuser -u erpchecks -- env PATH="$PATH" node --test tests/web-fnos*.test.mjs tests/web-collector*.test.mjs tests/web-release.test.mjs tests/web-module-path-privacy.test.mjs || tests_status=1;;
 *) echo 'Unknown ERP_CI_CHECK_SCOPE; use full or focused.' >&2; exit 1;;
esac
/usr/bin/python3 -I -B tests/fnos-native-retained-recovery.py
for script in deploy/fnos/*.sh deploy/fnos/wuchengerp/cmd/*; do
 test -f "$script" || continue
 case "$script" in *.py) /usr/bin/python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$script";; *) bash -n "$script";; esac
done
bash deploy/fnos/build-native.sh /output/release
exit "$tests_status"
