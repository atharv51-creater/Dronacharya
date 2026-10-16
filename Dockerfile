# One image for the whole stack; `npm start` runs the registry, sellers, buyer agent and gateway.
# node:sqlite needs Node >= 22.13.
FROM node:22.14-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Workspaces: npm ci needs every workspace package.json, so copy the tree (see .dockerignore), then install.
COPY . .
RUN npm ci --no-audit --no-fund && npm cache clean --force

# Local state (SQLite databases, ledger audit files) lives here; mount a volume to keep it.
VOLUME ["/app/.data"]

# Gateway (single public port). The individual services also listen on 4000-4200 inside the container.
EXPOSE 8080

# No secrets in the image: .env is provided at run time (docker compose env_file).
CMD ["npm", "start"]
