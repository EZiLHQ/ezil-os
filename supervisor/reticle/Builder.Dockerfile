FROM node@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7
RUN npm install --global --ignore-scripts pnpm@10.33.2 && npm cache clean --force
ENV CI=true PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 RETICLE_TELEMETRY=0
WORKDIR /work
CMD ["sleep", "infinity"]
