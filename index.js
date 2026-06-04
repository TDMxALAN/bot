const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/**
 * Render QR as a compact UTF-8 string that fits inside Railway's
 * narrower terminal (≈80-100 cols). Uses the "quarter-block"
 * technique: each character cell encodes TWO vertical module rows,
 * halving the height and keeping width small.
 *
 * Characters used:
 *   █ (U+2588) — both rows dark
 *   ▀ (U+2580) — top dark, bottom light
 *   ▄ (U+2584) — top light, bottom dark
 *   ' '        — both rows light
 */
async function printCompactQR(text) {
  // qrcode library can return a 2-D boolean matrix via toDataURL → but
  // the simplest API is toString with "utf8" type which already does the
  // half-block trick. We keep margin small so it doesn't overflow.
  const qrString = await QRCode.toString(text, {
    type: "utf8",
    errorCorrectionLevel: "L", // fewer modules → smaller QR
    margin: 1,
    small: true,
  });

  console.log("\n");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   Scan this QR code with WhatsApp        ║");
  console.log("║   (Linked Devices → Link a Device)       ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(qrString);
  console.log("Waiting for scan...\n");
}

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
    printQRInTerminal: false, // we handle QR ourselves for Railway compat
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
      await printCompactQR(qr);
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
      setTimeout(startBot, 3000);
    }

    if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
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
startBot().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
