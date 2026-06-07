# eod

a small imessage bot that bullies me into declaring what im doing each day

built with bun + typescript + sqlite + an llm that acts like a firm coach with a sense of humor

## run it

```bash
bun install
PROJECT_ID=... PROJECT_SECRET=... AI_BASE_URL=... AI_API_KEY=... AI_MODEL=... bun run index.ts
```

text the bot `start` so it knows your chat. then it handles the rest.

## run with docker

local build:

```bash
docker compose up --build -d
```

production (prebuilt image):

```bash
docker compose -f docker-compose.prod.yml up -d
```

make sure your `.env` is present and a `./data` directory exists for the sqlite volume.

`docker-compose.prod.yml` includes [watchtower](https://containrrr.dev/watchtower/) to automatically pull and restart the bot when a new image is pushed to your registry. it polls every 5 minutes and cleans up old images after updating.

## test it

```bash
bun test
bunx tsc --noEmit
```

## what it does

- wakes you up and asks for a bounded task
- if you ghost it, silence follow-ups escalate
- if you fail, you pay a charity penalty
- it reads photos and checks if you actually did the thing
- school hours are a valid excuse, but only if configured honestly

see `.env.example` for the full config.

## notes

- lowercase only. the bot is not yelling at you, but it is disappointed
- it schedules its own check-ins. you cannot hide
- the ai makes the call, the code just enforces it
