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

# Create data directory and ensure it is writable by any user (helps with bind mounts)
RUN mkdir -p /data && chmod 777 /data

# Run as a non-root user for security
RUN groupadd -r bot && useradd -r -g bot bot
USER bot

# Volume for persistent SQLite database
VOLUME ["/data"]

# Default database path inside the container
ENV BOT_DB_PATH=/data/eod.sqlite
ENV NODE_ENV=production

# Run the bot
CMD ["bun", "run", "index.ts"]
