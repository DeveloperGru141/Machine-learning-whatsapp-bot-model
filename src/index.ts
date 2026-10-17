import dns from 'dns';
try {
  dns.setDefaultResultOrder('ipv4first');
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4', '1.0.0.1']);
} catch {}
import fs from 'fs';
import path from 'path';
import http from 'http';
import { config } from './config/env.js';
import { initDatabase } from './memory/db.js';
import { pluginRegistry } from './plugins/registry.js';
import { imageGenPlugin } from './plugins/image-gen/image-plugin.js';
import { audioDownloaderPlugin } from './plugins/audio-downloader/audio-plugin.js';
import { memoryPlugin } from './plugins/memory-search/memory-plugin.js';
import { datasetExporterPlugin } from './learning/dataset-exporter.js';
import { webSearchPlugin } from './plugins/web-search/search-plugin.js';
import { videoDownloaderPlugin } from './plugins/video-downloader/video-plugin.js';
import { groupAdminPlugin } from './plugins/group-admin/admin-plugin.js';
import { documentReaderPlugin } from './plugins/document-reader/document-plugin.js';
import { schedulerPlugin } from './plugins/scheduler/scheduler-plugin.js';
import { linkSummarizerPlugin } from './plugins/link-summarizer/link-plugin.js';
import { conversationExportPlugin } from './plugins/export/export-plugin.js';
import { contactPlugin } from './plugins/contact/contact-plugin.js';
import { voiceNotePlugin } from './plugins/voice-note/voice-plugin.js';
import { engagementPlugin } from './plugins/engagement/engagement-plugin.js';
import { reloadPluginsTool } from './plugins/hot-reload.js';
import { whatsAppClient } from './core/client.js';
import { healthMonitor } from './core/health-monitor.js';
import { llmClient } from './agent/llm-client.js';
import { antiBanEngine } from './security/anti-ban.js';

// Suppress noisy internal libsignal decrypt/Bad MAC dumps (Baileys handles Signal protocol retries automatically)
const originalConsoleError = console.error;
console.error = (...args: any[]) => {
  const fullText = args.map((a) => (typeof a === 'object' ? (a?.stack || String(a)) : String(a))).join(' ');
  if (
    fullText.includes('Failed to decrypt message with any known session') ||
    fullText.includes('Bad MAC Error') ||
    fullText.includes('No matching sessions found for message') ||
    fullText.includes('Session error:Error: Bad MAC')
  ) {
    return;
  }
  originalConsoleError.apply(console, args);
};

// Container & Server-safe Single-Instance Process Lock
const pidFile = path.resolve('./data/bot.pid');
if (fs.existsSync(pidFile)) {
  try {
    const oldPid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    if (!isNaN(oldPid) && oldPid !== process.pid && oldPid !== process.ppid) {
      // Check if process is still running
      process.kill(oldPid, 0);

      // On Linux/Docker containers, verify /proc/<pid>/cmdline actually belongs to our bot (handles PID 1 / PID reuse)
      let isGenuineDuplicate = true;
      const procCmdline = `/proc/${oldPid}/cmdline`;
      if (fs.existsSync('/proc')) {
        try {
          const cmdline = fs.readFileSync(procCmdline, 'utf8');
          if (!cmdline.includes('index.js') && !cmdline.includes('index.ts')) {
            isGenuineDuplicate = false;
          }
        } catch {
          isGenuineDuplicate = false;
        }
      }

      if (isGenuineDuplicate) {
        console.warn(`⚠️ [SingleInstance] Another instance is already running with PID ${oldPid}. Terminating duplicate process to prevent WhatsApp conflict.`);
        process.exit(0);
      }
    }
  } catch {
    // Process not running, stale PID file
  }
}
try {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.mkdirSync(config.paths.temp, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid), 'utf8');
} catch {}

/**
 * Periodically sweeps stale temporary files (>30 mins old) and prunes in-memory maps
 */
function pruneTempAndMemory() {
  try {
    antiBanEngine.pruneMemory();
    if (fs.existsSync(config.paths.temp)) {
      const cutoff = Date.now() - 30 * 60 * 1000;
      for (const file of fs.readdirSync(config.paths.temp)) {
        const fullPath = path.join(config.paths.temp, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            fs.unlinkSync(fullPath);
          }
        } catch {}
      }
    }
  } catch {}
}

let healthServer: http.Server | null = null;

function startHealthServer() {
  const port = Number(process.env.PORT) || 3000;
  healthServer = http.createServer(async (req, res) => {
    if (req.url && (req.url.startsWith('/qr') || req.url.startsWith('/pair'))) {
      const qr = whatsAppClient.getLatestQr();
      const registered = whatsAppClient.isRegistered();

      if (req.url.includes('json=1')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: registered ? 'already_connected' : 'awaiting_qr_scan',
            pairingPhoneNumber: `+${config.bot.pairingPhoneNumber || '2349014896714'}`,
            qr,
          })
        );
        return;
      }

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${config.bot.name} • WhatsApp QR Pairing</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0b141a; color: #e9edef; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; text-align: center; }
    .card { background: #111b21; border: 1px solid #222e35; border-radius: 16px; padding: 32px; max-width: 420px; width: 100%; box-shadow: 0 12px 32px rgba(0,0,0,0.45); }
    h1 { font-size: 20px; margin: 0 0 8px; color: #00a884; }
    p { font-size: 14px; color: #8696a0; margin: 6px 0 20px; line-height: 1.5; }
    .qr-box { background: #ffffff; padding: 16px; border-radius: 12px; display: inline-block; min-width: 280px; min-height: 280px; }
    .qr-box img { width: 280px; height: 280px; display: block; }
    .badge { display: inline-block; padding: 6px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; margin-top: 18px; background: #1f2c34; color: #00a884; }
    .steps { text-align: left; font-size: 13px; color: #d1d7db; margin-top: 20px; background: #1f2c34; padding: 14px 18px; border-radius: 10px; line-height: 1.7; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${config.bot.name}</h1>
    <p>Scan with WhatsApp (+${config.bot.pairingPhoneNumber || '2349014896714'}) to link instantly</p>
    <div id="qr-container" class="qr-box">
      ${
        registered
          ? '<div style="color:#00a884;padding:90px 20px;font-weight:700;font-size:18px;">✅ WhatsApp Connected & Active!</div>'
          : qr
          ? `<img id="qr-img" src="https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=10&data=${encodeURIComponent(qr)}" alt="WhatsApp QR Code" />`
          : '<div style="color:#111b21;padding:110px 20px;font-weight:600;">Generating fresh QR code...</div>'
      }
    </div>
    <div><span id="status-badge" class="badge">${registered ? '🟢 Connected' : '⏳ Waiting for QR Scan (Auto-refreshes live)'}</span></div>
    <div class="steps">
      1. Open <b>WhatsApp</b> on your phone (<b>09014896714</b>)<br/>
      2. Tap <b>Settings (or ⋮) &rarr; Linked Devices</b><br/>
      3. Tap <b>Link a Device</b> and point your camera at this QR code
    </div>
  </div>
  <script>
    let lastQr = ${JSON.stringify(qr || '')};
    setInterval(async () => {
      try {
        const res = await fetch('/health');
        const data = await res.json();
        const container = document.getElementById('qr-container');
        const badge = document.getElementById('status-badge');
        if (data.whatsappRegistered) {
          container.innerHTML = '<div style="color:#00a884;padding:90px 20px;font-weight:700;font-size:18px;">✅ WhatsApp Connected & Active!</div>';
          badge.textContent = '🟢 Connected & Registered';
          return;
        }
        if (data.qr && data.qr !== lastQr) {
          lastQr = data.qr;
          container.innerHTML = '<img id="qr-img" src="https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=10&data=' + encodeURIComponent(data.qr) + '" alt="WhatsApp QR Code" />';
        }
      } catch (e) {}
    }, 2500);
  </script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.url === '/' || req.url === '/health' || req.url === '/status') {
      const report = healthMonitor.getHealthReport();
      const payload = JSON.stringify({
        status: 'ok',
        bot: config.bot.name,
        creator: config.bot.creator,
        pairingPhoneNumber: `+${config.bot.pairingPhoneNumber || '2349014896714'}`,
        whatsappRegistered: whatsAppClient.isRegistered(),
        whatsappConnected: whatsAppClient.isSocketOpen() || report.isConnected,
        qr: whatsAppClient.getLatestQr(),
        pairingCode: whatsAppClient.getLatestPairingCode(),
        activeModel: llmClient.getModel(),
        uptimeSeconds: report.uptime,
        messagesHandled: report.messagesHandled,
        errors: report.errors,
        memoryMB: Math.round(report.memoryUsage.rss / 1024 / 1024),
        timestamp: new Date().toISOString(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  healthServer.on('error', (err: any) => {
    if (err?.code === 'EADDRINUSE' && !process.env.PORT) {
      console.warn(`[HealthServer] Port ${port} already in use locally; continuing without HTTP binding.`);
    } else {
      console.warn(`[HealthServer] HTTP server warning:`, err.message);
    }
  });

  healthServer.listen(port, '0.0.0.0', () => {
    console.log(`🌐 [HealthServer] Production health endpoint listening on http://0.0.0.0:${port}/health`);
  });
  healthServer.unref();

  // Render Free Tier anti-sleep self-pinger (every 10 minutes)
  if (process.env.RENDER_EXTERNAL_URL) {
    const keepAliveUrl = `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/health`;
    const renderPingTimer = setInterval(() => {
      fetch(keepAliveUrl, { signal: AbortSignal.timeout(8_000) }).catch(() => {});
    }, 10 * 60 * 1000);
    renderPingTimer.unref();
  }
}

const cleanupLock = () => {
  try {
    if (fs.existsSync(pidFile)) {
      const currentLockedPid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
      if (currentLockedPid === process.pid) {
        fs.unlinkSync(pidFile);
      }
    }
  } catch {}
};

const gracefulShutdown = (signal: string) => {
  console.log(`\n🛑 [${signal}] Shutting down ${config.bot.name} gracefully...`);
  cleanupLock();
  try {
    healthMonitor.stopMonitoring();
    if (healthServer) healthServer.close();
    const sock = whatsAppClient.getSocket();
    if (sock && (sock as any).ws) {
      (sock as any).ws.close();
    }
  } catch {}
  process.exit(0);
};

process.on('exit', cleanupLock);
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

async function bootstrap() {
  console.log('==============================================');
  console.log('🤖 Starting WhatsApp Agentic Bot Engine...');
  console.log('==============================================');

  // 1. Initialize SQLite Database & Tables (auto-seeds training exemplars if empty)
  initDatabase();
  console.log('📦 Local SQLite Database initialized.');

  // 2. Start HTTP Health Server & Periodic Temp/Memory Sweeper
  startHealthServer();
  pruneTempAndMemory();
  const cleanupTimer = setInterval(pruneTempAndMemory, 30 * 60 * 1000);
  cleanupTimer.unref();

  // 3. Register Active Plugins
  await pluginRegistry.registerPlugin(imageGenPlugin);
  await pluginRegistry.registerPlugin(audioDownloaderPlugin);
  await pluginRegistry.registerPlugin(videoDownloaderPlugin);
  await pluginRegistry.registerPlugin(groupAdminPlugin);
  await pluginRegistry.registerPlugin(documentReaderPlugin);
  await pluginRegistry.registerPlugin(schedulerPlugin);
  await pluginRegistry.registerPlugin(linkSummarizerPlugin);
  await pluginRegistry.registerPlugin(conversationExportPlugin);
  await pluginRegistry.registerPlugin(contactPlugin);
  await pluginRegistry.registerPlugin({
    name: 'SystemAdmin',
    version: '1.0.0',
    description: 'System administration and plugin hot-reloading',
    tools: [reloadPluginsTool],
  });
  await pluginRegistry.registerPlugin(memoryPlugin);
  await pluginRegistry.registerPlugin(datasetExporterPlugin);
  await pluginRegistry.registerPlugin(webSearchPlugin);
  await pluginRegistry.registerPlugin(voiceNotePlugin);
  await pluginRegistry.registerPlugin(engagementPlugin);

  console.log(`🔌 Registered ${pluginRegistry.getAllTools().length} tools across plugins.`);

  // 4. Connect to WhatsApp via Baileys
  await whatsAppClient.start();
}

// Graceful error boundaries
process.on('uncaughtException', (err) => {
  console.error('🚨 [UncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('🚨 [UnhandledRejection]', reason);
});

bootstrap().catch((err) => {
  console.error('❌ Failed to start bot:', err);
  process.exit(1);
});

