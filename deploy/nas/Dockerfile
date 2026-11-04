FROM public.ecr.aws/docker/library/node:24-bookworm-slim

ENV NPM_CONFIG_FETCH_RETRIES=1 \
    NPM_CONFIG_FETCH_TIMEOUT=30000

WORKDIR /srv/erp
COPY . .
RUN if [ -f _build-cache/xlsx-0.20.3.tgz ]; then npm cache add _build-cache/xlsx-0.20.3.tgz --offline; fi \
 && npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
 && for app in purchase sales overview; do \
      npm --prefix "apps/$app" ci --ignore-scripts --omit=dev --no-audit --no-fund; \
    done

ENV NODE_ENV=production
CMD ["node", "server/cli.mjs", "start", "--config", "/var/lib/wucheng-erp/config.json"]
