FROM node@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7
LABEL org.opencontainers.image.source="https://github.com/reticlehq/reticle" \
      org.opencontainers.image.revision="39cc34a84bfb78023154c9f4e99c61f3cbe8fc19"
COPY --from=reticle-artifact / /opt/reticle/
COPY reticle/runtime-package.json /opt/ezil/package.json
COPY dist/reticle-adapter.js /opt/ezil/reticle-adapter.js
ENV RETICLE_TELEMETRY=0 DO_NOT_TRACK=1
WORKDIR /project
USER 1000:1000
EXPOSE 4400
CMD ["node", "/opt/ezil/reticle-adapter.js"]
