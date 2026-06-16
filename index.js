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

// Ensure temp directory exists
const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Watchlist storage path
const WATCHLIST_FILE = path.join(__dirname, "watchlist.json");

// Callblocking storage path
const CALLBLOCKING_FILE = path.join(__dirname, "callblocking.json");

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
  <title>Netzee-bot</title>
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
    <p>Netzee-bot is running and linked to WhatsApp.</p>
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
  <title>Netzee-bot — Waiting</title>
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Netzee-bot — Scan QR</title>
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
    <h1>🤖 Netzee-bot</h1>
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

const ytDlpPath = process.platform === "win32" 
  ? path.join(__dirname, ".venv", "Scripts", "yt-dlp.exe") 
  : path.join(__dirname, ".venv", "bin", "yt-dlp");

// Helper to spawn yt-dlp command safely without shell escaping vulnerability
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpPath, args);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
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
      try {
        currentDpUrl = await sock.profilePictureUrl(targetJid, "image");
      } catch (err) {
        currentDpUrl = null; // No profile picture set or privacy restricted
      }

      if (currentDpUrl !== target.lastDpUrl) {
        console.log(`📸 Profile picture changed for ${target.phone}`);
        target.lastDpUrl = currentDpUrl;
        changed = true;

        if (currentDpUrl) {
          const response = await fetch(currentDpUrl);
          if (response.ok) {
            const buffer = Buffer.from(await response.arrayBuffer());
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
          }
        } else {
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
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
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
        console.log("❌ Session logged out. Delete auth_info/ and restart.");
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

      // Start periodic check every 10 minutes
      if (!ppCheckInterval) {
        ppCheckInterval = setInterval(() => {
          checkProfilePictures(sock, loadWatchlist());
        }, 10 * 60 * 1000);
        // Run once immediately on startup
        checkProfilePictures(sock, loadWatchlist());
      }
    }
  });

  // ── Message handler ───────────────────────────

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
            text: "❌ Usage: *!dp <phone_number>*\nExample: `!dp 94722666467`",
          }, { quoted: msg });
          continue;
        }

        const targetPhone = parts[1];
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

      // --- COMMAND: !watchlist ---
      if (text.toLowerCase().startsWith("!watchlist")) {
        const parts = text.trim().split(/\s+/);
        const subCommand = parts[1]?.toLowerCase();

        const senderJid = msg.key.fromMe ? jidNormalizedUser(sock.user.id) : jidNormalizedUser(msg.key.remoteJid);

        if (subCommand === "add") {
          const targetPhone = parts[2];
          if (!targetPhone) {
            await sock.sendMessage(chatJid, {
              text: "❌ Usage: *!watchlist add <phone_number>*",
            }, { quoted: msg });
            continue;
          }

          const targetJid = phoneToJid(targetPhone);
          
          if (!watchlist[targetJid]) {
            watchlist[targetJid] = {
              phone: targetPhone,
              lastDpUrl: null,
              requesters: [],
            };
          }

          if (!watchlist[targetJid].requesters.includes(senderJid)) {
            watchlist[targetJid].requesters.push(senderJid);
          }

          // Initial DP fetch
          try {
            watchlist[targetJid].lastDpUrl = await sock.profilePictureUrl(targetJid, "image");
          } catch (e) {
            watchlist[targetJid].lastDpUrl = null;
          }

          saveWatchlist(watchlist);

          await sock.sendMessage(chatJid, {
            text: `✅ Added *${targetPhone}* to your watchlist! You will be notified of display picture and status updates.`,
          }, { quoted: msg });
          continue;
        }

        if (subCommand === "remove" || subCommand === "delete") {
          const targetPhone = parts[2];
          if (!targetPhone) {
            await sock.sendMessage(chatJid, {
              text: "❌ Usage: *!watchlist remove <phone_number>*",
            }, { quoted: msg });
            continue;
          }

          const targetJid = phoneToJid(targetPhone);

          if (watchlist[targetJid]) {
            watchlist[targetJid].requesters = watchlist[targetJid].requesters.filter(
              (r) => r !== senderJid
            );

            if (watchlist[targetJid].requesters.length === 0) {
              delete watchlist[targetJid];
            }
            saveWatchlist(watchlist);

            await sock.sendMessage(chatJid, {
              text: `✅ Removed *${targetPhone}* from your watchlist.`,
            }, { quoted: msg });
          } else {
            await sock.sendMessage(chatJid, {
              text: `⚠️ *${targetPhone}* is not in your watchlist.`,
            }, { quoted: msg });
          }
          continue;
        }

        if (subCommand === "list") {
          const watchedList = [];
          for (const key of Object.keys(watchlist)) {
            if (watchlist[key].requesters.includes(senderJid)) {
              watchedList.push(`• ${watchlist[key].phone}`);
            }
          }

          if (watchedList.length === 0) {
            await sock.sendMessage(chatJid, {
              text: "📂 Your watchlist is currently empty.",
            }, { quoted: msg });
          } else {
            await sock.sendMessage(chatJid, {
              text: `📂 *Your Watchlist:*\n\n${watchedList.join("\n")}`,
            }, { quoted: msg });
          }
          continue;
        }

        // Show generic watchlist usage
        await sock.sendMessage(chatJid, {
          text: `ℹ️ *Watchlist Commands:*\n\n• \`!watchlist add <phone>\`\n• \`!watchlist remove <phone>\`\n• \`!watchlist list\``,
        }, { quoted: msg });
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
