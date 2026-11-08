#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git python3 procps util-linux xz-utils
test -x /usr/bin/python3
git config --system --add safe.directory /src
source deploy/fnos/native-inputs.env
mkdir -p /opt/node
curl --fail --location --proto '=https' --retry 3 --output /tmp/node.tar.xz "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
printf '%s  %s\n' "$NODE_SHA256" /tmp/node.tar.xz | sha256sum --check --strict
tar -xJf /tmp/node.tar.xz --strip-components=1 -C /opt/node
export PATH=/opt/node/bin:$PATH
npm ci --ignore-scripts
for app in purchase sales overview; do npm ci --prefix "apps/$app" --ignore-scripts; done
useradd --create-home --uid 23002 erpchecks
# Full root web suite and three business modules run once with Linux production
# dependencies. Package-user tests must not be silently skipped because root CI.
runuser -u erpchecks -- env PATH="$PATH" npm test
for app in purchase sales overview; do runuser -u erpchecks -- env PATH="$PATH" npm --prefix "apps/$app" test; done
/usr/bin/python3 -I -B tests/fnos-native-retained-recovery.py
for script in deploy/fnos/*.sh deploy/fnos/wuchengerp/cmd/*; do
 case "$script" in *.py) /usr/bin/python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$script";; *) bash -n "$script";; esac
done
bash deploy/fnos/build-native.sh /output/release
