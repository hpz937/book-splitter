# book-splitter MCP server — HTTP mode (Streamable HTTP at /mcp, legacy SSE at /sse)
FROM node:22-bookworm-slim

# Optional: Calibre's ebook-convert for MOBI/AZW3/FB2/DOCX/RTF/ODT (adds ~500 MB).
#   docker compose build --build-arg INSTALL_CALIBRE=true
ARG INSTALL_CALIBRE=false
RUN if [ "$INSTALL_CALIBRE" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends calibre \
      && rm -rf /var/lib/apt/lists/*; \
    fi
# Calibre is a Qt app; run it headless
ENV QT_QPA_PLATFORM=offscreen

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8787 \
    BOOK_SPLITTER_ROOTS=/books \
    BOOK_SPLITTER_CACHE=/cache

RUN mkdir -p /books /cache && chown node:node /cache
USER node

EXPOSE 8787
VOLUME ["/cache"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js", "--http"]
