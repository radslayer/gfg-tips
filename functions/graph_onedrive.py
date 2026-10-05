"""
Microsoft Graph / OneDrive upload helper for the GFG Payroll Integration
Azure AD app registration (app-only / client-credentials auth).

# deploy-marker: 2026-10-05 -- forces a real content change so Firebase
# doesn't skip this function as "unchanged" on the first deploy attempt.

Set up 10/5/2026 (per Guapo) so the finalized payroll report and driver
advice PDFs land directly in the shared OneDrive folders the front
office and CPAs actually check, instead of only sitting in Cloud
Storage behind get_payroll_report / get_driver_advice_pdfs.

App registration: "GFG Payroll Integration"
  Application (client) ID: 04b102ab-c003-4064-9a1d-6ffa46219c69
  Directory (tenant) ID:   946674bd-c17c-4df0-b65d-dd3f3b9ffb25
  Permission: Files.ReadWrite.All (Application, admin-consented)
  Client secret: stored as the Firebase secret GRAPH_CLIENT_SECRET --
    never hardcoded here, never logged. Bind it on any function that
    calls get_token() via secrets=["GRAPH_CLIENT_SECRET"] on its
    @https_fn.on_call(...) decorator (see main.py).

Target OneDrive is rod@gourmetforgood.com's -- the two folders below are
relative to that OneDrive's root, matching exactly what shows under
"OneDrive - GFG" in File Explorer. Verified 10/5/2026 that EES_FOLDER is
shared only with the CPAs (Marella/Sara, "GFG Bookkeeper (Shared)") and
Rod, while DRIVERS_FOLDER additionally includes front office (Thao,
Michelle, Larry, Andrea, getinfo@) -- do not change which file goes to
which folder without re-checking that split.
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

TENANT_ID = "946674bd-c17c-4df0-b65d-dd3f3b9ffb25"
CLIENT_ID = "04b102ab-c003-4064-9a1d-6ffa46219c69"
TARGET_USER = "rod@gourmetforgood.com"

# Private: CPAs + Rod only. The full payroll workbook goes here.
EES_FOLDER = "# Shared w Marella and Sara/Payroll - EEs as of 2610"
# Shared with front office too. Individual driver advice PDFs go here.
DRIVERS_FOLDER = "# Shared w Marella and Sara/Payroll - Drivers as of 2610"

_TOKEN_URL = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"


def get_token():
    """App-only Microsoft Graph access token via the client-credentials
    flow. Raises RuntimeError (never silently returns None) so callers
    decide how to handle/report the failure -- a OneDrive outage should
    never crash or block a payroll finalize, see main.py's call site."""
    client_secret = os.environ.get("GRAPH_CLIENT_SECRET")
    if not client_secret:
        raise RuntimeError("GRAPH_CLIENT_SECRET is not set in this function's environment")

    data = urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "client_secret": client_secret,
        "scope": "https://graph.microsoft.com/.default",
        "grant_type": "client_credentials",
    }).encode()
    req = urllib.request.Request(_TOKEN_URL, data=data)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())["access_token"]
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:200]
        raise RuntimeError(f"HTTP {e.code} getting Graph token: {body}")
    except Exception as e:
        raise RuntimeError(f"Couldn't reach login.microsoftonline.com: {e}")


def upload_file(token, folder_path, filename, content_bytes, content_type):
    """Simple upload (PUT .../content). Graph allows this up to 4 MB,
    which comfortably covers one payroll workbook or one driver advice
    PDF -- if a file ever grows past that this will raise (Graph returns
    an error rather than truncating), which is the right failure mode:
    better a missing file + a loud warning than a silently corrupt one.
    Creates the destination folder automatically if it doesn't exist yet
    (Graph's path-based addressing does this for intermediate segments)."""
    encoded_path = urllib.parse.quote(f"{folder_path}/{filename}")
    url = (f"https://graph.microsoft.com/v1.0/users/{TARGET_USER}"
           f"/drive/root:/{encoded_path}:/content")
    req = urllib.request.Request(url, data=content_bytes, method="PUT", headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": content_type,
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:200]
        raise RuntimeError(f"HTTP {e.code} uploading '{filename}' to OneDrive: {body}")
