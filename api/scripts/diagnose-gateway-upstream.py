"""Read-only runtime diagnosis of the configured Gemma upstream; no secrets/log bodies."""
import json
import os
import subprocess
import sys
import time
from urllib.parse import urlsplit


def peer_summary(status, host):
    peer = next((p for p in status.get("Peer", {}).values() if host in p.get("TailscaleIPs", [])), None)
    return {
        "backendState": status.get("BackendState"),
        "selfOnline": status.get("Self", {}).get("Online"),
        "peer": None if not peer else {k: peer.get(k) for k in ["HostName", "Online", "Active", "LastSeen"]},
    }


def main():
    from dotenv import load_dotenv
    load_dotenv("/etc/agent-platform/gateway.env")
    sys.path.insert(0, "/opt/agent-platform/gateway/current/api")
    from app.services.gateway_tools import get_gateway_tool
    import httpx

    tool = get_gateway_tool("gemma")
    if not tool:
        print(json.dumps({"error": "GEMMA_TOOL_NOT_FOUND"})); return
    base = tool["base_url"].rstrip("/")
    url = urlsplit(base)
    if url.scheme not in ("http", "https") or url.username or url.password or url.query or url.fragment:
        print(json.dumps({"error": "UNSUPPORTED_UPSTREAM_URL"})); return
    result = {"tool": "gemma", "upstreamHost": url.hostname, "upstreamPort": url.port,
              "proxyEnvironmentPresent": any(os.environ.get(k) for k in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"])}
    try:
        service = subprocess.run(["systemctl", "is-active", "agent-gateway.service"], capture_output=True, text=True, timeout=5)
        result["service"] = service.stdout.strip() if service.stdout.strip() in ("active", "inactive", "failed", "activating") else "unknown"
    except Exception as error:
        result["serviceError"] = type(error).__name__
    try:
        status = subprocess.run(["tailscale", "status", "--json"], capture_output=True, text=True, timeout=10, check=True)
        result["tailscale"] = peer_summary(json.loads(status.stdout), url.hostname)
    except Exception as error:
        result["tailscaleError"] = type(error).__name__
    result["probes"] = []
    for trust_env in [True, False]:
        started = time.monotonic()
        row = {"trustEnvironment": trust_env}
        try:
            with httpx.Client(timeout=10, trust_env=trust_env, follow_redirects=False) as client:
                response = client.get(base + "/v1/models")
                row["status"] = response.status_code
                if response.status_code == 200:
                    payload = response.json()
                    row["selectedModelsPresent"] = [m.get("id") for m in payload.get("data", []) if m.get("id") in ["clef-flash", "gemma-4-26b-a4b-it-mlx"]]
        except Exception as error:
            row["error"] = type(error).__name__
        row["elapsedMs"] = round((time.monotonic() - started) * 1000)
        result["probes"].append(row)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"diagnosticError": type(error).__name__})); sys.exit(1)
