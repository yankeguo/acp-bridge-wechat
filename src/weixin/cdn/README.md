# Outbound CDN upload

`upload.ts` and `cdn-upload.ts` implement the WeChat CDN upload flow (`getUploadUrl` → AES encrypt → POST to CDN) for **sending files to users** (images, videos, files).

This is part of the vendored iLink protocol layer and is kept for upcoming outbound media support. Inbound media download lives under `../media/`.
