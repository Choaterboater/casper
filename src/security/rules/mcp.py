# Test cases for mcp.yaml (semgrep --test). SPDX-License-Identifier: MIT
import asyncio
import os
import sqlite3
import subprocess

import httpx
import requests
import ssl
import uvicorn
import yaml
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("demo")
server = object()


@mcp.tool()
def ping(host: str) -> str:
    # ruleid: casper.mcp-tool-shell-from-input
    return subprocess.run(f"ping -c 1 {host}", shell=True, capture_output=True).stdout


@mcp.tool(annotations={"readOnlyHint": True})
async def trace(host: str) -> str:
    cmd = "traceroute " + host
    # ruleid: casper.mcp-tool-shell-from-input
    proc = await asyncio.create_subprocess_shell(cmd)
    return str(proc)


@mcp.tool
def calc(expr: str) -> str:
    # ruleid: casper.mcp-tool-shell-from-input
    return str(eval(expr))


@server.call_tool()
async def handle(name: str, arguments: dict) -> list:
    # ruleid: casper.mcp-tool-shell-from-input
    os.system("show " + arguments["what"])
    return []


@mcp.tool()
def ping_safe(host: str) -> str:
    # ok: casper.mcp-tool-shell-from-input
    return subprocess.run(["ping", "-c", "1", host], capture_output=True).stdout


def not_a_tool(host: str) -> None:
    # ok: casper.mcp-tool-shell-from-input
    os.system("ping " + host)


@mcp.tool()
def lookup(name: str) -> list:
    db = sqlite3.connect("x.db")
    # ruleid: casper.mcp-tool-sql-from-input
    rows = db.execute(f"SELECT * FROM devices WHERE name = '{name}'").fetchall()
    # ok: casper.mcp-tool-sql-from-input
    safe = db.execute("SELECT * FROM devices WHERE name = ?", (name,)).fetchall()
    return rows + safe


@mcp.tool()
def fetch(url: str) -> str:
    # ruleid: casper.tls-verify-off
    text = requests.get(url, verify=False).text
    # ruleid: casper.tls-verify-off
    httpx.Client(verify=False)
    # ruleid: casper.tls-verify-off
    ssl._create_unverified_context()
    # ok: casper.tls-verify-off
    return text + requests.get(url, timeout=5).text


def load(path: str) -> object:
    with open(path) as handle:
        # ruleid: casper.yaml-load-unsafe
        data = yaml.load(handle)
    with open(path) as handle:
        # ruleid: casper.yaml-load-unsafe
        data = yaml.load(handle, Loader=yaml.Loader)
    with open(path) as handle:
        # ok: casper.yaml-load-unsafe
        data = yaml.load(handle, Loader=yaml.SafeLoader)
    with open(path) as handle:
        # ok: casper.yaml-load-unsafe
        data = yaml.safe_load(handle)
    return data


@mcp.tool()
def env_dump() -> dict:
    # ruleid: casper.mcp-tool-returns-secrets
    return dict(os.environ)


@mcp.tool()
def token() -> str:
    # ruleid: casper.mcp-tool-returns-secrets
    return os.environ["MIST_APITOKEN"]


@mcp.tool()
def region() -> str:
    # ok: casper.mcp-tool-returns-secrets
    return os.environ.get("MIST_REGION", "global")


def main() -> None:
    # ruleid: casper.mcp-http-bind-all
    mcp.run(transport="streamable-http", host="0.0.0.0")
    # ruleid: casper.mcp-http-bind-all
    uvicorn.run(app, host="0.0.0.0", port=8000)
    # ok: casper.mcp-http-bind-all
    uvicorn.run(app, host="127.0.0.1", port=8000)
