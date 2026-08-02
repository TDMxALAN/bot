const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

// ──────────────────────────────────────────────
// Persistent data directory
// On Railway: set the AUTH_DIR environment variable to the Volume mount path (e.g. /data).
// Locally: falls back to the project directory so nothing breaks.
// ──────────────────────────────────────────────
const mountPath = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.AUTH_DIR || process.env.DATA_DIR;
const DATA_DIR = mountPath
  ? path.resolve(mountPath)
  : __dirname;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Prepopulate YouTube OAuth2 token from environment variable if provided
function initYoutubeOauth() {
  if (process.env.YOUTUBE_OAUTH_TOKEN) {
    try {
      const tokenData = JSON.parse(process.env.YOUTUBE_OAUTH_TOKEN);
      const cacheDir = path.join(DATA_DIR, ".yt-dlp-cache");
      const oauthDir = path.join(cacheDir, "youtube-oauth2");
      const tokenPath = path.join(oauthDir, "token_data.json");

      if (!fs.existsSync(oauthDir)) {
        fs.mkdirSync(oauthDir, { recursive: true });
      }

      fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2), "utf8");
      console.log("✅ Prepopulated YouTube OAuth2 token from YOUTUBE_OAUTH_TOKEN env variable.");
    } catch (err) {
      console.error("⚠️ Failed to parse YOUTUBE_OAUTH_TOKEN env variable. Ensure it is a valid JSON string:", err.message);
    }
  }
}
initYoutubeOauth();

// Auth session path (survives redeployments when DATA_DIR is a Railway Volume)
const AUTH_DIR = path.join(DATA_DIR, "auth_info");

// Ensure temp directory exists
const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Watchlist storage path
const WATCHLIST_FILE = path.join(DATA_DIR, "watchlist.json");

// Callblocking storage path
const CALLBLOCKING_FILE = path.join(DATA_DIR, "callblocking.json");

// Active YouTube download requests mapping (messageId -> { url, requesterJid })
const activeYtRequests = new Map();

// ──────────────────────────────────────────────
// Watchlist and Callblocking persistence functions
// ──────────────────────────────────────────────

function loadCallBlocking() {
  try {
    if (fs.existsSync(CALLBLOCKING_FILE)) {
      const data = JSON.parse(fs.readFileSync(CALLBLOCKING_FILE, "utf-8"));
      return data.enabled || false;
    }
  } catch (err) {
    console.error("Error loading callblocking:", err);
  }
  return false;
}

function saveCallBlocking(enabled) {
  try {
    fs.writeFileSync(CALLBLOCKING_FILE, JSON.stringify({ enabled }, null, 2), "utf-8");
  } catch (err) {
    console.error("Error saving callblocking:", err);
  }
}

let isCallBlockingEnabled = loadCallBlocking();

function setCallBlocking(enabled) {
  isCallBlockingEnabled = enabled;
  saveCallBlocking(enabled);
}

function loadWatchlist() {
  try {
    if (fs.existsSync(WATCHLIST_FILE)) {
      return JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf-8"));
    }
  } catch (err) {
    console.error("Error loading watchlist:", err);
  }
  return {};
}

function saveWatchlist(watchlist) {
  try {
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2), "utf-8");
  } catch (err) {
    console.error("Error saving watchlist:", err);
  }
}

// Helper to download media message content from Baileys
async function downloadMediaMessage(message, type) {
  const stream = await downloadContentFromMessage(message, type);
  let buffer = Buffer.from([]);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }
  return buffer;
}

// ──────────────────────────────────────────────
// Sticker helpers
// ──────────────────────────────────────────────

/**
 * Injects sticker metadata (pack name + sticker name) into a WebP buffer
 * by appending a custom EXIF chunk that WhatsApp reads.
 * Format: RIFF…WEBP + EXIF chunk containing JSON in a proprietary layout.
 * WhatsApp uses a custom chunk tag 'EXIF' with JSON-encoded metadata.
 */
function addStickerMetadata(webpBuffer, packName = "", stickerName = "") {
  try {
    // Build JSON metadata payload (WhatsApp sticker metadata format)
    const metadata = JSON.stringify({
      "sticker-pack-id": `netzee-bot-${Date.now()}`,
      "sticker-pack-name": packName,
      "sticker-pack-publisher": "Netzee-bot",
      "emojis": ["🤖"],
      "android-app-store-link": "",
      "ios-app-store-link": "",
    });
    const metaBuf = Buffer.from(metadata, "utf8");

    // Build EXIF chunk: tag (4 bytes) + size (4 bytes LE) + data (padded to even)
    const chunkTag = Buffer.from("EXIF");
    const padding = metaBuf.length % 2 !== 0 ? Buffer.alloc(1, 0) : Buffer.alloc(0);
    const chunkSize = Buffer.alloc(4);
    chunkSize.writeUInt32LE(metaBuf.length + padding.length, 0);
    const exifChunk = Buffer.concat([chunkTag, chunkSize, metaBuf, padding]);

    // The RIFF file size field is at bytes 4-7; update it
    const newRiffSize = webpBuffer.length - 8 + exifChunk.length;
    const result = Buffer.concat([webpBuffer, exifChunk]);
    result.writeUInt32LE(newRiffSize, 4);

    return result;
  } catch (err) {
    console.warn("⚠️ Failed to add sticker metadata:", err.message);
    return webpBuffer; // Return original if metadata injection fails
  }
}

/**
 * Converts any image buffer to a 512×512 WebP sticker buffer.
 * Optionally embeds pack/sticker name in EXIF metadata.
 */
async function imageToSticker(imageBuffer, packName = "", stickerName = "") {
  const sharp = require("sharp");
  let webpBuffer = await sharp(imageBuffer)
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 80, lossless: false })
    .toBuffer();

  if (packName || stickerName) {
    webpBuffer = addStickerMetadata(webpBuffer, packName, stickerName);
  }

  return webpBuffer;
}

// ──────────────────────────────────────────────
// QR Web Server
// ──────────────────────────────────────────────

let currentQR = null; // holds the latest QR text
let botConnected = false;
let activeOauth2Request = null; // holds the active YouTube OAuth2 request

function buildHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Netzee-bot Control Panel</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #080808;
      --card-bg: rgba(25, 25, 25, 0.45);
      --border-color: rgba(255, 255, 255, 0.08);
      --text-main: #ffffff;
      --text-sub: #a0a0a0;
      --wa-color: #25D366;
      --yt-color: #ff3333;
      --glow-wa: 0 0 35px rgba(37, 211, 102, 0.2);
      --glow-yt: 0 0 35px rgba(255, 51, 51, 0.25);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-color);
      color: var(--text-main);
      font-family: 'Outfit', sans-serif;
      overflow-x: hidden;
      position: relative;
    }

    /* Ambient background glows */
    body::before, body::after {
      content: '';
      position: absolute;
      width: 350px;
      height: 350px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(37, 211, 102, 0.12) 0%, rgba(0, 0, 0, 0) 70%);
      z-index: -1;
      filter: blur(60px);
      animation: pulse 10s infinite alternate;
    }

    body::before {
      top: 15%;
      left: 10%;
    }

    body::after {
      bottom: 15%;
      right: 10%;
      background: radial-gradient(circle, rgba(255, 51, 51, 0.08) 0%, rgba(0, 0, 0, 0) 70%);
      animation-delay: 5s;
    }

    @keyframes pulse {
      0% { transform: scale(1) translate(0, 0); }
      100% { transform: scale(1.15) translate(15px, 15px); }
    }

    .container {
      width: 90%;
      max-width: 460px;
      z-index: 10;
    }

    .card {
      background: var(--card-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border-color);
      border-radius: 28px;
      padding: 40px;
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.6);
      transition: all 0.6s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
      overflow: hidden;
    }

    /* States glowing borders */
    .card.state-connected {
      border-color: rgba(37, 211, 102, 0.25);
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.6), var(--glow-wa);
    }

    .card.state-oauth {
      border-color: rgba(255, 51, 51, 0.25);
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.6), var(--glow-yt);
    }

    .section {
      display: none;
      flex-direction: column;
      align-items: center;
      text-align: center;
      animation: fadeInUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }

    .section.active {
      display: flex;
    }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(15px); }
      to { opacity: 1; transform: translateY(0); }
    }

    h1 {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 8px;
      letter-spacing: -0.5px;
    }

    .subtitle {
      font-size: 15px;
      color: var(--text-sub);
      margin-bottom: 28px;
      line-height: 1.5;
    }

    /* Spinner Container */
    .spinner-container {
      position: relative;
      width: 72px;
      height: 72px;
      margin-bottom: 24px;
    }

    .spinner {
      width: 100%;
      height: 100%;
      border: 4px solid rgba(255, 255, 255, 0.05);
      border-top: 4px solid var(--wa-color);
      border-radius: 50%;
      animation: spin 1s cubic-bezier(0.55, 0.085, 0.68, 0.53) infinite;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    /* Connected Icon */
    .status-icon {
      font-size: 64px;
      margin-bottom: 24px;
      filter: drop-shadow(0 0 10px rgba(37, 211, 102, 0.4));
      animation: pulseIcon 2s infinite alternate;
    }

    @keyframes pulseIcon {
      0% { transform: scale(0.96); }
      100% { transform: scale(1.04); }
    }

    /* QR Code elements */
    .qr-frame {
      background: #ffffff;
      padding: 16px;
      border-radius: 24px;
      margin-bottom: 24px;
      display: inline-block;
      box-shadow: 0 15px 30px rgba(0, 0, 0, 0.4);
    }

    .qr-frame img {
      display: block;
      width: 260px;
      height: 260px;
      border-radius: 8px;
    }

    .instructions {
      color: #dfdfdf;
      font-size: 14px;
      line-height: 1.7;
      text-align: left;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 16px;
      padding: 20px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      width: 100%;
    }

    .instructions strong {
      color: var(--wa-color);
    }

    /* OAuth2 Elements */
    .oauth-icon {
      font-size: 64px;
      margin-bottom: 20px;
      animation: float 3s ease-in-out infinite;
    }

    @keyframes float {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-8px); }
    }

    .code-container {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 18px;
      padding: 18px 24px;
      margin-bottom: 16px;
      cursor: pointer;
      width: 100%;
      position: relative;
      transition: all 0.3s;
    }

    .code-container:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 51, 51, 0.25);
    }

    .code-text {
      font-size: 34px;
      font-weight: 700;
      letter-spacing: 4px;
      font-family: monospace;
      color: var(--text-main);
    }

    .copy-tip {
      font-size: 11px;
      color: var(--text-sub);
      margin-top: 6px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      font-weight: 600;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--yt-color);
      color: #fff;
      text-decoration: none;
      font-weight: 600;
      font-size: 16px;
      padding: 16px 32px;
      border-radius: 16px;
      width: 100%;
      box-shadow: var(--glow-yt);
      transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      border: none;
      cursor: pointer;
    }

    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 28px rgba(255, 51, 51, 0.45);
      background: #ff4747;
    }

    .btn:active {
      transform: translateY(0);
    }

    /* Toast notification */
    .toast {
      position: absolute;
      bottom: 30px;
      left: 50%;
      transform: translateX(-50%) translateY(40px);
      background: var(--wa-color);
      color: #000;
      padding: 12px 24px;
      border-radius: 30px;
      font-size: 13px;
      font-weight: 700;
      opacity: 0;
      box-shadow: 0 10px 20px rgba(37, 211, 102, 0.3);
      transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      pointer-events: none;
      z-index: 100;
    }

    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  </style>
</head>
<body>

<div class="container">
  <div class="card" id="mainCard">
    
    <!-- State 1: Loading -->
    <div class="section" id="secLoading">
      <div class="spinner-container">
        <div class="spinner"></div>
      </div>
      <h1>Initializing</h1>
      <p class="subtitle" style="margin-bottom:0">Setting up WhatsApp session…</p>
    </div>

    <!-- State 2: QR Scan -->
    <div class="section" id="secQR">
      <h1 style="color: var(--wa-color)">🤖 Netzee-bot</h1>
      <p class="subtitle">Link your WhatsApp to get started</p>
      <div class="qr-frame">
        <img id="qrImage" src="" alt="WhatsApp QR Code" />
      </div>
      <div class="instructions">
        <strong>1.</strong> Open WhatsApp on your phone<br>
        <strong>2.</strong> Tap <strong>Linked Devices</strong> &rarr; <strong>Link a Device</strong><br>
        <strong>3.</strong> Scan the QR code shown above
      </div>
    </div>

    <!-- State 3: Connected -->
    <div class="section" id="secConnected">
      <div class="status-icon">✅</div>
      <h1 style="color: var(--wa-color)">Connected!</h1>
      <p class="subtitle" style="margin-bottom:0">Netzee-bot is active and linked to WhatsApp.</p>
    </div>

    <!-- State 4: YouTube OAuth2 -->
    <div class="section" id="secOAuth">
      <div class="oauth-icon">🍿</div>
      <h1 style="color: var(--yt-color)">YouTube Login Required</h1>
      <p class="subtitle">A YouTube video download is waiting for auth. Copy the code and authorize.</p>
      
      <div class="code-container" id="codeBox">
        <div class="code-text" id="oauthCode">XXXX-XXXX</div>
        <div class="copy-tip" id="copyTip">Click code to copy</div>
      </div>
      
      <a id="oauthLink" href="#" target="_blank" class="btn">Authorize in Browser &rarr;</a>
    </div>

  </div>
</div>

<div class="toast" id="toast">Code copied to clipboard!</div>

<script>
  let currentState = '';
  let currentQrValue = '';

  const mainCard = document.getElementById('mainCard');
  const sections = {
    loading: document.getElementById('secLoading'),
    qr: document.getElementById('secQR'),
    connected: document.getElementById('secConnected'),
    oauth: document.getElementById('secOAuth')
  };
  
  const qrImage = document.getElementById('qrImage');
  const oauthCode = document.getElementById('oauthCode');
  const oauthLink = document.getElementById('oauthLink');
  const codeBox = document.getElementById('codeBox');
  const toast = document.getElementById('toast');

  codeBox.addEventListener('click', () => {
    const code = oauthCode.innerText;
    if (code && code !== 'XXXX-XXXX') {
      navigator.clipboard.writeText(code).then(() => {
        toast.classList.add('show');
        setTimeout(() => {
          toast.classList.remove('show');
        }, 2000);
      });
    }
  });

  function setCardState(state) {
    if (currentState === state) return;
    currentState = state;

    mainCard.classList.remove('state-connected', 'state-oauth');
    Object.values(sections).forEach(sec => sec.classList.remove('active'));

    if (state === 'LOADING') {
      sections.loading.classList.add('active');
    } else if (state === 'QR') {
      sections.qr.classList.add('active');
    } else if (state === 'CONNECTED') {
      mainCard.classList.add('state-connected');
      sections.connected.classList.add('active');
    } else if (state === 'OAUTH') {
      mainCard.classList.add('state-oauth');
      sections.oauth.classList.add('active');
    }
  }

  async function checkStatus() {
    try {
      const res = await fetch('/status');
      if (!res.ok) throw new Error('Network error');
      const data = await res.json();

      if (data.activeOauth2Request) {
        oauthCode.innerText = data.activeOauth2Request.code;
        oauthLink.href = data.activeOauth2Request.url || 'https://www.google.com/device';
        setCardState('OAUTH');
      } else if (data.botConnected) {
        setCardState('CONNECTED');
      } else if (data.hasQR) {
        if (currentQrValue !== data.qr) {
          currentQrValue = data.qr;
          qrImage.src = '/qr.png?t=' + Date.now();
        }
        setCardState('QR');
      } else {
        setCardState('LOADING');
      }
    } catch (e) {
      console.error('Error fetching status:', e);
    }
  }

  checkStatus();
  setInterval(checkStatus, 2000);
</script>
</body>
</html>`;
}

function startQRServer() {
  const PORT = process.env.PORT || 3000;

  const server = http.createServer(async (req, res) => {
    const parsedUrl = req.url.split('?')[0];

    if (parsedUrl === "/status") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({
        botConnected,
        hasQR: !!currentQR,
        qr: currentQR,
        activeOauth2Request
      }));
      return;
    }

    if (parsedUrl === "/qr.png" && currentQR) {
      try {
        const pngBuffer = await QRCode.toBuffer(currentQR, {
          errorCorrectionLevel: "L",
          margin: 2,
          scale: 8,
          color: { dark: "#000000", light: "#FFFFFF" },
        });
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
        });
        res.end(pngBuffer);
      } catch (err) {
        res.writeHead(500);
        res.end("Error generating QR");
      }
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(buildHTML());
  });

  server.listen(PORT, () => {
    console.log(`🌐 QR web server running on port ${PORT}`);
    console.log(`   Open your Railway public URL to scan the QR code`);
  });
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function phoneToJid(raw) {
  const cleaned = raw.replace(/[\s\-\+\(\)]/g, "");
  return `${cleaned}@s.whatsapp.net`;
}

function getSenderJid(msg, sock) {
  if (msg.key.fromMe) return jidNormalizedUser(sock.user.id);
  if (msg.key.participant) return jidNormalizedUser(msg.key.participant);
  return jidNormalizedUser(msg.key.remoteJid);
}

function isProfilePicNotFoundError(err) {
  if (!err) return false;
  const status = err.output?.statusCode || err.statusCode || err.status || err.data;
  if (status === 404 || status === 401) return true;
  const msg = (err.message || "").toLowerCase();
  if (
    msg.includes("item-not-found") ||
    msg.includes("not-found") ||
    msg.includes("404") ||
    msg.includes("forbidden") ||
    msg.includes("privacy")
  ) {
    return true;
  }
  return false;
}

function cleanInstagramUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    u.search = ""; // Strip query params like ?igsh=...
    let clean = u.toString();
    if (!clean.endsWith("/")) clean += "/";
    return clean;
  } catch (e) {
    return urlStr;
  }
}

async function downloadInstagramVideo(igUrl) {
  const cleanUrl = cleanInstagramUrl(igUrl);

  const services = [
    // Service 1: vxinstagram proxy
    async () => {
      let vxUrl = cleanUrl.replace(/(www\.)?instagr(\.am|am\.com)/, "www.vxinstagram.com");
      if (vxUrl.includes("/p/")) {
        vxUrl = vxUrl.replace("/p/", "/reel/");
      }
      console.log("Trying vxinstagram:", vxUrl);
      const res = await fetch(vxUrl, {
        headers: {
          "User-Agent": "TelegramBot (like TwitterBot)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from vxinstagram`);
      const html = await res.text();
      const videoMatch =
        html.match(/<meta property="og:video" content="([^"]+)"/) ||
        html.match(/<meta property="og:video:secure_url" content="([^"]+)"/) ||
        html.match(/<meta name="twitter:player:stream" content="([^"]+)"/);
      if (!videoMatch) throw new Error("No video meta tag found in vxinstagram html");

      const videoUrl = videoMatch[1].replace(/&amp;/g, "&");
      const vidRes = await fetch(videoUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
      if (!vidRes.ok) throw new Error(`HTTP ${vidRes.status} downloading video buffer`);
      const buffer = Buffer.from(await vidRes.arrayBuffer());
      if (buffer.length < 5000) throw new Error("Video buffer too small");
      return { buffer, filename: `ig_video_${Date.now()}.mp4` };
    },
    // Service 2: kkinstagram proxy
    async () => {
      let kkUrl = cleanUrl.replace(/(www\.)?instagr(\.am|am\.com)/, "www.kkinstagram.com");
      if (kkUrl.includes("/p/")) {
        kkUrl = kkUrl.replace("/p/", "/reel/");
      }
      console.log("Trying kkinstagram:", kkUrl);
      const res = await fetch(kkUrl, {
        headers: {
          "User-Agent": "TelegramBot (like TwitterBot)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from kkinstagram`);
      const html = await res.text();
      const videoMatch =
        html.match(/<meta property="og:video" content="([^"]+)"/) ||
        html.match(/<meta property="og:video:secure_url" content="([^"]+)"/);
      if (!videoMatch) throw new Error("No video meta tag found in kkinstagram html");

      const videoUrl = videoMatch[1].replace(/&amp;/g, "&");
      const vidRes = await fetch(videoUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
      if (!vidRes.ok) throw new Error(`HTTP ${vidRes.status} downloading video buffer`);
      const buffer = Buffer.from(await vidRes.arrayBuffer());
      if (buffer.length < 5000) throw new Error("Video buffer too small");
      return { buffer, filename: `ig_video_${Date.now()}.mp4` };
    },
    // Service 3: Instagram Embed fallback
    async () => {
      const embedUrl = `${cleanUrl}embed/captioned/`;
      console.log("Trying Instagram Embed:", embedUrl);
      const res = await fetch(embedUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from IG embed`);
      const html = await res.text();
      const videoMatch = html.match(/video_url":"([^"]+)"/) || html.match(/src="([^"]+\.mp4[^"]*)"/);
      if (!videoMatch) throw new Error("No video URL found in IG embed page");

      const videoUrl = videoMatch[1].replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
      const vidRes = await fetch(videoUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
      if (!vidRes.ok) throw new Error(`HTTP ${vidRes.status} downloading video buffer`);
      const buffer = Buffer.from(await vidRes.arrayBuffer());
      if (buffer.length < 5000) throw new Error("Video buffer too small");
      return { buffer, filename: `ig_video_${Date.now()}.mp4` };
    }
  ];

  let lastError = null;
  for (const service of services) {
    try {
      return await service();
    } catch (err) {
      console.warn("Instagram download service attempt failed:", err.message);
      lastError = err;
    }
  }
  throw lastError || new Error("Failed to download Instagram video from all available services.");
}

async function downloadFromCobalt(videoUrl, isAudioOnly, quality = "720") {
  const instances = [
    "https://api.cobalt.tools",
    "https://api.cobalt.best",
    "https://cobalt.api.ryz.cx",
    "https://cobalt.colbster.com",
  ];

  let lastError = null;

  for (const instance of instances) {
    try {
      console.log(`Trying Cobalt instance: ${instance}`);
      const response = await fetch(`${instance}/api/json`, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: videoUrl,
          isAudioOnly: isAudioOnly,
          videoQuality: quality,
          filenamePattern: "basic",
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status} from ${instance}`);
      }

      const data = await response.json();
      if (data.status === "error") {
        throw new Error(data.text || "Unknown Cobalt error");
      }

      if ((data.status === "stream" || data.status === "redirect") && data.url) {
        console.log(`Downloading file from: ${data.url}`);
        const fileResponse = await fetch(data.url);
        if (!fileResponse.ok) {
          throw new Error(`Failed to download media file from ${data.url}`);
        }
        const buffer = Buffer.from(await fileResponse.arrayBuffer());
        return { buffer, filename: data.filename || (isAudioOnly ? "audio.mp3" : "video.mp4") };
      }

      throw new Error(`Unsupported status response: ${data.status}`);
    } catch (err) {
      console.warn(`Cobalt instance ${instance} failed: ${err.message}`);
      lastError = err;
    }
  }

  throw lastError || new Error("All Cobalt instances failed");
}


let ytDlpPath = "yt-dlp";

async function ensureLatestYtDlp() {
  const isLinux = process.platform === "linux";
  if (!isLinux) {
    console.log("ℹ️ Non-Linux platform. Using system-installed yt-dlp.");
    return "yt-dlp";
  }

  // Prefer the venv-installed yt-dlp (has PO token plugin in the same Python env)
  const venvYtDlpPath = "/opt/ytdlp-venv/bin/yt-dlp";
  if (fs.existsSync(venvYtDlpPath)) {
    console.log(`✅ Using venv yt-dlp with PO token plugin at ${venvYtDlpPath}`);
    return venvYtDlpPath;
  }

  // Fallback: download standalone binary (no PO token support)
  const localYtDlpPath = path.join(tempDir, "yt-dlp");
  console.log("⚠️ Venv yt-dlp not found. Downloading standalone binary (no PO token support)...");
  try {
    const { execSync } = require("child_process");
    execSync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${localYtDlpPath}"`, { stdio: "ignore" });
    execSync(`chmod a+rx "${localYtDlpPath}"`, { stdio: "ignore" });
    console.log(`✅ Downloaded latest yt-dlp binary to ${localYtDlpPath}`);
    return localYtDlpPath;
  } catch (err) {
    console.error("⚠️ Failed to download yt-dlp binary, falling back to system-installed version:", err);
    return "yt-dlp";
  }
}


// Helper to spawn yt-dlp command safely without shell escaping vulnerability
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const finalArgs = [...args];

    // Determine if this is a YouTube download
    const isYouTube = args.some(arg => 
      typeof arg === "string" && 
      (arg.includes("youtube.com") || arg.includes("youtu.be"))
    );

    // Ensure we use a persistent cache directory for tokens
    const cacheDir = path.join(DATA_DIR, ".yt-dlp-cache");
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    finalArgs.push("--cache-dir", cacheDir);

    // If YouTube, append the OAuth2 authentication arguments
    if (isYouTube) {
      finalArgs.push("--username", "oauth2", "--password", "");
    }

    console.log(`ℹ️ Spawning yt-dlp with args: ${finalArgs.join(" ")}`);

    const child = spawn(ytDlpPath, finalArgs);
    let stdout = "";
    let stderr = "";
    let loggedAuth = false;
    let rollingBuffer = "";

    const handleData = (data) => {
      const text = data.toString();
      // Write to console in real-time so logs show in Railway
      process.stdout.write(text);

      rollingBuffer += text;
      if (rollingBuffer.length > 2000) {
        rollingBuffer = rollingBuffer.slice(-1000);
      }

      // Check if OAuth2 authentication is requested
      if (rollingBuffer.includes("google.com/device") && !loggedAuth) {
        // Find any alphanumeric string with hyphens of format XXX-YYY-ZZZ or XXXX-XXXX
        const codeRegex = /([A-Z0-9]{3,4}-[A-Z0-9]{3,4}(?:-[A-Z0-9]{3,4})?)/i;
        const codeMatch = rollingBuffer.match(codeRegex);
        if (codeMatch) {
          const code = codeMatch[1];
          console.log("\n" + "🚨".repeat(25));
          console.log("📢 YOUTUBE OAUTH2 AUTHENTICATION REQUIRED");
          console.log("👉 Go to: https://www.google.com/device");
          console.log(`🔑 Code:  ${code}`);
          console.log("🚨".repeat(25) + "\n");
          loggedAuth = true;
          activeOauth2Request = { code, url: "https://www.google.com/device" };
        }
      }
    };

    child.stdout.on("data", (data) => {
      stdout += data.toString();
      handleData(data);
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
      handleData(data);
    });

    child.on("close", (code) => {
      activeOauth2Request = null;
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`yt-dlp exited with code ${code}\nStderr: ${stderr}`));
      }
    });
  });
}

// Periodic check for watchlisted profile pictures
async function checkProfilePictures(sock, watchlist) {
  console.log("⏰ Running periodic profile picture check...");
  let changed = false;

  for (const targetJid of Object.keys(watchlist)) {
    const target = watchlist[targetJid];
    if (!target.requesters || target.requesters.length === 0) continue;

    try {
      let currentDpUrl = null;
      let fetchError = null;
      try {
        currentDpUrl = await sock.profilePictureUrl(targetJid, "image");
      } catch (err) {
        fetchError = err;
        currentDpUrl = null; // No profile picture set or privacy restricted or network error
      }

      if (fetchError) {
        if (!isProfilePicNotFoundError(fetchError)) {
          console.warn(`⚠️ Temporary network/API error checking DP for ${target.phone}:`, fetchError.message || fetchError);
          // Do NOT reset DP or send removal alert on network/API errors
          continue;
        }

        // DP was genuinely removed or hidden
        if (target.lastDpUrl !== null || target.lastDpHash !== null) {
          console.log(`📸 Profile picture removed for ${target.phone}`);
          target.lastDpUrl = null;
          target.lastDpHash = null;
          changed = true;

          for (const requesterJid of target.requesters) {
            try {
              await sock.sendMessage(requesterJid, {
                text: `🔔 Watchlist Alert: *${target.phone}* removed their profile picture.`,
              });
            } catch (e) {
              console.error(`Failed to send DP removal update to ${requesterJid}:`, e);
            }
          }
        }
        continue;
      }

      if (currentDpUrl) {
        try {
          const response = await fetch(currentDpUrl);
          if (response.ok) {
            const buffer = Buffer.from(await response.arrayBuffer());
            const currentHash = crypto.createHash("md5").update(buffer).digest("hex");

            if (!target.lastDpHash) {
              if (target.lastDpUrl === null) {
                // DP was previously removed/absent — now they have one again, notify!
                console.log(`📸 Profile picture re-added for ${target.phone}`);
                target.lastDpUrl = currentDpUrl;
                target.lastDpHash = currentHash;
                changed = true;

                for (const requesterJid of target.requesters) {
                  try {
                    await sock.sendMessage(requesterJid, {
                      image: buffer,
                      caption: `🔔 Watchlist Alert: *${target.phone}* added a new profile picture!`,
                    });
                  } catch (e) {
                    console.error(`Failed to send DP added update to ${requesterJid}:`, e);
                  }
                }
              } else {
                // No hash yet (existing entry before hash tracking) — set baseline silently
                target.lastDpUrl = currentDpUrl;
                target.lastDpHash = currentHash;
                changed = true;
              }
            } else if (currentHash !== target.lastDpHash) {
              console.log(`📸 Profile picture updated for ${target.phone}`);
              target.lastDpUrl = currentDpUrl;
              target.lastDpHash = currentHash;
              changed = true;

              for (const requesterJid of target.requesters) {
                try {
                  await sock.sendMessage(requesterJid, {
                    image: buffer,
                    caption: `🔔 Watchlist Alert: *${target.phone}* updated their profile picture!`,
                  });
                } catch (e) {
                  console.error(`Failed to send DP update to ${requesterJid}:`, e);
                }
              }
            } else if (target.lastDpUrl !== currentDpUrl) {
              // Same hash, but update URL quietly
              target.lastDpUrl = currentDpUrl;
              changed = true;
            }
          }
        } catch (fetchImgErr) {
          console.warn(`⚠️ Failed to fetch DP image buffer for ${target.phone}:`, fetchImgErr.message || fetchImgErr);
        }
      }
    } catch (err) {
      console.error(`Error checking profile picture for ${targetJid}:`, err);
    }
  }

  if (changed) {
    saveWatchlist(watchlist);
  }
}

// ──────────────────────────────────────────────
// Bot
// ──────────────────────────────────────────────

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const logger = pino({ level: "silent" });

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["Netzee-bot", "Chrome", "1.0.0"],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
  });

  let ppCheckInterval = null;

  // ── Auth / connection events ──────────────────

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("call", async (calls) => {
    if (isCallBlockingEnabled) {
      for (const call of calls) {
        if (call.status === "offer" || call.status === "ringing") {
          console.log(`Rejecting call from ${call.from}`);
          await sock.rejectCall(call.id, call.from);
        }
      }
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      botConnected = false;
      console.log("📱 New QR code generated — open your Railway URL to scan it");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      if (ppCheckInterval) {
        clearInterval(ppCheckInterval);
        ppCheckInterval = null;
      }

      if (statusCode === DisconnectReason.loggedOut) {
        console.log(`❌ Session logged out. Delete ${AUTH_DIR}/ and restart.`);
        process.exit(1);
      }

      console.log(`⚠️  Connection closed (code ${statusCode}). Reconnecting…`);
      botConnected = false;
      setTimeout(startBot, 3000);
    }

    if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
      currentQR = null;
      botConnected = true;

      // Start periodic check every 1 minute
      if (!ppCheckInterval) {
        ppCheckInterval = setInterval(() => {
          checkProfilePictures(sock, loadWatchlist());
        }, 60 * 1000);
        // Run once immediately on startup
        checkProfilePictures(sock, loadWatchlist());
      }
    }
  });

  // ── Message handler ───────────────────────────

  // Tracks pending watchlist removal sessions: senderJid -> { chatJid, watchedList, timestamp }
  const pendingWatchlistSessions = new Map();

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const watchlist = loadWatchlist();

    for (const msg of messages) {
      if (!msg.message) continue;

      // Identify if the message was sent to self-chat
      const isSelf = jidNormalizedUser(msg.key.remoteJid) === jidNormalizedUser(sock.user.id);
      
      // Allow self-chat messages or commands from others, but ignore non-self messages sent by us
      // if (msg.key.fromMe && !isSelf) continue; // commented out to allow bot owner to run commands

      // Handle status broadcasts for watchlisted contacts
      if (msg.key.remoteJid === "status@broadcast") {
        const participantJid = msg.key.participant || msg.participant;
        if (!participantJid) continue;

        const normalizedParticipant = jidNormalizedUser(participantJid);
        if (watchlist[normalizedParticipant]) {
          console.log(`📱 Status update detected from watched contact: ${normalizedParticipant}`);
          const target = watchlist[normalizedParticipant];

          const imageMsg = msg.message?.imageMessage;
          const videoMsg = msg.message?.videoMessage;
          const audioMsg = msg.message?.audioMessage;
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

          for (const requesterJid of target.requesters) {
            try {
              if (imageMsg) {
                const buffer = await downloadMediaMessage(imageMsg, "image");
                await sock.sendMessage(requesterJid, {
                  image: buffer,
                  caption: `🔔 Watchlist Status Alert from *${target.phone}* (Image)${imageMsg.caption ? `:\n\n${imageMsg.caption}` : ""}`,
                });
              } else if (videoMsg) {
                const buffer = await downloadMediaMessage(videoMsg, "video");
                await sock.sendMessage(requesterJid, {
                  video: buffer,
                  caption: `🔔 Watchlist Status Alert from *${target.phone}* (Video)${videoMsg.caption ? `:\n\n${videoMsg.caption}` : ""}`,
                });
              } else if (audioMsg) {
                const buffer = await downloadMediaMessage(audioMsg, "audio");
                await sock.sendMessage(requesterJid, {
                  audio: buffer,
                  mimetype: "audio/ogg; codecs=opus",
                });
              } else if (text) {
                await sock.sendMessage(requesterJid, {
                  text: `🔔 Watchlist Status Alert from *${target.phone}* (Text):\n\n${text}`,
                });
              }
            } catch (err) {
              console.error(`Failed to forward status from ${target.phone} to ${requesterJid}:`, err);
            }
          }
        }
        continue;
      }

      // Read message text
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      const chatJid = msg.key.remoteJid;

      // Check if sender has a pending watchlist session and sent a plain number
      const senderJidForSession = getSenderJid(msg, sock);

      if (/^\d+$/.test(text.trim()) && pendingWatchlistSessions.has(senderJidForSession)) {
        const session = pendingWatchlistSessions.get(senderJidForSession);
        // Expire sessions older than 5 minutes
        if (Date.now() - session.timestamp > 5 * 60 * 1000) {
          pendingWatchlistSessions.delete(senderJidForSession);
        } else {
          const index = parseInt(text.trim(), 10);
          const { watchedList } = session;

          if (index > 0 && index <= watchedList.length) {
            const target = watchedList[index - 1];
            // Reload watchlist to get latest state before modifying
            const wl = loadWatchlist();
            if (wl[target.key]) {
              wl[target.key].requesters = wl[target.key].requesters.filter(
                (r) => r !== senderJidForSession
              );
              if (wl[target.key].requesters.length === 0) {
                delete wl[target.key];
              }
              saveWatchlist(wl);
            }
            pendingWatchlistSessions.delete(senderJidForSession);
            await sock.sendMessage(chatJid, {
              text: `✅ Removed *${target.phone}* from your watchlist.`,
            }, { quoted: msg });
          } else {
            await sock.sendMessage(chatJid, {
              text: `❌ Invalid choice. Please send a valid number from 1 to ${watchedList.length}.`,
            }, { quoted: msg });
          }
          continue;
        }
      }

      // Check if message is a reply to one of our active YouTube prompt requests
      const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
      if (quotedId && activeYtRequests.has(quotedId)) {
        const request = activeYtRequests.get(quotedId);
        const choice = text.trim();

        if (choice === "1") {
          activeYtRequests.delete(quotedId); // Consume the request
          await sock.sendMessage(chatJid, { react: { text: "⏳", key: msg.key } });

          const id = quotedId;
          const outputPath = path.join(tempDir, `video_${id}.mp4`);
          console.log(`🎥 Downloading video from: ${request.url}`);

          let videoBuffer = null;
          let filename = `video_${id}.mp4`;

          try {
            // Primary download attempt: Cobalt API
            const cobaltResult = await downloadFromCobalt(request.url, false);
            videoBuffer = cobaltResult.buffer;
            filename = cobaltResult.filename;
            console.log("✅ Successfully downloaded video using Cobalt API.");
          } catch (cobaltErr) {
            console.warn("⚠️ Cobalt download failed. Falling back to local yt-dlp...", cobaltErr.message);
            try {
              await runYtDlp([
                "--extractor-args", "youtube:player_client=android,web",
                "-f", "best[ext=mp4]/best",
                "--recode-video", "mp4",
                "--no-playlist",
                "--max-filesize", "50M",
                "-o", outputPath,
                request.url
              ]);

              if (fs.existsSync(outputPath)) {
                videoBuffer = fs.readFileSync(outputPath);
              } else {
                throw new Error("Video file was not created by yt-dlp");
              }
            } catch (dlpErr) {
              console.error("❌ Fallback local yt-dlp download failed:", dlpErr);
              await sock.sendMessage(chatJid, {
                text: `❌ Failed to download video. It might be too large (>50MB) or restricted.\n\nError: ${dlpErr.message}`,
              }, { quoted: msg });
              await sock.sendMessage(chatJid, { react: { text: "❌", key: msg.key } });
              continue;
            } finally {
              if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
              }
            }
          }

          if (videoBuffer) {
            try {
              const fileSizeInMB = videoBuffer.length / (1024 * 1024);
              if (fileSizeInMB > 16) {
                await sock.sendMessage(chatJid, {
                  document: videoBuffer,
                  mimetype: "video/mp4",
                  fileName: filename,
                  caption: "🎥 Here is your video (sent as document due to size limit)",
                }, { quoted: msg });
              } else {
                await sock.sendMessage(chatJid, {
                  video: videoBuffer,
                  caption: "🎥 Here is your video!",
                }, { quoted: msg });
              }
              await sock.sendMessage(chatJid, { react: { text: "✅", key: msg.key } });
            } catch (err) {
              console.error("Error sending video message:", err);
              await sock.sendMessage(chatJid, { text: "❌ Error sending video file." }, { quoted: msg });
              await sock.sendMessage(chatJid, { react: { text: "❌", key: msg.key } });
            }
          }
          continue;
        } else if (choice === "2") {
          activeYtRequests.delete(quotedId); // Consume the request
          await sock.sendMessage(chatJid, { react: { text: "⏳", key: msg.key } });

          const id = quotedId;
          const outputPathPattern = path.join(tempDir, `audio_${id}.%(ext)s`);
          const expectedFilePath = path.join(tempDir, `audio_${id}.mp3`);
          console.log(`🎵 Downloading audio from: ${request.url}`);

          let audioBuffer = null;
          let filename = `audio_${id}.mp3`;

          try {
            // Primary download attempt: Cobalt API
            const cobaltResult = await downloadFromCobalt(request.url, true);
            audioBuffer = cobaltResult.buffer;
            filename = cobaltResult.filename;
            console.log("✅ Successfully downloaded audio using Cobalt API.");
          } catch (cobaltErr) {
            console.warn("⚠️ Cobalt audio download failed. Falling back to local yt-dlp...", cobaltErr.message);
            try {
              await runYtDlp([
                "--extractor-args", "youtube:player_client=android,web",
                "-x",
                "--audio-format", "mp3",
                "--no-playlist",
                "-o", outputPathPattern,
                request.url
              ]);

              if (fs.existsSync(expectedFilePath)) {
                audioBuffer = fs.readFileSync(expectedFilePath);
              } else {
                throw new Error("Audio file was not created by yt-dlp");
              }
            } catch (dlpErr) {
              console.error("❌ Fallback local yt-dlp audio download failed:", dlpErr);
              await sock.sendMessage(chatJid, {
                text: `❌ Failed to download audio.\n\nError: ${dlpErr.message}`,
              }, { quoted: msg });
              await sock.sendMessage(chatJid, { react: { text: "❌", key: msg.key } });
              continue;
            } finally {
              if (fs.existsSync(expectedFilePath)) {
                fs.unlinkSync(expectedFilePath);
              }
            }
          }

          if (audioBuffer) {
            try {
              await sock.sendMessage(chatJid, {
                document: audioBuffer,
                mimetype: "audio/mpeg",
                fileName: filename,
              }, { quoted: msg });
              await sock.sendMessage(chatJid, { react: { text: "✅", key: msg.key } });
            } catch (err) {
              console.error("Error sending audio message:", err);
              await sock.sendMessage(chatJid, { text: "❌ Error sending audio file." }, { quoted: msg });
              await sock.sendMessage(chatJid, { react: { text: "❌", key: msg.key } });
            }
          }
          continue;
        } else {
          await sock.sendMessage(chatJid, {
            text: "❌ Invalid selection. Please reply with *1* (Video) or *2* (Audio).",
          }, { quoted: msg });
          continue;
        }
      }

      // --- COMMAND: !dp ---
      if (text.toLowerCase().startsWith("!dp")) {
        const parts = text.trim().split(/\s+/);
        if (parts.length < 2) {
          await sock.sendMessage(chatJid, {
            text: "❌ Usage: *!dp <phone_number>*\nExamples:\n`!dp 94722666467`\n`!dp +94 72 266 6467`",
          }, { quoted: msg });
          continue;
        }

        // Join everything after the command to support spaced formats like: +94 72 266 6467
        const targetPhone = parts.slice(1).join("");
        const targetJid = phoneToJid(targetPhone);

        console.log(`📸 !dp request from ${chatJid} for ${targetPhone}`);

        try {
          await sock.sendMessage(chatJid, { react: { text: "⏳", key: msg.key } });

          let ppUrl;
          try {
            ppUrl = await sock.profilePictureUrl(targetJid, "image");
          } catch (err) {
            await sock.sendMessage(chatJid, {
              text: `⚠️ Could not fetch DP for *${targetPhone}*.\nThe user may have no DP set or their privacy settings block it.`,
            }, { quoted: msg });
            await sock.sendMessage(chatJid, { react: { text: "❌", key: msg.key } });
            continue;
          }

          const response = await fetch(ppUrl);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = Buffer.from(await response.arrayBuffer());

          await sock.sendMessage(chatJid, {
            image: buffer,
            caption: `📸 Display picture of *${targetPhone}*`,
          }, { quoted: msg });

          await sock.sendMessage(chatJid, { react: { text: "✅", key: msg.key } });
          console.log(`✅ Sent DP of ${targetPhone} to ${chatJid}`);
        } catch (err) {
          console.error(`Error handling !dp for ${targetPhone}:`, err);
          await sock.sendMessage(chatJid, {
            text: `❌ Something went wrong fetching the DP. Please try again.`,
          }, { quoted: msg });
          await sock.sendMessage(chatJid, { react: { text: "❌", key: msg.key } });
        }
        continue;
      }

      // --- COMMAND: !callblocking ---
      if (text.toLowerCase().startsWith("!callblocking")) {
        if (!isSelf) {
          // Command only executable in self chat
          continue;
        }

        const parts = text.trim().split(/\s+/);
        const subCommand = parts[1]?.toLowerCase();

        if (subCommand === "on") {
          setCallBlocking(true);
          await sock.sendMessage(chatJid, { text: "✅ Call blocking is now ON. All incoming calls will be automatically declined." }, { quoted: msg });
        } else if (subCommand === "off") {
          setCallBlocking(false);
          await sock.sendMessage(chatJid, { text: "✅ Call blocking is now OFF." }, { quoted: msg });
        } else {
          await sock.sendMessage(chatJid, { text: "❌ Usage: *!callblocking on* or *!callblocking off*" }, { quoted: msg });
        }
        continue;
      }

      // --- COMMAND: !watch ---
      if (text.toLowerCase().startsWith("!watch ") || text.trim().toLowerCase() === "!watch") {
        const parts = text.trim().split(/\s+/);
        const targetPhoneRaw = parts.slice(1).join("");
        if (!targetPhoneRaw) {
          await sock.sendMessage(chatJid, {
            text: "❌ Usage: *!watch <phone_number>*\nExample: `!watch 94722666467`",
          }, { quoted: msg });
          continue;
        }

        const senderJid = getSenderJid(msg, sock);
        const targetJid = phoneToJid(targetPhoneRaw);
        const targetPhone = targetJid.split("@")[0]; // Cleaned phone number for display
        
        if (!watchlist[targetJid]) {
          watchlist[targetJid] = {
            phone: targetPhone,
            lastDpUrl: null,
            lastDpHash: null,
            requesters: [],
          };
        }

        if (!watchlist[targetJid].requesters.includes(senderJid)) {
          watchlist[targetJid].requesters.push(senderJid);
        }

        // Initial DP fetch & hash baseline
        try {
          const currentDpUrl = await sock.profilePictureUrl(targetJid, "image");
          watchlist[targetJid].lastDpUrl = currentDpUrl;
          const response = await fetch(currentDpUrl);
          if (response.ok) {
            const buffer = Buffer.from(await response.arrayBuffer());
            watchlist[targetJid].lastDpHash = crypto.createHash("md5").update(buffer).digest("hex");
          }
        } catch (e) {
          watchlist[targetJid].lastDpUrl = null;
          watchlist[targetJid].lastDpHash = null;
        }

        saveWatchlist(watchlist);

        await sock.sendMessage(chatJid, {
          text: `✅ Added *${targetPhone}* to your watchlist! You will be notified of display picture and status updates.`,
        }, { quoted: msg });
        continue;
      }

      // --- COMMAND: !watchlist ---
      if (text.toLowerCase().startsWith("!watchlist")) {
        const senderJid = getSenderJid(msg, sock);
        
        const watchedList = [];
        for (const key of Object.keys(watchlist)) {
          if (watchlist[key].requesters && watchlist[key].requesters.includes(senderJid)) {
            watchedList.push({ key, phone: watchlist[key].phone });
          }
        }
        watchedList.sort((a, b) => a.phone.localeCompare(b.phone));

        if (watchedList.length === 0) {
          await sock.sendMessage(chatJid, {
            text: "📂 Your watchlist is currently empty.\n\nTo add a contact, send: *!watch <phone_number>*\nExample: `!watch 94722666467`",
          }, { quoted: msg });
        } else {
          const listText = watchedList.map((item, idx) => `*${idx + 1}.* ${item.phone}`).join("\n");
          // Store a pending session so the next plain number removes an entry
          pendingWatchlistSessions.set(senderJid, {
            chatJid,
            watchedList,
            timestamp: Date.now(),
          });
          await sock.sendMessage(chatJid, {
            text: `📂 *Your Watchlist:*\n\n${listText}\n\n_Send the number of the contact you want to remove (e.g. 1)._`,
          }, { quoted: msg });
        }
        continue;
      }

      // --- COMMAND: !fb ---
      if (text.toLowerCase().startsWith("!fb")) {
        const parts = text.trim().split(/\s+/);
        if (parts.length < 2) {
          await sock.sendMessage(chatJid, {
            text: "❌ Usage: *!fb <facebook_url>*\nExample: `!fb https://www.facebook.com/share/r/18nfTFFM3g/`",
          }, { quoted: msg });
          continue;
        }

        const fbUrl = parts[1];
        if (!fbUrl.includes("facebook.com") && !fbUrl.includes("fb.watch") && !fbUrl.includes("fb.gg")) {
          await sock.sendMessage(chatJid, {
            text: "❌ Please provide a valid Facebook URL.",
          }, { quoted: msg });
          continue;
        }

        await sock.sendMessage(chatJid, { react: { text: "⏳", key: msg.key } });

        const id = msg.key.id;
        const outputPath = path.join(tempDir, `fb_video_${id}.mp4`);
        console.log(`🎥 Downloading Facebook video from: ${fbUrl}`);

        let videoBuffer = null;
        let filename = `fb_video_${id}.mp4`;

        try {
          // Primary download attempt: Cobalt API with max quality
          const cobaltResult = await downloadFromCobalt(fbUrl, false, "480");
          videoBuffer = cobaltResult.buffer;
          filename = cobaltResult.filename;
          console.log("✅ Successfully downloaded FB video using Cobalt API.");
        } catch (cobaltErr) {
          console.warn("⚠️ Cobalt FB download failed. Falling back to local yt-dlp...", cobaltErr.message);
          try {
            await runYtDlp([
              "--extractor-args", "facebook:player_client=android,web",
              "-f", "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best",
              "--recode-video", "mp4",
              "--no-playlist",
              "--max-filesize", "50M",
              "-o", outputPath,
              fbUrl
            ]);

            if (fs.existsSync(outputPath)) {
              videoBuffer = fs.readFileSync(outputPath);
            } else {
              throw new Error("Video file was not created by yt-dlp");
            }
          } catch (dlpErr) {
            console.error("❌ Fallback local yt-dlp FB download failed:", dlpErr);
            await sock.sendMessage(chatJid, {
              text: `❌ Failed to download Facebook video. It might be too large (>50MB) or restricted.\n\nError: ${dlpErr.message}`,
            }, { quoted: msg });
            await sock.sendMessage(chatJid, { react: { text: "❌", key: msg.key } });
            continue;
          } finally {
            if (fs.existsSync(outputPath)) {
              fs.unlinkSync(outputPath);
            }
          }
        }

        if (videoBuffer) {
          try {
            const fileSizeInMB = videoBuffer.length / (1024 * 1024);
            if (fileSizeInMB > 16) {
              await sock.sendMessage(chatJid, {
                document: videoBuffer,
                mimetype: "video/mp4",
                fileName: filename,
                caption: "🎥 Here is your Facebook video (sent as document due to size limit)",
              }, { quoted: msg });
            } else {
              await sock.sendMessage(chatJid, {
                video: videoBuffer,
                caption: "🎥 Here is your Facebook video!",
              }, { quoted: msg });
            }
            await sock.sendMessage(chatJid, { react: { text: "✅", key: msg.key } });
          } catch (err) {
            console.error("Error sending FB video message:", err);
            await sock.sendMessage(chatJid, { text: "❌ Error sending video file." }, { quoted: msg });
            await sock.sendMessage(chatJid, { react: { text: "❌", key: msg.key } });
          }
        }
        continue;
      }

      // --- COMMAND: !tt ---
      if (text.toLowerCase().startsWith("!tt")) {
        const parts = text.trim().split(/\s+/);
        if (parts.length < 2) {
          await sock.sendMessage(chatJid, {
            text: "❌ Usage: *!tt <tiktok_url>*\nExample: `!tt https://www.tiktok.com/@user/video/123456789`",
          }, { quoted: msg });
          continue;
        }

        const ttUrl = parts[1];
        const isTikTok =
          ttUrl.includes("tiktok.com") ||
          ttUrl.includes("vm.tiktok.com") ||
          ttUrl.includes("vt.tiktok.com");

        if (!isTikTok) {
          await sock.sendMessage(chatJid, {
            text: "❌ Please provide a valid TikTok URL.",
          }, { quoted: msg });
          continue;
        }

        await sock.sendMessage(chatJid, { react: { text: "⏳", key: msg.key } });

        const id = msg.key.id;
        const outputPath = path.join(tempDir, `tt_video_${id}.mp4`);
        console.log(`🎵 Downloading TikTok video from: ${ttUrl}`);

        let videoBuffer = null;
        let filename = `tt_video_${id}.mp4`;

        try {
          // Primary download attempt: Cobalt API
          const cobaltResult = await downloadFromCobalt(ttUrl, false, "1080");
          videoBuffer = cobaltResult.buffer;
          filename = cobaltResult.filename;
          console.log("✅ Successfully downloaded TikTok video using Cobalt API.");
        } catch (cobaltErr) {
          console.warn("⚠️ Cobalt TikTok download failed. Falling back to local yt-dlp...", cobaltErr.message);
          try {
            await runYtDlp([
              "-f", "best[ext=mp4]/best",
              "--recode-video", "mp4",
              "--no-playlist",
              "--max-filesize", "50M",
              "-o", outputPath,
              ttUrl
            ]);

            if (fs.existsSync(outputPath)) {
              videoBuffer = fs.readFileSync(outputPath);
            } else {
              throw new Error("Video file was not created by yt-dlp");
            }
          } catch (dlpErr) {
            console.error("❌ Fallback local yt-dlp TikTok download failed:", dlpErr);
            await sock.sendMessage(chatJid, {
              text: `❌ Failed to download TikTok video. It might be too large (>50MB) or restricted.\n\nError: ${dlpErr.message}`,
            }, { quoted: msg });
            await sock.sendMessage(chatJid, { react: { text: "❌", key: msg.key } });
            continue;
          } finally {
            if (fs.existsSync(outputPath)) {
              fs.unlinkSync(outputPath);
            }
          }
        }

        if (videoBuffer) {
          try {
            const fileSizeInMB = videoBuffer.length / (1024 * 1024);
            if (fileSizeInMB > 16) {
              await sock.sendMessage(chatJid, {
                document: videoBuffer,
                mimetype: "video/mp4",
                fileName: filename,
                caption: "🎵 Here is your TikTok video (sent as document due to size limit)",
              }, { quoted: msg });
            } else {
              await sock.sendMessage(chatJid, {
                video: videoBuffer,
                caption: "🎵 Here is your TikTok video!",
              }, { quoted: msg });
            }
            await sock.sendMessage(chatJid, { react: { text: "✅", key: msg.key } });
          } catch (err) {
            console.error("Error sending TikTok video message:", err);
            await sock.sendMessage(chatJid, { text: "❌ Error sending TikTok video file." }, { quoted: msg });
            await sock.sendMessage(chatJid, { react: { text: "❌", key: msg.key } });
          }
        }
        continue;
      }

      // --- COMMAND: !ig ---
      if (text.toLowerCase().startsWith("!ig")) {
        const parts = text.trim().split(/\s+/);
        if (parts.length < 2) {
          await sock.sendMessage(chatJid, {
            text: "❌ Usage: *!ig <instagram_url>*\nExample: `!ig https://www.instagram.com/reel/ABC123/`",
          }, { quoted: msg });
          continue;
        }

        const igUrl = parts[1];
        const isInstagram =
          igUrl.includes("instagram.com") ||
          igUrl.includes("instagr.am");

        if (!isInstagram) {
          await sock.sendMessage(chatJid, {
            text: "❌ Please provide a valid Instagram URL.",
          }, { quoted: msg });
          continue;
        }

        await sock.sendMessage(chatJid, { react: { text: "⏳", key: msg.key } });

        const id = msg.key.id;
        const outputPath = path.join(tempDir, `ig_video_${id}.mp4`);
        console.log(`📸 Downloading Instagram video from: ${igUrl}`);

        let videoBuffer = null;
        let filename = `ig_video_${id}.mp4`;

        try {
          // Primary download attempt: Dedicated Instagram scrapers (vxinstagram / kkinstagram / embed fallback)
          const result = await downloadInstagramVideo(igUrl);
          videoBuffer = result.buffer;
          filename = result.filename;
          console.log("✅ Successfully downloaded Instagram video using Instagram resolution services.");
        } catch (igErr) {
          console.warn("⚠️ Dedicated Instagram downloader failed. Trying fallback Cobalt / yt-dlp...", igErr.message);
          try {
            const cobaltResult = await downloadFromCobalt(igUrl, false, "1080");
            videoBuffer = cobaltResult.buffer;
            filename = cobaltResult.filename;
          } catch (cobaltErr) {
            try {
              await runYtDlp([
                "-f", "best[ext=mp4]/best",
                "--recode-video", "mp4",
                "--no-playlist",
                "--max-filesize", "50M",
                "-o", outputPath,
                igUrl
              ]);

              if (fs.existsSync(outputPath)) {
                videoBuffer = fs.readFileSync(outputPath);
              } else {
                throw new Error("Video file was not created by yt-dlp");
              }
            } catch (dlpErr) {
              console.error("❌ All Instagram download attempts failed:", dlpErr);
              await sock.sendMessage(chatJid, {
                text: `❌ Failed to download Instagram video. It might be too large (>50MB), private, or restricted.\n\nError: ${igErr.message || dlpErr.message}`,
              }, { quoted: msg });
              await sock.sendMessage(chatJid, { react: { text: "❌", key: msg.key } });
              continue;
            } finally {
              if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
              }
            }
          }
        }

        if (videoBuffer) {
          try {
            const fileSizeInMB = videoBuffer.length / (1024 * 1024);
            if (fileSizeInMB > 16) {
              await sock.sendMessage(chatJid, {
                document: videoBuffer,
                mimetype: "video/mp4",
                fileName: filename,
                caption: "📸 Here is your Instagram video (sent as document due to size limit)",
              }, { quoted: msg });
            } else {
              await sock.sendMessage(chatJid, {
                video: videoBuffer,
                caption: "📸 Here is your Instagram video!",
              }, { quoted: msg });
            }
            await sock.sendMessage(chatJid, { react: { text: "✅", key: msg.key } });
          } catch (err) {
            console.error("Error sending Instagram video message:", err);
            await sock.sendMessage(chatJid, { text: "❌ Error sending Instagram video file." }, { quoted: msg });
            await sock.sendMessage(chatJid, { react: { text: "❌", key: msg.key } });
          }
        }
        continue;
      }

      // --- COMMAND: !ss (sticker creator / renamer) ---
      // Trigger: image sent with "!ss [name]" caption  → create sticker
      //        : text "!ss [name]" replying to a sticker → rename sticker (re-send with new name)
      {
        // Determine the effective text for this message (including image captions)
        const imageMsg = msg.message?.imageMessage;
        const fullText =
          text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          "";

        const ssMatch = fullText.trim().match(/^!ss(\s+(.+))?$/i);
        const isSSCommand = !!ssMatch;

        if (isSSCommand) {
          const stickerName = (ssMatch[2] || "").trim();

          // ── Case 1: Message has an image (with !ss as caption) ──
          if (imageMsg) {
            await sock.sendMessage(chatJid, { react: { text: "⏳", key: msg.key } });
            try {
              const imgBuffer = await downloadMediaMessage(imageMsg, "image");
              const stickerBuffer = await imageToSticker(imgBuffer, stickerName, stickerName);
              await sock.sendMessage(chatJid, {
                sticker: stickerBuffer,
              }, { quoted: msg });
              await sock.sendMessage(chatJid, { react: { text: "✅", key: msg.key } });
              console.log(`🎨 Sticker created${stickerName ? ` with name "${stickerName}"` : ""} for ${chatJid}`);
            } catch (err) {
              console.error("Error creating sticker from image:", err);
              await sock.sendMessage(chatJid, {
                text: "❌ Failed to create sticker. Make sure you sent a valid image.",
              }, { quoted: msg });
              await sock.sendMessage(chatJid, { react: { text: "❌", key: msg.key } });
            }
            continue;
          }

          // ── Case 2: Replying to an existing sticker → rename it ──
          const quotedStickerMsg =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage;
          if (quotedStickerMsg) {
            await sock.sendMessage(chatJid, { react: { text: "⏳", key: msg.key } });
            try {
              const stickerData = await downloadMediaMessage(quotedStickerMsg, "sticker");
              // Re-inject metadata with the new (possibly empty) name
              const renamedSticker = addStickerMetadata(stickerData, stickerName, stickerName);
              await sock.sendMessage(chatJid, {
                sticker: renamedSticker,
              }, { quoted: msg });
              const actionMsg = stickerName
                ? `✅ Sticker renamed to *"${stickerName}"*`
                : `✅ Sticker name cleared`;
              await sock.sendMessage(chatJid, { text: actionMsg }, { quoted: msg });
              await sock.sendMessage(chatJid, { react: { text: "✅", key: msg.key } });
              console.log(`🎨 Sticker renamed to "${stickerName}" for ${chatJid}`);
            } catch (err) {
              console.error("Error renaming sticker:", err);
              await sock.sendMessage(chatJid, {
                text: "❌ Failed to rename sticker.",
              }, { quoted: msg });
              await sock.sendMessage(chatJid, { react: { text: "❌", key: msg.key } });
            }
            continue;
          }

          // ── Case 3: !ss sent alone without image or sticker quote ──
          if (isSSCommand && !imageMsg && !quotedStickerMsg) {
            await sock.sendMessage(chatJid, {
              text: "❌ *How to use !ss:*\n\n• *Create sticker:* Send an image with caption `!ss` (or `!ss <name>` to set a name)\n• *Rename sticker:* Reply to an existing sticker with `!ss <new name>` (or just `!ss` to clear name)",
            }, { quoted: msg });
            continue;
          }
        }
      }

      // --- COMMAND: !yt ---
      if (text.toLowerCase().startsWith("!yt")) {
        const parts = text.trim().split(/\s+/);
        if (parts.length < 2) {
          await sock.sendMessage(chatJid, {
            text: "❌ Usage: *!yt <youtube_url>*\nExample: `!yt https://youtu.be/2i2khp_npdE`",
          }, { quoted: msg });
          continue;
        }

        const ytUrl = parts[1];
        if (!ytUrl.includes("youtube.com") && !ytUrl.includes("youtu.be")) {
          await sock.sendMessage(chatJid, {
            text: "❌ Please provide a valid YouTube URL.",
          }, { quoted: msg });
          continue;
        }

        const promptText = `🎥 *YouTube Downloader*\n\nChoose format for:\n${ytUrl}\n\n1️⃣ Video (MP4)\n2️⃣ Audio (MP3)\n\n*Reply/quote this message* with *1* or *2* to choose.`;
        
        const sent = await sock.sendMessage(chatJid, { text: promptText }, { quoted: msg });
        activeYtRequests.set(sent.key.id, {
          url: ytUrl,
          requesterJid: chatJid,
        });
        continue;
      }
    }
  });
}

// ── Entry point ─────────────────────────────────
console.log("🤖 Netzee-bot starting…");
(async () => {
  try {
    console.log("Using yt-dlp at:", ytDlpPath);
    startQRServer();
    await startBot();
  } catch (err) {
    console.error("Fatal error during startup:", err);
    process.exit(1);
  }
})();
