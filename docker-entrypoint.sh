#!/bin/sh
set -e

# The /data volume may be a bind mount owned by an arbitrary host user.
# Fix ownership at runtime so the unprivileged `bot` user can write the
# sqlite database, then drop privileges to run the bot.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R bot:bot /data
  exec gosu bot "$@"
fi

# Already non-root (e.g. user override via compose): just run.
exec "$@"
