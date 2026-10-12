---
name: homelab-media-stack
description: >-
  A home media stack: Radarr, Sonarr and the other *arr apps, Prowlarr, Plex, Jellyfin, Emby, qBittorrent,
  SABnzbd and NZBGet, with Gluetun and a VPN leak check.
tags: [radarr, sonarr, jellyfin, plex]
casper-skill:
  platform: media
  triggers:
    strong: ["radarr", "sonarr", "lidarr", "readarr", "prowlarr", "bazarr", "overseerr", "jellyseerr", "jellyfin", "emby", "plex", "plex media server", "tautulli", "qbittorrent", "sabnzbd", "nzbget", "gluetun", "usenet", "arr stack", "arr apps"]
    weak: ["deluge", "transmission"]
    context: ["torrent", "torrents", "downloader", "download client", "indexer", "indexers", "seeding", "vpn"]
  version: 1
---
# Home media stack

## When to use
Fixing or checking a self-hosted media stack: the *arr apps (Radarr, Sonarr, Lidarr, Readarr, Bazarr),
Prowlarr for indexers, Overseerr or Jellyseerr for requests, a downloader (qBittorrent, SABnzbd, NZBGet,
Deluge, Transmission), a media server (Plex, Jellyfin, Emby), often in Docker Compose with Gluetun as the
VPN. For the Compose side itself (restart loops, image drift) the Docker skill has more.

## Read first
These ask for data. Run them before you change anything. Keys come from the environment
(`RADARR_API_KEY`, `SONARR_API_KEY`, `JELLYFIN_API_KEY`, `PLEX_TOKEN` …), never typed into code or output.
- Radarr and Sonarr (API v3), header `X-Api-Key: $RADARR_API_KEY`:
  `GET /api/v3/system/status`, `GET /api/v3/health` (the app's own list of problems: read it first),
  `GET /api/v3/queue`, `GET /api/v3/rootfolder`, `GET /api/v3/downloadclient`,
  `GET /api/v3/remotepathmapping`. Lidarr, Readarr and Prowlarr use `/api/v1/` for the same calls.
- `curl -s -H "X-Api-Key: $SONARR_API_KEY" http://<sonarr_host>:8989/api/v3/health`
- Jellyfin: `GET /System/Info/Public` (no key), `GET /System/Info` with
  `Authorization: MediaBrowser Token="$JELLYFIN_API_KEY"`. Emby: `GET /emby/System/Info` with `X-Emby-Token` from `EMBY_API_KEY`.
- Plex: `GET /identity` (no token), `GET /library/sections` with `X-Plex-Token` from `PLEX_TOKEN`.
- qBittorrent Web API v2: sign in with the login POST to `/api/v2/auth/login` (keeps the session cookie), then
  `GET /api/v2/app/version`, `GET /api/v2/transfer/info`, `GET /api/v2/torrents/info?filter=stalled`.
- SABnzbd: `GET /api?mode=queue&output=json&apikey=$SABNZBD_API_KEY`.
- Containers: `docker compose ps`, `docker compose logs --tail 100 radarr`, and the mounts each app sees:
  `docker inspect --format '{{json .Mounts}}' radarr`.

## Changing things (Casper asks)
MCP: Casper's change box asks; don't ask again in chat. Else ask the user first; show the exact call.
Casper also asks before a shell command reaches a new host.
- Before a change, save the current settings: GET the object and keep the answer as the undo copy.
  The *arr apps also make a backup under System > Backup; name it before a big change.

WRITE: `PUT /api/v3/downloadclient/<id>`, `POST /api/v3/remotepathmapping`, `DELETE /api/v3/queue/<id>`.

WRITE: `POST /api/v3/command` with `{"name": "RescanMovie"}` or `{"name": "RefreshSeries"}` starts a job.

WRITE: `docker compose restart radarr`, `docker compose up -d` after a compose edit.

WRITE: `chown -R <puid>:<pgid> /data` changes every file under it: show the count first
(`find /data ! -user <puid> | wc -l`).

- Undo: put back the saved JSON with the same `PUT`, or restore the app's backup zip.

## Common traps
- Hardlinks and instant moves need downloads and the library on one filesystem, seen by every container
  as one mount (for example `/data` with `/data/torrents` and `/data/media`). Two mounts (`/downloads`
  and `/movies`) make every import a full copy and double the disk use.
- `PUID`/`PGID` (and `UMASK`) the same in every container, matching the owner of `/data` on the host.
  "Access denied" or "folder is not writable" in `/api/v3/health` is almost always this.
- Remote path mappings are only for a downloader that sees a different path than the *arr app
  (another host, or other mounts). With one shared `/data` mount you need none; a stale one breaks imports.
- "Import failed" from qBittorrent: check the category (radarr, tv-sonarr) and its save path, and that the
  path in the queue answer exists inside the *arr container.
- API keys: from the app's Settings > General, or `<ApiKey>` in its `config.xml` under `/config`. Read it
  into an env var; never print it, commit it or put it in a compose file. Use `.env` kept out of git.
- VPN leak check: the downloader's public IP, asked from inside its own network, must differ from the
  host's. Compare `docker exec qbittorrent wget -qO- https://ifconfig.io` (or `curl -s`, whichever the
  image has) with `curl -s https://ifconfig.io` on the host. The same IP means traffic leaves without
  the VPN.
- Gluetun: the downloader joins with `network_mode: "service:gluetun"`, and its web UI port is
  published on the gluetun service, not the downloader. If gluetun restarts, restart the downloader too
  so it rejoins. Gluetun's firewall blocks traffic when the tunnel drops; keep that on.
- Jellyfin and Plex hardware transcoding needs the GPU device (`/dev/dri`) passed in and the right
  group; check the server's own playback log before changing settings.
- Plex claim tokens last only minutes; a server that shows as unclaimed needs a new one.

## Public docs
- https://wiki.servarr.com
- https://trash-guides.info/File-and-Folder-Structure/
- https://jellyfin.org/docs/
- https://support.plex.tv/articles/
- https://github.com/qbittorrent/qBittorrent/wiki
- https://sabnzbd.org/wiki/
- https://github.com/qdm12/gluetun-wiki
