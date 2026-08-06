# Meshnology Web Flasher

A 100% client-side, open-source firmware flashing tool for **ESP32-S3** and **Nordic nRF52**. No login, no cloud, no telemetry. The browser talks to your device directly through **WebUSB**.

## Run locally

```bash
cd D:\Download\meshnology-web-flasher
npm install
npm run dev      # http://localhost:5173
# or
npm run build && npm run preview
```

WebUSB requires a **secure context** (HTTPS or `http://localhost`). Use **Chrome 89+** or **Edge 89+**.

## Use

1. Click **连接 USB 设备** and pick your board.
2. Drop a single merged `.bin` **or** switch to multi-file mode and set the offset for each segment.
3. Click **开始烧录**. The firmware never leaves your machine.

## Open source

MIT licensed. Contributions welcome.
