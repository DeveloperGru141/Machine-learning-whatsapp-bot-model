import { IPlugin, BotTool, ExecutionContext, ToolResult } from './types.js';

export class PluginRegistry {
  private plugins: Map<string, IPlugin> = new Map();
  private tools: Map<string, BotTool> = new Map();

  public async registerPlugin(plugin: IPlugin): Promise<void> {
    this.plugins.set(plugin.name, plugin);

    if (plugin.tools) {
      for (const tool of plugin.tools) {
        this.tools.set(tool.name, tool);
      }
    }

    if (plugin.onLoad) {
      try {
        await plugin.onLoad();
      } catch (err) {
        console.error(`Error loading plugin ${plugin.name}:`, err);
      }
    }

    console.log(`[PluginRegistry] Loaded plugin: ${plugin.name} (${plugin.tools?.length || 0} tools)`);
  }

  public async unregisterPlugin(pluginName: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      return false;
    }

    if (plugin.onUnload) {
      try {
        await plugin.onUnload();
      } catch (err) {
        console.error(`[PluginRegistry] Error unloading plugin ${plugin.name}:`, err);
      }
    }

    if (plugin.tools) {
      for (const tool of plugin.tools) {
        this.tools.delete(tool.name);
      }
    }

    this.plugins.delete(pluginName);
    console.log(`[PluginRegistry] Unregistered plugin: ${pluginName}`);
    return true;
  }

  public getPlugin(name: string): IPlugin | undefined {
    return this.plugins.get(name);
  }

  public getAllPlugins(): IPlugin[] {
    return Array.from(this.plugins.values());
  }

  public getTool(name: string): BotTool | undefined {
    return this.tools.get(name);
  }

  public getAllTools(): BotTool[] {
    return Array.from(this.tools.values());
  }

  public getGroqToolDefinitions(isGroup?: boolean): any[] {
    const groupOnlyTools = new Set(['tag_all', 'kick_member', 'set_group_mode']);
    let tools = this.getAllTools();
    if (isGroup === false) {
      tools = tools.filter((t) => !groupOnlyTools.has(t.name));
    }
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * Smart Tool Router: Selects only the 1-4 tools relevant to the active message intent.
   * Passing 25+ tool definitions to LLMs causes 30s+ grammar evaluation latency.
   * Passing 0-3 tools reduces inference time to 600ms-1200ms.
   */
  public getRelevantToolDefinitions(userMessage: string, isGroup?: boolean): any[] {
    const text = (userMessage || '').toLowerCase();
    const selected = new Set<string>();

    // 1. Diagnostics, Status, & Bot Health
    if (
      text.includes('health') ||
      text.includes('uptime') ||
      text.includes('status') ||
      text.includes('diagnostics') ||
      text.includes('brief me')
    ) {
      selected.add('get_bot_health_status');
    }

    // 2. Web Search & Live Info
    if (
      text.includes('search') ||
      text.includes('google') ||
      text.includes('price') ||
      text.includes('who is') ||
      text.includes('who won') ||
      text.includes('weather') ||
      text.includes('score') ||
      text.includes('match') ||
      text.includes('news') ||
      text.includes('latest')
    ) {
      selected.add('web_search');
    }

    // 3. Contact Management & Direct Messaging
    if (
      text.includes('message') ||
      text.includes('text') ||
      text.includes('dm') ||
      text.includes('tell') ||
      text.includes('send to') ||
      text.includes('contact') ||
      text.includes('save') ||
      text.includes('phone')
    ) {
      selected.add('send_message_to_contact');
      selected.add('save_contact');
      selected.add('search_contacts');
    }

    // 4. Reminders & Daily Scheduled Broadcasts
    if (
      text.includes('remind') ||
      text.includes('schedule') ||
      text.includes('quote') ||
      text.includes('verse') ||
      text.includes('broadcast') ||
      text.includes('daily') ||
      text.includes('morning')
    ) {
      selected.add('schedule_reminder');
      selected.add('schedule_daily_broadcast');
      selected.add('list_scheduled_broadcasts');
      selected.add('cancel_scheduled_broadcast');
    }

    // 5. Image Generation
    if (
      text.includes('image') ||
      text.includes('generate') ||
      text.includes('picture') ||
      text.includes('photo') ||
      text.includes('draw')
    ) {
      selected.add('generate_image');
    }

    // 6. Voice Notes
    if (
      text.includes('voice note') ||
      text.includes('voice') ||
      text.includes('vn') ||
      text.includes('audio') ||
      text.includes('speak')
    ) {
      selected.add('send_voice_note');
    }

    // 7. Video/Audio Downloaders & Link Summaries
    if (
      text.includes('http') ||
      text.includes('link') ||
      text.includes('url') ||
      text.includes('scrape') ||
      text.includes('website') ||
      text.includes('article') ||
      text.includes('webpage') ||
      text.includes('tiktok') ||
      text.includes('instagram') ||
      text.includes('reel') ||
      text.includes('youtube') ||
      text.includes('download')
    ) {
      selected.add('download_video');
      selected.add('download_audio');
      selected.add('summarize_link');
    }

    // 8. Group Administration (Only in groups)
    if (isGroup) {
      if (
        text.includes('tag all') ||
        text.includes('everyone') ||
        text.includes('kick') ||
        text.includes('remove') ||
        text.includes('group mode')
      ) {
        selected.add('tag_all');
        selected.add('kick_member');
        selected.add('set_group_mode');
      }
    }

    return Array.from(selected)
      .map((name) => this.tools.get(name))
      .filter((t): t is BotTool => Boolean(t))
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
  }

  public async executeTool(name: string, args: any, context: ExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, message: `Tool "${name}" is not registered.` };
    }

    try {
      return await tool.execute(args, context);
    } catch (err: any) {
      console.error(`[PluginRegistry] Error executing tool "${name}":`, err);
      return { success: false, message: `Execution failed: ${err.message}` };
    }
  }
}

export const pluginRegistry = new PluginRegistry();
