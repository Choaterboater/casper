# Test cases for fastapi.yaml (semgrep --test). SPDX-License-Identifier: MIT
from typing import Annotated

from fastapi import Depends, FastAPI, Security
from fastapi.middleware.cors import CORSMiddleware

# ruleid: casper.fastapi-debug-on
app = FastAPI(debug=True)
# ok: casper.fastapi-debug-on
other = FastAPI(title="ok")

# ruleid: casper.fastapi-cors-any-origin-with-credentials
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"])
# ok: casper.fastapi-cors-any-origin-with-credentials
app.add_middleware(CORSMiddleware, allow_origins=["https://ops.example.net"], allow_credentials=True)


def current_user() -> str:
    return "me"


# ruleid: casper.fastapi-write-route-without-login
@app.post("/devices")
def add_device(name: str) -> dict:
    return {"name": name}


# ruleid: casper.fastapi-write-route-without-login
@app.delete("/devices/{name}")
async def remove_device(name: str) -> dict:
    return {"removed": name}


# ok: casper.fastapi-write-route-without-login
@app.put("/devices/{name}")
def rename_device(name: str, user: str = Depends(current_user)) -> dict:
    return {"name": name, "by": user}


# ok: casper.fastapi-write-route-without-login
@app.patch("/devices/{name}")
async def patch_device(name: str, user: Annotated[str, Security(current_user)]) -> dict:
    return {"name": name, "by": user}


# ok: casper.fastapi-write-route-without-login
@app.post("/admin", dependencies=[Depends(current_user)])
def admin() -> dict:
    return {}


# ok: casper.fastapi-write-route-without-login
@app.get("/devices")
def list_devices() -> list:
    return []
