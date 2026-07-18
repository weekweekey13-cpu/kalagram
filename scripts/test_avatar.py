import json
import ssl
import time
import urllib.request

ctx = ssl.create_default_context()
base = "https://kalagram-z20h.onrender.com"
png = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
)
nick = f"av{int(time.time()) % 100000}"
body = json.dumps({"nick": nick, "password": "pass1234"}).encode()
req = urllib.request.Request(
    base + "/api/register",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, context=ctx, timeout=90) as r:
    data = json.loads(r.read().decode())
    tok = data["token"]
    print("reg ok", nick, "avatar", data["user"].get("avatar"))

boundary = "----boundX"
body = b""
body += f"--{boundary}\r\n".encode()
body += b'Content-Disposition: form-data; name="file"; filename="a.png"\r\n'
body += b"Content-Type: image/png\r\n\r\n"
body += png + b"\r\n"
body += f"--{boundary}--\r\n".encode()
req = urllib.request.Request(
    base + "/api/me/avatar",
    data=body,
    headers={
        "Authorization": "Bearer " + tok,
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, context=ctx, timeout=90) as r:
        out = json.loads(r.read().decode())
        print("upload", out)
        url = out.get("avatar")
except Exception as e:
    print("upload err", e)
    if hasattr(e, "read"):
        print(e.read().decode()[:800])
    raise SystemExit(1)

full = base + url if url.startswith("/") else url
req = urllib.request.Request(full)
with urllib.request.urlopen(req, context=ctx, timeout=90) as r:
    data = r.read()
    print("get", r.status, r.headers.get("Content-Type"), "bytes", len(data))
