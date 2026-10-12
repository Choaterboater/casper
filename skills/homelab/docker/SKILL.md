---
name: homelab-docker-compose
description: >-
  A health and drift sweep for Docker Compose stacks: status, health checks, restart loops, images that
  moved on, orphan containers, volumes, and .env files.
tags: [docker compose, compose.yaml]
casper-skill:
  platform: docker
  triggers:
    strong: ["compose stack", "compose stacks", "portainer", "dockge"]
    weak: ["docker", "docker compose", "compose.yaml", "compose.yml", "compose file", "compose project", "compose services", "docker ps", "docker inspect"]
    context: ["restarting", "restart loop", "unhealthy", "healthcheck", "health", "oomkilled", "drift", "drifted", "orphan", "orphans", "digest", "stack", "stacks", "home lab", "homelab", "self hosted", "selfhosted"]
    unless: ["jetpack compose"]
  version: 1
---
# Docker Compose health and drift

## When to use
Checking or fixing containers run with Docker Compose, mostly on a home server: what is running, what
is unhealthy or restarting, what changed since the compose file was written, and updating images. Writing
a Dockerfile or a compose file for an app is ordinary code: this skill adds the checks.

## Read first
These ask for data. Run them before you change anything, from the folder with the compose file (or
pass `-f` and `-p`).
- `docker compose ls`: every project and the files it came from.
- `docker compose config --quiet`: the file parses with its `.env` (nothing printed means it does).
  `docker compose config` prints the merged result; it prints what `.env` holds too, so don't paste it back.
- `docker compose ps -a`: state and health of each service, stopped ones too.
- `docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'`: "Restarting (1) 5 seconds ago" is a
  loop; "(unhealthy)" is a failing health check.
- `docker inspect --format '{{.RestartCount}} {{.State.ExitCode}} {{.State.OOMKilled}}' <container>`
- `docker inspect --format '{{json .State.Health}}' <container>`: the last health check outputs.
- `docker compose logs --tail 100 <service>`: the reason is usually in the first error line.
- `docker system df` and `df -h /var/lib/docker`: disk use.

## Changing things (Casper asks)
MCP: Casper's change box asks; don't ask again in chat. Else ask the user first; show the exact call.
Casper also asks before a shell command reaches a new host.
- One service at a time, and keep a copy of the compose file and `.env` before an edit.
- Before an image update, write down the running image ID (`docker inspect --format '{{.Image}}'
  <container>`) and tag it, so you can go back: the undo line.

```bash
# WRITE
docker image tag <image_id> <repo>:rollback   # the undo point
docker compose pull <service>
docker compose up -d <service>
# undo: set image: <repo>:rollback in the compose file, then docker compose up -d <service>
```

WRITE: `docker compose restart <service>`, `docker compose up -d --force-recreate <service>`.

WRITE: `docker compose up -d --remove-orphans` removes containers no longer in the file.

WRITE: `docker compose down -v` deletes named volumes and their data: never without the user saying so.

WRITE: `docker image prune`, `docker system prune` remove images and stopped containers.

## Common traps
- Restart loop: `restart: unless-stopped` hides a crash. Read the exit code: 137 with `OOMKilled` true
  is memory; 126/127 a bad entrypoint; 1 an app error in the logs. A service waiting for a database
  needs `depends_on` with `condition: service_healthy`, not a longer restart delay.
- Unhealthy: the check runs inside the container, so `curl` must exist in the image and the port is the
  container port, not the published one.
- Image drift: `:latest` (or no tag) means the running container can be older than the image now on
  disk or in the registry. Compare `docker inspect --format '{{.Image}}' <container>` with
  `docker image inspect --format '{{.Id}}' <repo>:<tag>`; `docker buildx imagetools inspect
  <repo>:<tag>` shows the registry's digest. Pin a version tag or a digest for anything that matters.
- Config drift: `docker compose config --hash '*'` prints a hash per service; a container's
  `com.docker.compose.config-hash` label that differs means it was made from an older file.
- Orphans: containers with the project label but no service in the file
  (`docker ps -a --filter label=com.docker.compose.project=<project>`). Renamed services leave them.
- Volumes vs bind mounts: a named volume lives under `/var/lib/docker/volumes` and survives `down`
  (not `down -v`); a bind mount is a host folder you back up yourself. A bind mount path that does not
  exist is made as an empty root-owned folder (short `host:container` form).
- `.env` holds secrets: keep it out of git (`.gitignore`), and never print it. Commit an `.env.example`
  with placeholders instead. A changed `.env` needs `up -d`, not `restart`, to reach the container.
- Old `docker-compose` (v1, with a hyphen) is gone from current Docker; use `docker compose`.
- Published ports bypass host firewalls such as ufw; bind to `127.0.0.1:` or a LAN address
  (192.0.2.x) when a service should not face the internet.

## Public docs
- https://docs.docker.com/compose/
- https://docs.docker.com/reference/compose-file/services/
- https://docs.docker.com/reference/cli/docker/compose/
- https://docs.docker.com/engine/storage/volumes/
- https://docs.docker.com/reference/dockerfile/#healthcheck
