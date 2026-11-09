process.env.TZ = process.env.BOT_TIMEZONE || 'Africa/Lagos';
import dns from 'dns';
import { createRequire } from 'module';
try {
  dns.setDefaultResultOrder('ipv4first');
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4', '1.0.0.1']);
} catch {}
import fs from 'fs';
import path from 'path';
import http from 'http';
import { config } from './config/env.js';
import { db, runDatabasePostInitMaintenance } from './memory/db.js';
import { pluginRegistry } from './plugins/registry.js';
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
import { imageGenPlugin } from './plugins/image-gen/image-plugin.js';
import { engagementPlugin } from './plugins/engagement/engagement-plugin.js';
import { stickerPlugin } from './plugins/stickers/sticker-plugin.js';
import { viewOncePlugin } from './plugins/view-once/view-once-plugin.js';
import { reloadPluginsTool } from './plugins/hot-reload.js';
import { whatsAppClient } from './core/client.js';
import { healthMonitor } from './core/health-monitor.js';
import { llmClient } from './agent/llm-client.js';
import { antiBanEngine } from './security/anti-ban.js';
import { httpSecurityManager } from './security/http-security.js';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode') as {
  new (typeNumber: number, errorCorrectionLevel: number): {
    addData(value: string): void;
    make(): void;
    getModuleCount(): number;
    modules: boolean[][];
  };
};
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel') as { M: number };

/**
 * Creates the pairing QR as SVG in-process. The QR payload stays on this
 * service and is never sent to an external image-rendering service.
 */
function renderPairingQrSvg(payload: string): string {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(payload);
  qr.make();

  const quietZone = 4;
  const moduleCount = qr.getModuleCount();
  const size = moduleCount + quietZone * 2;
  let path = '';
  for (let row = 0; row < moduleCount; row++) {
    for (let column = 0; column < moduleCount; column++) {
      if (qr.modules[row][column]) {
        path += `M${column + quietZone} ${row + quietZone}h1v1h-1z`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="WhatsApp pairing QR code" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${path}"/></svg>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

function isSameOriginRequest(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const parsedOrigin = new URL(origin);
    return (parsedOrigin.protocol === 'https:' || parsedOrigin.protocol === 'http:') &&
      parsedOrigin.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function isSecureTransport(req: http.IncomingMessage): boolean {
  if ((req.socket as any).encrypted === true) return true;
  const remoteAddress = req.socket.remoteAddress || '';
  if (remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress.startsWith('::ffff:127.')) return true;
  const forwardedProtocol = req.headers['x-forwarded-proto'];
  return Boolean(
    process.env.RENDER_EXTERNAL_URL &&
    typeof forwardedProtocol === 'string' &&
    forwardedProtocol.split(',')[0].trim().toLowerCase() === 'https'
  );
}

function rejectInsecureAdminRequest(res: http.ServerResponse): void {
  res.writeHead(426, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: 'HTTPS is required for pairing and admin access.' }));
}


// In-memory capture of live server logs (last 500 lines) for Render /logs endpoint
export const liveConsoleLogs: string[] = [];
function recordLog(level: string, args: any[]) {
  const ts = new Date().toISOString().substring(11, 19);
  const text = args.map((a) => (typeof a === 'object' ? (a?.stack || JSON.stringify(a)) : String(a))).join(' ');
  liveConsoleLogs.push(`[${ts}] [${level}] ${text}`);
  if (liveConsoleLogs.length > 500) liveConsoleLogs.shift();
}

const originalConsoleLog = console.log;
console.log = (...args: any[]) => {
  recordLog('INFO', args);
  originalConsoleLog.apply(console, args);
};

function redactLibsignalSessionDump(args: any[]): any[] {
  const label = typeof args[0] === 'string' ? args[0] : '';
  if (/^(Opening session:|Closing session:|Removing old closed session:|Session already closed$)/.test(label)) {
    return [label, '[session data redacted]'];
  }
  return args;
}

const originalConsoleInfo = console.info;
console.info = (...args: any[]) => {
  const safeArgs = redactLibsignalSessionDump(args);
  recordLog('INFO', safeArgs);
  originalConsoleInfo.apply(console, safeArgs);
};

const originalConsoleWarn = console.warn;
console.warn = (...args: any[]) => {
  const safeArgs = redactLibsignalSessionDump(args);
  recordLog('WARN', safeArgs);
  originalConsoleWarn.apply(console, safeArgs);
};

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
  recordLog('ERROR', args);
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
    const viewOnceDir = path.resolve('./data/view_once');
    if (fs.existsSync(viewOnceDir)) {
      const maxArchiveAgeMs = 30 * 24 * 60 * 60 * 1000;
      const maxArchiveFiles = 100;
      const maxArchiveBytes = 250 * 1024 * 1024;
      const now = Date.now();
      const files: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
      let totalBytes = 0;
      for (const name of fs.readdirSync(viewOnceDir)) {
        const filePath = path.join(viewOnceDir, name);
        try {
          const stat = fs.lstatSync(filePath);
          if (!stat.isFile()) continue;
          files.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
          totalBytes += stat.size;
        } catch {}
      }
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      while (files.length > 0 && (
        files.length > maxArchiveFiles ||
        totalBytes > maxArchiveBytes ||
        now - files[0].mtimeMs > maxArchiveAgeMs
      )) {
        const oldest = files.shift()!;
        try {
          fs.unlinkSync(oldest.filePath);
          totalBytes -= oldest.size;
        } catch {}
      }
    }
  } catch {}
}

let healthServer: http.Server | null = null;

function startHealthServer() {
  const port = Number(process.env.PORT) || 3000;
  healthServer = http.createServer(async (req, res) => {
    httpSecurityManager.applySecurityHeaders(res);

    // 1. Instant Public Uptime & Health Check (NEVER rate-limited, NEVER blocked)
    // Ensures Render health checks and uptime pingers always get immediate 200 OK
    if (req.url === '/' || req.url?.startsWith('/health') || req.url?.startsWith('/status') || req.url === '/favicon.ico') {
      if (req.url === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      const report = healthMonitor.getHealthReport();
      const auth = httpSecurityManager.verifyAdminAuth(req, false);
      if (auth.isAuthenticated && !isSecureTransport(req)) {
        rejectInsecureAdminRequest(res);
        return;
      }

      // Public health probe (for Render uptime checks and load balancer probes)
      if (!auth.isAuthenticated) {
        const whatsappRegistered = whatsAppClient.isRegistered();
        const publicPayload = JSON.stringify({
          status: 'ok',
          bot: config.bot.name,
          whatsappConnected: whatsappRegistered && whatsAppClient.isSocketOpen() && report.isConnected,
          whatsappRegistered,
          uptimeSeconds: report.uptime,
          timestamp: new Date().toISOString(),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(publicPayload);
        return;
      }

      // Full diagnostic probe for authenticated admin
      const whatsappRegistered = whatsAppClient.isRegistered();
      const payload = JSON.stringify({
        status: 'ok',
        bot: config.bot.name,
        creator: config.bot.creator,
        whatsappRegistered,
        whatsappConnected: whatsappRegistered && whatsAppClient.isSocketOpen() && report.isConnected,
        qr: whatsAppClient.getLatestQr(),
        pairingCode: whatsAppClient.getLatestPairingCode(),
        activeModel: llmClient.getModel(),
        uptimeSeconds: report.uptime,
        messagesHandled: report.messagesHandled,
        errors: report.errors,
        memoryMB: Math.round(report.memoryUsage.rss / 1024 / 1024),
        timestamp: new Date().toISOString(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(payload);
      return;
    }

    // 2. WhatsApp pairing endpoints contain one-time account-linking credentials.
    // Require admin authentication, throttle polls and code refreshes separately,
    // and never let a cross-site GET mutate pairing state.
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url || '/', 'http://localhost');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Invalid request URL.' }));
      return;
    }
    const pathname = requestUrl.pathname;
    const isPairingRoute = pathname === '/qr' || pathname === '/pair' || pathname === '/pair/qr.svg';
    if (isPairingRoute) {
      const isRefresh = requestUrl.searchParams.has('refresh') || requestUrl.searchParams.has('new');
      if (!httpSecurityManager.checkRateLimit(req, 200, 'global') ||
          !httpSecurityManager.checkRateLimit(req, 120, 'pairing') ||
          (isRefresh && !httpSecurityManager.checkRateLimit(req, 3, 'pair-refresh'))) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Too Many Requests: Pairing rate limit exceeded.' }));
        return;
      }

      if (!isSecureTransport(req)) {
        rejectInsecureAdminRequest(res);
        return;
      }

      const auth = httpSecurityManager.verifyAdminAuth(req);
      if (!auth.isAuthenticated) {
        res.setHeader('Cache-Control', 'no-store');
        if (auth.reason === 'No strong admin key configured on server') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Pairing and admin endpoints require an ADMIN_API_KEY with at least 32 characters.' }));
          return;
        }
        res.setHeader('WWW-Authenticate', 'Basic realm="WhatsApp pairing", charset="UTF-8"');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Admin authentication required.' }));
        return;
      }

      if (isRefresh && (req.method !== 'POST' || !isSameOriginRequest(req))) {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Pairing refresh must be a same-origin POST request.' }));
        return;
      }

      if (!isRefresh && req.method !== 'GET') {
        res.writeHead(405, { 'Allow': 'GET, POST', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      const registered = whatsAppClient.isRegistered();
      const pairingCodeEnabled = true; // Always allow pairing via phone input on the page

      // Keep the phone number out of request URLs and access logs.
      if (isRefresh) {
        const rawPhone = req.headers['x-pairing-phone'];
        const phoneOverride = typeof rawPhone === 'string' ? rawPhone.trim() : undefined;
        if (phoneOverride && !/^[1-9]\d{7,14}$/.test(phoneOverride)) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'Phone number must be 8 to 15 digits including country code.' }));
          return;
        }
        const freshCode = await whatsAppClient.requestFreshPairingCode(false, phoneOverride);
        const freshQr = whatsAppClient.getLatestQr();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(
          JSON.stringify({
            status: whatsAppClient.isRegistered() ? 'already_connected' : 'pairing_code_refreshed',
            whatsappRegistered: whatsAppClient.isRegistered(),
            pairingCodeEnabled,
            pairingCode: freshCode,
            qr: freshQr,
          })
        );
        return;
      }

      let qr = whatsAppClient.getLatestQr();
      let pairingCode = whatsAppClient.getLatestPairingCode();

      // Render the QR locally so the one-time WhatsApp linking credential is
      // never sent to a third-party QR image service.
      if (pathname === '/pair/qr.svg') {
        if (!qr || registered) {
          res.writeHead(404, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(renderPairingQrSvg(qr));
        return;
      }

      if (requestUrl.searchParams.has('json')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(
          JSON.stringify({
            status: registered ? 'already_connected' : 'awaiting_qr_scan',
            whatsappRegistered: registered,
            pairingCodeEnabled,
            pairingCode,
            pairingCodeExpired: !registered && !pairingCode,
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
  <title>${escapeHtml(config.bot.name)} • WhatsApp Pairing & QR</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0b141a; color: #e9edef; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; text-align: center; }
    .card { background: #111b21; border: 1px solid #222e35; border-radius: 16px; padding: 32px; max-width: 440px; width: 100%; box-shadow: 0 12px 32px rgba(0,0,0,0.45); }
    h1 { font-size: 20px; margin: 0 0 8px; color: #00a884; }
    p { font-size: 14px; color: #8696a0; margin: 6px 0 18px; line-height: 1.5; }
    .qr-box { background: #ffffff; padding: 16px; border-radius: 12px; display: inline-block; min-width: 280px; min-height: 280px; }
    .qr-box img { width: 280px; height: 280px; display: block; }
    .code-box { margin-top: 16px; padding: 12px 18px; background: #1f2c34; border: 1px solid #00a884; border-radius: 10px; font-size: 22px; font-weight: 800; letter-spacing: 3px; color: #00a884; display: flex; align-items: center; justify-content: center; gap: 10px; }
    .btn { padding: 8px 14px; background: #202c33; color: #00a884; border: 1px solid #00a884; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .btn:hover { background: #00a884; color: #111b21; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .badge { display: inline-block; padding: 6px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; margin-top: 18px; background: #1f2c34; color: #00a884; }
    .steps { text-align: left; font-size: 13px; color: #d1d7db; margin-top: 20px; background: #1f2c34; padding: 14px 18px; border-radius: 10px; line-height: 1.7; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(config.bot.name)}</h1>
    <p>${pairingCodeEnabled ? 'Link WhatsApp by scanning a QR code or using a pairing code' : 'Link WhatsApp by scanning the QR code'}</p>
    <div style="margin-bottom:14px;${pairingCode ? 'display:none;' : ''}">
      <label style="font-size:13px;color:#8696a0;">Your WhatsApp number with country code, digits only (e.g. 2348012345678):</label>
      <input id="phone-input" type="text" value="" placeholder="e.g. 2348012345678" autocomplete="tel" inputmode="tel" style="width:100%;box-sizing:border-box;margin-top:6px;padding:10px 14px;background:#1f2c34;border:1px solid #333;border-radius:8px;color:#e9edef;font-size:16px;letter-spacing:1px;" />
    </div>
    <div id="qr-container" class="qr-box">
      ${
        registered
          ? '<div style="color:#00a884;padding:90px 20px;font-weight:700;font-size:18px;">✅ WhatsApp Connected & Active!</div>'
          : qr
          ? '<img id="qr-img" src="/pair/qr.svg" alt="WhatsApp QR Code" />'
          : '<div style="color:#111b21;padding:110px 20px;font-weight:600;">Generating fresh QR code...</div>'
      }
    </div>
    <div id="code-container" class="code-box" style="${registered || !pairingCodeEnabled ? 'display:none;' : ''}">
      <span>CODE: <b id="pair-code-text">${escapeHtml(pairingCode || 'Enter number first')}</b></span>
      <button id="copy-btn" class="btn" onclick="copyPairCode()">📋 Copy</button>
    </div>
    <div id="action-bar" style="margin-top:12px;${registered || !pairingCodeEnabled || pairingCode ? 'display:none;' : ''}">
      <button id="refresh-btn" class="btn" onclick="requestNewCode()">🔄 Request ADEM1234 for this number</button>
    </div>
    <div><span id="status-badge" class="badge">${registered ? '🟢 Connected & Active' : pairingCode ? '⏳ ADEM1234 is ready for the configured WhatsApp number' : pairingCodeEnabled ? '⏳ Enter your number, then request a code for that number' : '⏳ Scan the QR code to link WhatsApp'}</span></div>
    <div class="steps">
      ${pairingCode ? '1. Use the WhatsApp number configured for this bot.' : '1. Enter the WhatsApp number you are pairing, including country code (digits only, no +)'}<br/>
      ${pairingCode ? '2. Enter the fixed code below on that phone.' : '2. Click <b>"Request ADEM1234 for this number"</b> once'}<br/>
      3. Open <b>WhatsApp</b> on that phone<br/>
      4. Tap <b>Settings (or ⋮) &rarr; Linked Devices &rarr; Link a Device</b><br/>
      5. Scan the QR code above, or tap <b>"Link with phone number instead"</b> and enter <b>ADEM1234</b> on that same phone. The QR is short-lived; the page keeps the first QR visible while reconnecting.
    </div>
  </div>
  <script>
    let lastQr = ${JSON.stringify(qr || '').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')};
  let pairingCodeRequested = ${JSON.stringify(Boolean(pairingCode))};
    let pairingQrDisplayed = Boolean(lastQr);

    function copyPairCode() {
      const code = document.getElementById('pair-code-text').textContent.trim();
      navigator.clipboard.writeText(code).then(() => {
        const btn = document.getElementById('copy-btn');
        btn.textContent = '✅ Copied!';
        setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
      });
    }

    async function requestNewCode() {
      const refreshBtn = document.getElementById('refresh-btn');
      const phoneInput = document.getElementById('phone-input');
      const codeText = document.getElementById('pair-code-text');
      const badge = document.getElementById('status-badge');
      const phone = phoneInput ? phoneInput.value.trim().replace(/[^0-9]/g, '') : '';
      if (phone.length < 8 || phone.length > 15) {
        badge.textContent = '⚠️ Enter the full number with country code, digits only';
        return;
      }
      refreshBtn.disabled = true;
      refreshBtn.textContent = '⏳ Requesting code...';
      pairingCodeRequested = false;
      codeText.textContent = 'Requesting code...';
      try {
        const res = await fetch('/pair?refresh=1', {
          method: 'POST',
          headers: { 'X-Pairing-Phone': phone, 'X-Requested-With': 'fetch' }
        });
        const data = await res.json();
        if (data.whatsappRegistered) {
          badge.textContent = '🟢 Connected & Active';
          codeText.textContent = 'Already connected';
          return;
        }
        if (data.pairingCode) {
          pairingCodeRequested = true;
          codeText.textContent = data.pairingCode;
          if (phoneInput) phoneInput.disabled = true;
          badge.textContent = '⏳ Enter ADEM1234 on this same WhatsApp number';
        } else {
          codeText.textContent = 'No code returned — check number and retry';
          badge.textContent = '⚠️ Could not generate a code for that number';
        }
        if (data.qr && !pairingQrDisplayed) {
          lastQr = data.qr;
          document.getElementById('qr-container').innerHTML = '<img id="qr-img" src="/pair/qr.svg?t=' + Date.now() + '" alt="WhatsApp QR Code" />';
          pairingQrDisplayed = true;
        }
      } catch (err) {
        codeText.textContent = 'Request failed — please retry';
        badge.textContent = '⚠️ Pairing request failed';
      } finally {
        refreshBtn.disabled = pairingCodeRequested;
        refreshBtn.textContent = pairingCodeRequested ? 'Code requested — enter ADEM1234' : '🔄 Request ADEM1234 for this number';
      }
    }

    document.getElementById('phone-input').addEventListener('input', () => {
      if (pairingCodeRequested) {
        pairingCodeRequested = false;
        document.getElementById('pair-code-text').textContent = 'Request a code for this number';
        document.getElementById('status-badge').textContent = '⏳ Click Request Fresh Pairing Code to bind a code to this number';
      }
    });

    let pairingPollInFlight = false;
    setInterval(async () => {
      if (pairingPollInFlight) return;
      pairingPollInFlight = true;
      try {
        const res = await fetch('/qr?json=1', { cache: 'no-store' });
        const data = await res.json();
        const container = document.getElementById('qr-container');
        const badge = document.getElementById('status-badge');
        const codeBox = document.getElementById('code-container');
        const codeText = document.getElementById('pair-code-text');
        const actionBar = document.getElementById('action-bar');

        if (data.whatsappRegistered) {
          container.innerHTML = '<div style="color:#00a884;padding:90px 20px;font-weight:700;font-size:18px;">✅ WhatsApp Connected & Active!</div>';
          badge.textContent = '🟢 Connected & Active';
          if (codeBox) codeBox.style.display = 'none';
          if (actionBar) actionBar.style.display = 'none';
          return;
        }
        if (pairingCodeRequested && codeText && data.pairingCode && codeText.textContent !== data.pairingCode) {
          codeText.textContent = data.pairingCode;
          badge.textContent = '⏳ Enter ADEM1234 on this same WhatsApp number';
        } else if (pairingCodeRequested && codeText && !data.pairingCode && !data.whatsappRegistered) {
          badge.textContent = '⏳ Reconnecting — keep ADEM1234 ready on the phone';
        }
        if (data.qr && !pairingQrDisplayed) {
          lastQr = data.qr;
          container.innerHTML = '<img id="qr-img" src="/pair/qr.svg?t=' + Date.now() + '" alt="WhatsApp QR Code" />';
          pairingQrDisplayed = true;
        }
      } catch (e) {
        badge.textContent = '⚠️ Pairing status refresh failed — retrying';
      } finally {
        pairingPollInFlight = false;
      }
    }, 5000);
  </script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    // 3. Rate Limiting Protection (DoS & brute-force defense on admin/operational endpoints)
    if (!httpSecurityManager.checkRateLimit(req)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too Many Requests: Rate limit exceeded. Try again in 60s.' }));
      return;
    }

    const isAdminDataRoute = ['/logs', '/render-logs', '/console', '/debug', '/recent-logs', '/session-bundle']
      .some((route) => pathname === route || pathname.startsWith(`${route}/`));
    if (isAdminDataRoute && !isSecureTransport(req)) {
      rejectInsecureAdminRequest(res);
      return;
    }

    
    if (pathname === '/logs' || pathname === '/render-logs' || pathname === '/console') {
      const auth = httpSecurityManager.verifyAdminAuth(req);
      if (!auth.isAuthenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Admin authentication token required to inspect operational logs' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(liveConsoleLogs.join('\n') || '[Server] No logs recorded yet.');
      return;
    }

    if (pathname === '/debug' || pathname === '/recent-logs') {
      const auth = httpSecurityManager.verifyAdminAuth(req);
      if (!auth.isAuthenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Admin authentication token required to inspect chat logs' }));
        return;
      }
      try {
        const rows = await db.prepare(`SELECT id, chat_jid, sender_name, is_group, content_type, message_text, is_noise, timestamp FROM chat_logs ORDER BY id DESC LIMIT 25`).all();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: rows.length, logs: rows }, null, 2));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/session-bundle') {
      const auth = httpSecurityManager.verifyAdminAuth(req);
      if (!auth.isAuthenticated) {
        // Return 404 Not Found to prevent leaking the existence of the session backup endpoint
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }
      try {
        const credsFile = path.join(config.paths.sessions, 'creds.json');
        if (!fs.existsSync(credsFile) || !fs.lstatSync(credsFile).isFile()) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'No registered session exists yet' }));
          return;
        }
        const zlib = await import('zlib');
        const filesMap: Record<string, string> = {};
        let totalBytes = 0;
        const maxBundleBytes = 20 * 1024 * 1024;
        for (const file of fs.readdirSync(config.paths.sessions)) {
          if (!file.endsWith('.json')) continue;
          const fullPath = path.join(config.paths.sessions, file);
          const stat = fs.lstatSync(fullPath);
          if (stat.isFile()) {
            totalBytes += stat.size;
            if (totalBytes > maxBundleBytes) {
              res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
              res.end(JSON.stringify({ error: 'Session bundle exceeds the 20 MB safety limit.' }));
              return;
            }
            filesMap[file] = fs.readFileSync(fullPath, 'utf8');
          }
        }
        const jsonStr = JSON.stringify(filesMap);
        const gzipped = zlib.gzipSync(Buffer.from(jsonStr, 'utf8'));
        const bundle = gzipped.toString('base64');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ success: true, count: Object.keys(filesMap).length, bundle }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
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

  // Render Free Tier anti-sleep self-pinger (every 5 minutes)
  const renderUrl = process.env.RENDER_EXTERNAL_URL || 'https://forgelabs-whatsapp-bot-m681.onrender.com';
  const keepAliveUrl = `${renderUrl.replace(/\/$/, '')}/health`;
  const renderPingTimer = setInterval(() => {
    fetch(keepAliveUrl, { signal: AbortSignal.timeout(8_000) }).catch(() => {});
  }, 5 * 60 * 1000);
  renderPingTimer.unref();
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
  console.log(`[Startup] Database initialization completed using ${config.turso.databaseUrl ? 'Turso remote' : 'local SQLite fallback'}.`);
  console.log('📦 Database initialized.');
  void await runDatabasePostInitMaintenance();

  // 2. Start HTTP Health Server & Periodic Temp/Memory Sweeper
  console.log('[Startup] Starting HTTP health server.');
  startHealthServer();
  pruneTempAndMemory();
  const cleanupTimer = setInterval(pruneTempAndMemory, 30 * 60 * 1000);
  cleanupTimer.unref();

  console.log('[Startup] Registering active plugins.');
  // 3. Register Active Plugins
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
  await pluginRegistry.registerPlugin(imageGenPlugin);
  await pluginRegistry.registerPlugin(engagementPlugin);
  await pluginRegistry.registerPlugin(stickerPlugin);
  await pluginRegistry.registerPlugin(viewOncePlugin);

  console.log(`🔌 Registered ${pluginRegistry.getAllTools().length} tools across plugins.`);

  // 4. Connect to WhatsApp via Baileys
  console.log('[Startup] Starting WhatsApp connection.');
  await whatsAppClient.start();
}

// Graceful error boundaries
process.on('uncaughtException', (err) => {
  console.error('🚨 [UncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('🚨 [UnhandledRejection]', reason);
});

await bootstrap().catch((err) => {
  console.error('❌ Failed to start bot:', err);
  process.exit(1);
});

