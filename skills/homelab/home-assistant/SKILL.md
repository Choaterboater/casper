---
name: homelab-home-assistant
description: >-
  Home Assistant in Docker: install, integrations added through its own setup flow (never its .storage files),
  HACS, MQTT, dashboards, and checking the result where the person looks.
tags: [home assistant, hacs, mqtt, mosquitto]
casper-skill:
  platform: homeassistant
  triggers:
    strong: ["home assistant", "homeassistant", "home-assistant", "hass", "hacs", "lovelace", "mosquitto", "zigbee2mqtt", "esphome"]
    weak: ["mqtt", "zigbee", "zwave", "z-wave"]
    context: ["integration", "integrations", "automation", "automations", "dashboard", "dashboards", "entity", "entities", "broker"]
    unless: ["chatbot", "ai assistant"]
  version: 1
---
# Home Assistant

## When to use
Installing or changing Home Assistant (HA) running in Docker, often on a NAS reached over ssh: adding
integrations (the *arr apps, MQTT, Sonos, printers), HACS and custom cards, dashboards, Mosquitto as the
MQTT broker. For the Compose side (restart loops, image drift) the Docker skill has more; for the *arr apps
themselves, the media skill.

## Read first
These ask for data. Run them before you change anything. HA's REST API takes a long-lived access token the
person makes in their HA profile (Security tab), read from `HA_TOKEN`, never typed into code or output.
- `curl -s -H "Authorization: Bearer $HA_TOKEN" http://<ha_host>:8123/api/` answers `{"message": "API running."}`.
- `GET /api/config` (version, time zone, components loaded), `GET /api/error_log` (the log as text).
- `GET /api/config/config_entries/entry`: every integration with its `domain`, `title` and `state`
  (`loaded`, `setup_error`, `setup_retry`, `not_loaded`). This is the list the person sees in
  Settings > Devices & services.
- Without a token: `docker ps --filter name=homeassistant`, `docker logs --since 10m homeassistant`, and
  `curl -s -o /dev/null -w '%{http_code}' http://<ha_host>:8123/` (200 once the page is up; it takes about a
  minute after each start).
- Check YAML before a restart: `docker exec homeassistant python -m homeassistant --script check_config -c /config`.

## Changing things (Casper asks)
MCP: Casper's change box asks; don't ask again in chat. Else ask the user first; show the exact call.
Casper also asks before a shell command reaches a new host.
- Before a change, make a backup: Settings > System > Backups, or stop the container and copy `/config`.

WRITE: install with `image: homeassistant/home-assistant:stable`, `network_mode: host` (discovery
needs it), `/config` on a volume, `TZ` set, `restart: unless-stopped`; then the person does onboarding at
`http://<ha_host>:8123` (it makes their owner account).

Add an integration through its setup flow, as the Add integration button does, one step per call:

WRITE: `POST /api/config/config_entries/flow` with `{"handler": "sonarr"}` starts it and returns a `flow_id`.

WRITE: `POST /api/config/config_entries/flow/<flow_id>` with the step's answers, until `"type": "create_entry"`.

Without a token, ask the person to add it in Settings > Devices & services > Add integration and give them
the values: the URL, and the API key read into an env var on the host, never printed.

WRITE: `docker restart homeassistant` or `POST /api/services/homeassistant/restart`; the page is back in a minute.

WRITE: `DELETE /api/config/config_entries/entry/<entry_id>` removes an entry.

- Undo: delete the entry you added, or restore the backup.

## Common traps
- Never edit `/config/.storage/` (`core.config_entries`, `core.entity_registry` and the rest). They are HA's
  internal files: HA rewrites them while running, an edit can be lost or break startup, and an entry written
  by hand skips the checks the setup flow makes. Integrations go through the setup flow; YAML only for what
  HA still reads from `configuration.yaml`.
- Most integrations, the *arr apps among them, can't be set up in YAML any more: the setup flow is the way.
- Done means the person can see it: each new entry's `state` is `loaded` in
  `/api/config/config_entries/entry`, or they see it in Settings > Devices & services. If neither was
  checked, say it is not checked; don't move on to the next step as if it were.
- An integration that adds services but no device (Sonarr, Radarr, SABnzbd) shows as "1 service" and does
  not appear on the auto-made Overview dashboard: add cards for its sensors, or a new dashboard.
- "You don't seem to be in control of any dashboard": the Overview builds itself. "Take control" makes it
  editable and stops new devices appearing on it; a new dashboard leaves Overview as it is.
- HACS: copying its release into `/config/custom_components/hacs` and restarting is half the job. The person
  must then add HACS in Add integration and sign in to GitHub with the device code it shows; only then can
  cards such as Mushroom be installed.
- MQTT: the Mosquitto broker needs a user and password file (`mosquitto_passwd`) owned by the user the
  container runs as; HA's MQTT entry then takes the broker, port 1883 and that user's login in its setup flow.
- Behind a reverse proxy HA answers 400 until `configuration.yaml` has `http: use_x_forwarded_for: true` and
  the proxy's address in `trusted_proxies`.
- One sensor ID used twice ("does not generate unique IDs") is usually two paths or names ending the same
  in the source app; HA keeps the first and ignores the other.

## Public docs
- https://www.home-assistant.io/installation/linux#docker-compose
- https://developers.home-assistant.io/docs/api/rest/
- https://www.home-assistant.io/docs/configuration/
- https://www.home-assistant.io/integrations/
- https://hacs.xyz/docs/use/
- https://mosquitto.org/documentation/
