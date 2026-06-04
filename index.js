const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const http = require("http");

// ──────────────────────────────────────────────
// QR Web Server
// ──────────────────────────────────────────────

let currentQR = null; // holds the latest QR text
let botConnected = false;

function buildHTML() {
  if (botConnected) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WA-DP-Bot</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: #0a0a0a;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #fff;
    }
    .card {
      text-align: center;
      background: #111;
      border-radius: 16px;
      padding: 48px;
      border: 1px solid #25D366;
      box-shadow: 0 0 40px rgba(37, 211, 102, 0.15);
    }
    .check { font-size: 64px; margin-bottom: 16px; }
    h1 { color: #25D366; font-size: 24px; }
    p { color: #888; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✅</div>
    <h1>Bot Connected!</h1>
    <p>WA-DP-Bot is running and linked to WhatsApp.</p>
  </div>
</body>
</html>`;
  }

  if (!currentQR) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WA-DP-Bot — Waiting</title>
  <meta http-equiv="refresh" content="3">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: #0a0a0a;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #fff;
    }
    .card { text-align: center; }
    .spinner {
      width: 48px; height: 48px;
      border: 4px solid #333; border-top: 4px solid #25D366;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    p { color: #888; }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <p>Generating QR code… Page will auto-refresh.</p>
  </div>
</body>
</html>`;
  }

  // Page with QR — auto-refreshes every 30s to pick up new QR codes
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WA-DP-Bot — Scan QR</title>
  <meta http-equiv="refresh" content="30">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: #0a0a0a;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #fff;
    }
    .card {
      text-align: center;
      background: #111;
      border-radius: 16px;
      padding: 32px;
      border: 1px solid #222;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    }
    h1 { font-size: 20px; margin-bottom: 4px; color: #25D366; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .qr-container {
      background: #fff;
      border-radius: 12px;
      padding: 16px;
      display: inline-block;
      margin-bottom: 20px;
    }
    .qr-container img { display: block; width: 280px; height: 280px; }
    .instructions {
      color: #aaa; font-size: 13px; line-height: 1.6;
    }
    .instructions strong { color: #fff; }
    .refresh-note { color: #555; font-size: 11px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🤖 WA-DP-Bot</h1>
    <p class="subtitle">Link your WhatsApp to get started</p>
    <div class="qr-container">
      <img src="/qr.png" alt="QR Code" />
    </div>
    <p class="instructions">
      <strong>1.</strong> Open WhatsApp on your phone<br>
      <strong>2.</strong> Go to <strong>Linked Devices</strong><br>
      <strong>3.</strong> Tap <strong>Link a Device</strong><br>
      <strong>4.</strong> Point your camera at this QR code
    </p>
    <p class="refresh-note">Page auto-refreshes every 30s for new QR codes</p>
  </div>
</body>
</html>`;
}

/**
 * Start a tiny HTTP server to serve the QR code as an image.
 * Railway provides PORT env var.
 */
function startQRServer() {
  const PORT = process.env.PORT || 3000;

  const server = http.createServer(async (req, res) => {
    if (req.url === "/qr.png" && currentQR) {
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

    // Serve the HTML page
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

/**
 * Normalise a user-supplied phone number into a WhatsApp JID.
 * Strips spaces, dashes, plus signs, and leading zeros after
 * the country code.
 */
function phoneToJid(raw) {
  const cleaned = raw.replace(/[\s\-\+\(\)]/g, "");
  return `${cleaned}@s.whatsapp.net`;
}

// ──────────────────────────────────────────────
// Bot
// ──────────────────────────────────────────────

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  const logger = pino({ level: "silent" }); // keep Railway logs clean

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false, // we serve QR via web instead
    browser: ["WA-DP-Bot", "Chrome", "1.0.0"],
    // Increase timeouts for Railway cold starts
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
  });

  // ── Auth / connection events ──────────────────

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      botConnected = false;
      console.log("📱 New QR code generated — open your Railway URL to scan it");
    }

    if (connection === "close") {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        console.log("❌ Session logged out. Delete auth_info/ and restart.");
        process.exit(1);
      }

      // Auto-reconnect on transient failures
      console.log(
        `⚠️  Connection closed (code ${statusCode}). Reconnecting…`
      );
      botConnected = false;
      setTimeout(startBot, 3000);
    }

    if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
      currentQR = null;
      botConnected = true;
    }
  });

  // ── Message handler ───────────────────────────

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Skip status broadcasts, own messages, protocol messages
      if (msg.key.remoteJid === "status@broadcast") continue;
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (!text.toLowerCase().startsWith("!dp")) continue;

      const parts = text.trim().split(/\s+/);
      if (parts.length < 2) {
        await sock.sendMessage(msg.key.remoteJid, {
          text: "❌ Usage: *!dp <phone_number>*\nExample: `!dp 94722666467`",
        }, { quoted: msg });
        continue;
      }

      const targetPhone = parts[1];
      const targetJid = phoneToJid(targetPhone);
      const chatJid = msg.key.remoteJid;

      console.log(
        `📸 !dp request from ${chatJid} for ${targetPhone}`
      );

      try {
        // React to acknowledge
        await sock.sendMessage(chatJid, {
          react: { text: "⏳", key: msg.key },
        });

        // Fetch the profile picture URL (full-res)
        let ppUrl;
        try {
          ppUrl = await sock.profilePictureUrl(targetJid, "image");
        } catch (err) {
          // No profile picture set or privacy restrictions
          await sock.sendMessage(chatJid, {
            text: `⚠️ Could not fetch DP for *${targetPhone}*.\nThe user may have no DP set or their privacy settings block it.`,
          }, { quoted: msg });

          await sock.sendMessage(chatJid, {
            react: { text: "❌", key: msg.key },
          });
          continue;
        }

        // Download the image
        const response = await fetch(ppUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());

        // Send the image back
        await sock.sendMessage(chatJid, {
          image: buffer,
          caption: `📸 Display picture of *${targetPhone}*`,
        }, { quoted: msg });

        await sock.sendMessage(chatJid, {
          react: { text: "✅", key: msg.key },
        });

        console.log(`✅ Sent DP of ${targetPhone} to ${chatJid}`);
      } catch (err) {
        console.error(`Error handling !dp for ${targetPhone}:`, err);
        await sock.sendMessage(chatJid, {
          text: `❌ Something went wrong fetching the DP. Please try again.`,
        }, { quoted: msg });

        await sock.sendMessage(chatJid, {
          react: { text: "❌", key: msg.key },
        });
      }
    }
  });
}

// ── Entry point ─────────────────────────────────
console.log("🤖 WA-DP-Bot starting…");
startQRServer();
startBot().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
