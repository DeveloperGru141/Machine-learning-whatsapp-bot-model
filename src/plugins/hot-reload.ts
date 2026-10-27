import fs from 'fs';
import path from 'path';
import { dirname } from 'node:path';
import { pathToFileURL } from 'url';
import { fileURLToPath } from 'node:url';
import { PluginRegistry, pluginRegistry } from './registry.js';
import { BotTool, ExecutionContext, IPlugin, ToolResult } from './types.js';
import { userProfileManager } from '../memory/user-profiles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class PluginHotReloader {
  private pluginPaths: Map<string, string> = new Map([
    ['ImageGenerator', 'src/plugins/image-gen/image-plugin.ts'],
    ['AudioDownloader', 'src/plugins/audio-downloader/audio-plugin.ts'],
    ['VideoDownloader', 'src/plugins/video-downloader/video-plugin.ts'],
    ['GroupAdminSuite', 'src/plugins/group-admin/admin-plugin.ts'],
    ['DocumentReader', 'src/plugins/document-reader/document-plugin.ts'],
    ['Scheduler', 'src/plugins/scheduler/scheduler-plugin.ts'],
    ['LinkSummarizer', 'src/plugins/link-summarizer/link-plugin.ts'],
    ['ConversationExport', 'src/plugins/export/export-plugin.ts'],
    ['ContactManager', 'src/plugins/contact/contact-plugin.ts'],
    ['MemoryRecall', 'src/plugins/memory-search/memory-plugin.ts'],
    ['DatasetExporter', 'src/learning/dataset-exporter.ts'],
    ['WebSearch', 'src/plugins/web-search/search-plugin.ts'],
  ]);

  /**
   * Register or update a custom module path for a plugin
   */
  public registerPluginPath(pluginName: string, modulePath: string): void {
    this.pluginPaths.set(pluginName, modulePath);
  }

  /**
   * Returns list of all known plugin names
   */
  public getKnownPluginNames(): string[] {
    return Array.from(this.pluginPaths.keys());
  }

  /**
   * Resolves physical file path prioritizing compiled dist/.js when running from dist/ or source .ts under tsx
   */
  private resolveModuleFile(relOrAbsPath: string): string {
    const projectRoot = path.resolve(__dirname, '../..');
    const isRunningFromDist = typeof __filename === 'string' && __filename.endsWith('.js');
    const normalizedRel = relOrAbsPath.replace(/\\/g, '/');

    const roots = [projectRoot, process.cwd()];
    for (const root of roots) {
      if (isRunningFromDist && normalizedRel.startsWith('src/') && normalizedRel.endsWith('.ts')) {
        const distRel = 'dist/' + normalizedRel.slice(4, -3) + '.js';
        const distCandidate = path.resolve(root, distRel);
        if (fs.existsSync(distCandidate)) {
          return distCandidate;
        }
      }

      const candidate = path.isAbsolute(relOrAbsPath)
        ? relOrAbsPath
        : path.resolve(root, relOrAbsPath);

      if (fs.existsSync(candidate)) return candidate;

      // Check dist/ equivalent if src/ path was given
      if (normalizedRel.startsWith('src/') && normalizedRel.endsWith('.ts')) {
        const distRel = 'dist/' + normalizedRel.slice(4, -3) + '.js';
        const distCandidate = path.resolve(root, distRel);
        if (fs.existsSync(distCandidate)) return distCandidate;
      }

      // Check with .js extension replaced by .ts or vice versa
      if (candidate.endsWith('.js')) {
        const tsCandidate = candidate.slice(0, -3) + '.ts';
        if (fs.existsSync(tsCandidate)) return tsCandidate;
      } else if (candidate.endsWith('.ts')) {
        const jsCandidate = candidate.slice(0, -3) + '.js';
        if (fs.existsSync(jsCandidate)) return jsCandidate;
      }
    }

    return path.resolve(projectRoot, relOrAbsPath);
  }

  /**
   * Hot-reloads a plugin by unregistering, re-importing with cache-busting, and re-registering
   */
  public async reloadPlugin(
    pluginName: string,
    registry: PluginRegistry
  ): Promise<{ success: boolean; message: string; error?: string }> {
    // 1. Locate registered path
    let matchedName = '';
    let targetPath = '';

    for (const [name, p] of this.pluginPaths.entries()) {
      if (name.toLowerCase() === pluginName.toLowerCase()) {
        matchedName = name;
        targetPath = p;
        break;
      }
    }

    if (!targetPath) {
      return {
        success: false,
        message: `Plugin "${pluginName}" not recognized. Known plugins: ${this.getKnownPluginNames().join(', ')}`,
      };
    }

    const resolvedFile = this.resolveModuleFile(targetPath);
    if (!fs.existsSync(resolvedFile)) {
      return {
        success: false,
        message: `Cannot reload plugin "${matchedName}": File not found at "${resolvedFile}".`,
      };
    }

    try {
      console.log(`[PluginHotReloader] Unregistering existing plugin: ${matchedName}`);

      // 2. Unregister via registry.unregisterPlugin if present, or fallback
      const regAny = registry as any;
      if (typeof regAny.unregisterPlugin === 'function') {
        await regAny.unregisterPlugin(matchedName);
      } else {
        // Fallback for when unregisterPlugin is not yet defined directly in PluginRegistry class
        console.warn(
          `[PluginHotReloader] registry.unregisterPlugin() not found on registry. Performing internal fallback cleanup for "${matchedName}".`
        );
        if (regAny.plugins instanceof Map && regAny.plugins.has(matchedName)) {
          const oldPlugin = regAny.plugins.get(matchedName);
          if (oldPlugin?.onUnload) {
            try {
              await oldPlugin.onUnload();
            } catch (err) {
              console.error(`[PluginHotReloader] Error during ${matchedName}.onUnload():`, err);
            }
          }
          if (oldPlugin?.tools && regAny.tools instanceof Map) {
            for (const t of oldPlugin.tools) {
              regAny.tools.delete(t.name);
            }
          }
          regAny.plugins.delete(matchedName);
        }
      }

      // 3. Cache-busted dynamic ESM import using file URL (with automatic dist/ fallback)
      let importedModule: any;
      const fileUrl = `${pathToFileURL(resolvedFile).href}?t=${Date.now()}`;
      console.log(`[PluginHotReloader] Re-importing module from ${fileUrl}`);
      try {
        importedModule = await import(fileUrl);
      } catch (importErr: any) {
        const normalizedTarget = targetPath.replace(/\\/g, '/');
        const projectRoot = path.resolve(__dirname, '../..');
        if (normalizedTarget.startsWith('src/') && normalizedTarget.endsWith('.ts')) {
          const fallbackDist = path.resolve(projectRoot, 'dist/' + normalizedTarget.slice(4, -3) + '.js');
          if (fs.existsSync(fallbackDist) && fallbackDist !== resolvedFile) {
            const fallbackUrl = `${pathToFileURL(fallbackDist).href}?t=${Date.now()}`;
            console.log(`[PluginHotReloader] Retrying import from compiled dist: ${fallbackUrl}`);
            importedModule = await import(fallbackUrl);
          } else {
            throw importErr;
          }
        } else {
          throw importErr;
        }
      }

      // 4. Find the exported IPlugin instance
      let newPluginInstance: IPlugin | undefined;

      // Check named exports
      for (const key of Object.keys(importedModule)) {
        const exp = importedModule[key];
        if (
          exp &&
          typeof exp === 'object' &&
          'name' in exp &&
          typeof exp.name === 'string'
        ) {
          if (exp.name.toLowerCase() === matchedName.toLowerCase()) {
            newPluginInstance = exp as IPlugin;
            break;
          }
        }
      }

      // Check default export
      if (
        !newPluginInstance &&
        importedModule.default &&
        typeof importedModule.default === 'object' &&
        'name' in importedModule.default
      ) {
        newPluginInstance = importedModule.default as IPlugin;
      }

      // Fallback: take first export with tools array
      if (!newPluginInstance) {
        for (const key of Object.keys(importedModule)) {
          const exp = importedModule[key];
          if (exp && typeof exp === 'object' && Array.isArray(exp.tools)) {
            newPluginInstance = exp as IPlugin;
            break;
          }
        }
      }

      if (!newPluginInstance) {
        return {
          success: false,
          message: `Re-imported module for "${matchedName}", but no valid IPlugin instance was found in exports.`,
        };
      }

      // 5. Re-register into registry
      await registry.registerPlugin(newPluginInstance);
      console.log(`✅ [PluginHotReloader] Successfully reloaded plugin: ${newPluginInstance.name}`);

      return {
        success: true,
        message: `Successfully reloaded plugin "${newPluginInstance.name}" with ${newPluginInstance.tools?.length || 0} active tools.`,
      };
    } catch (err: any) {
      console.error(`[PluginHotReloader] Failed to reload plugin "${matchedName}":`, err);
      return {
        success: false,
        message: `Failed to reload plugin "${matchedName}": ${err.message}`,
        error: err.stack,
      };
    }
  }
}

export const pluginHotReloader = new PluginHotReloader();

/**
 * reload_plugins BotTool definition
 * Allows authorized bot owners to list or hot-reload installed plugins
 */
export const reloadPluginsTool: BotTool = {
  name: 'reload_plugins',
  description:
    'Hot-reloads a specified bot plugin module or lists all available plugins for reloading. Restricted to bot owners only.',
  parameters: {
    type: 'object',
    properties: {
      plugin_name: {
        type: 'string',
        description:
          'The exact name of the plugin to reload (e.g., WebSearch, GroupAdminSuite, DocumentReader, ConversationExport, ContactManager). Leave empty or specify "list" to view all available plugins.',
      },
    },
  },
  execute: async (args: { plugin_name?: string }, context: ExecutionContext): Promise<ToolResult> => {
    // 1. Verify owner authorization
    const isOwner = userProfileManager.isOwner(context.senderJid);

    if (!isOwner) {
      return {
        success: false,
        message: '⛔ Unauthorized: Only bot owners are permitted to hot-reload plugins.',
      };
    }

    const pluginName = (args.plugin_name || '').trim();

    // 2. If no plugin specified or "list", return all available plugins
    if (!pluginName || pluginName.toLowerCase() === 'list') {
      const known = pluginHotReloader.getKnownPluginNames();
      return {
        success: true,
        message: `Available plugins for hot-reload:\n${known.map((p) => `• ${p}`).join('\n')}\n\nCall reload_plugins with a plugin_name to reload it.`,
        data: { plugins: known },
      };
    }

    // 3. Perform reload
    const result = await pluginHotReloader.reloadPlugin(pluginName, pluginRegistry);
    return {
      success: result.success,
      message: result.message,
      data: result,
    };
  },
};

export const reload_plugins = reloadPluginsTool;

