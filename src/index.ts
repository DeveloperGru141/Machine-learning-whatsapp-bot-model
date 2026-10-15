import { initDatabase } from './memory/db.js';
import { pluginRegistry } from './plugins/registry.js';
import { stickerPlugin } from './plugins/sticker/sticker-plugin.js';
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
import { reloadPluginsTool } from './plugins/hot-reload.js';
import { whatsAppClient } from './core/client.js';

async function bootstrap() {
  console.log('==============================================');
  console.log('🤖 Starting WhatsApp Agentic Bot Engine...');
  console.log('==============================================');

  // 1. Initialize SQLite Database & Tables
  initDatabase();
  console.log('📦 Local SQLite Database initialized.');

  // 2. Register Active Plugins
  await pluginRegistry.registerPlugin(stickerPlugin);
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

  console.log(`🔌 Registered ${pluginRegistry.getAllTools().length} tools across plugins.`);

  // 3. Connect to WhatsApp via Baileys
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
