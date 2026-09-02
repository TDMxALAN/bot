# WA-DP-Bot — WhatsApp Display Picture & Utility Bot

A WhatsApp user bot that runs on Railway.com with YouTube downloader, watchlist alert, and display picture lookup features.

## Features

- **`!dp <phone_number>`** — Fetches the display picture of the given phone number and sends it back as an image.
- **`!watch <phone_number>`** — Add a contact to your watchlist. (e.g. `!watch 94722666467`)
- **`!watchlist`** — View all watched contacts and reply with a number (e.g. `1`) to remove a contact.
- **`!yt <youtube_url>`** — Download YouTube videos or extract MP3 audio.
  - Choose option 1 (Video) or 2 (Audio) by replying/quoting the bot's prompt message.
  - Automatically handles large files (sends as a document if above 16MB).
- **Self-chat support** — You can send all commands directly to your own contact (chatting with yourself).

## Tech Stack

- **[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)** — Lightweight WhatsApp Web API (no Puppeteer/browser needed)
- **[qrcode](https://www.npmjs.com/package/qrcode)** — PNG QR generation served via built-in HTTP server
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp) & [ffmpeg](https://ffmpeg.org)** — Powered by Nixpacks on Railway for high quality YouTube media extraction
- **Node.js 18+**

## Deployment on Railway

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Add watchlist and youtube downloader features"
git remote add origin https://github.com/YOUR_USER/wa-dp-bot.git
git push -u origin main
```

### 2. Deploy on Railway

1. Go to [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo**
2. Select your repo.
3. Nixpacks automatically reads `nixpacks.toml` and installs system packages (`ffmpeg` and `yt-dlp`).
4. Once deployed, go to **Settings** → **Networking** → **Generate Domain** to get a public URL.

### 3. Scan QR Code

1. Open your Railway public URL (e.g., `https://wa-dp-bot-production.up.railway.app`).
2. Scan the crisp PNG QR code with WhatsApp (Linked Devices → Link a Device).
3. The page auto-refreshes every 30s; once connected, it displays a success message.

## Usage Examples

### 1. Fetch Display Picture
```
!dp 94722666467
```

### 2. Manage Watchlist
- Add: `!watch 94722666467`
- View & Remove: `!watchlist` (then reply with selection number, e.g. `1`)

### 3. YouTube Downloader
- Command: `!yt https://youtu.be/2i2khp_npdE`
- Bot responds asking you to reply with `1` (Video) or `2` (Audio).
- Reply to that message with `1` or `2` to receive the media.

## Adding a Railway Volume (Recommended)

To persist your WhatsApp session and your watchlist across redeployments:

1. In Railway, go to your service → **Settings** → **Volumes**
2. Add a volume mounted at `/app/auth_info` (to save your login session).
3. Add a volume mounted at `/app/watchlist.json` or mount a volume to the workspace directory to keep `watchlist.json` safe.

## Local Development

Ensure you have **FFmpeg** and **yt-dlp** installed in your system PATH.

```bash
npm install
npm start
```

Open `http://localhost:3000` to scan the QR code.