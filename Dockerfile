# Use a stable Bun version
FROM oven/bun:1

WORKDIR /app

# Copy dependency manifests first for optimal layer caching
COPY package.json bun.lock ./

# Install production dependencies only
RUN bun install --production --frozen-lockfile

# Copy application code
COPY index.ts tsconfig.json ./
COPY src ./src

# gosu lets the entrypoint drop from root to the bot user after fixing
# permissions on the mounted /data volume
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

# Create the non-root user the bot runs as
RUN groupadd -r bot && useradd -r -g bot bot

# Data directory for the persistent SQLite database
RUN mkdir -p /data && chown bot:bot /data
VOLUME ["/data"]

# Default database path inside the container
ENV BOT_DB_PATH=/data/eod.sqlite
ENV NODE_ENV=production

# Entrypoint runs as root, chowns the (possibly bind-mounted) /data volume,
# then drops to the bot user. This keeps setup zero-config for the user.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Run the bot
CMD ["bun", "run", "index.ts"]
