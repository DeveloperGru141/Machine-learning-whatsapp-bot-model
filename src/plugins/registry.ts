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
   * Smart Tool Router: Selects only the 1-5 tools relevant to the active message intent.
   * Passing 25+ tool definitions to LLMs causes 30s+ grammar evaluation latency.
   * Passing 0-5 tools reduces inference time to 400ms-900ms while ensuring tools are never missed.
   */
  public getRelevantToolDefinitions(userMessage: string, isGroup?: boolean): any[] {
    const text = (userMessage || '').toLowerCase();
    const selected = new Set<string>();

    // 1. Diagnostics, Status, & Bot Health
    if (
      text.includes('health') ||
      text.includes('uptime') ||
      text.includes('diagnostics') ||
      text.includes('brief me') ||
      text.includes('analytics') ||
      text.includes('stats')
    ) {
      selected.add('get_bot_health_status');
      selected.add('get_bot_analytics');
    }

    // 2. WhatsApp Status Posting & Morning Status Broadcast
    if (
      text.includes('status') ||
      text.includes('post') ||
      text.includes('story') ||
      text.includes('meme')
    ) {
      selected.add('post_whatsapp_status');
      selected.add('configure_morning_status_broadcast');
    }

    // 3. Web Search & Live Info
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
      text.includes('latest') ||
      text.includes('current') ||
      text.includes('update on')
    ) {
      selected.add('web_search');
    }

    // 4. Contact Management, Direct Messaging & Unreplied Catch-Up
    const hasPhoneNumber = /\+?\d[\d\s-]{7,}\d/.test(text);
    if (
      hasPhoneNumber ||
      text.includes('message') ||
      text.includes('msg') ||
      text.includes('text') ||
      text.includes('dm') ||
      text.includes('tell') ||
      text.includes('send') ||
      text.includes('sent') ||
      text.includes('deliver') ||
      text.includes('reach out') ||
      text.includes('say hi') ||
      text.includes('greet') ||
      text.includes('contact') ||
      text.includes('save') ||
      text.includes('phone') ||
      text.includes('number') ||
      text.includes('no ') ||
      text.endsWith(' no') ||
      text.includes("s no") ||
      text.includes('micah') ||
      text.includes('vcard') ||
      text.includes('vcf')
    ) {
      selected.add('send_message_to_contact');
      selected.add('save_contact');
      selected.add('get_contact');
      selected.add('list_contacts');
      if (text.includes('card') || text.includes('share') || text.includes('vcf')) {
        selected.add('send_contact_card');
        selected.add('export_contacts_vcf');
      }
    }

    // 5. Unreplied DMs Catch-Up
    if (
      text.includes('unreplied') ||
      text.includes('unread') ||
      text.includes('catch up') ||
      text.includes('missed') ||
      text.includes('replied to') ||
      text.includes('reply to')
    ) {
      selected.add('reply_unreplied_messages');
      selected.add('send_message_to_contact');
    }

    // 6. Reminders & Daily Scheduled Broadcasts
    if (
      text.includes('remind') ||
      text.includes('alarm') ||
      text.includes('timer') ||
      text.includes('schedule') ||
      text.includes('quote') ||
      text.includes('verse') ||
      text.includes('broadcast') ||
      text.includes('daily') ||
      text.includes('morning')
    ) {
      selected.add('set_reminder');
      selected.add('schedule_daily_broadcast');
      selected.add('list_scheduled_broadcasts');
      selected.add('cancel_scheduled_broadcast');
    }

    // 7. Image Generation
    if (
      text.includes('image') ||
      text.includes('generate') ||
      text.includes('picture') ||
      text.includes('photo') ||
      text.includes('draw') ||
      text.includes('art')
    ) {
      selected.add('generate_image');
    }

    // 8. Voice Notes
    if (
      text.includes('voice note') ||
      text.includes('voicenote') ||
      text.includes('voice') ||
      text.includes('vn') ||
      text.includes('audio') ||
      text.includes('speak')
    ) {
      selected.add('send_voice_note');
    }

    // 9. Video/Audio Downloaders, Link Summaries, & Document Reading
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

    if (text.includes('document') || text.includes('pdf') || text.includes('file') || text.includes('docx')) {
      selected.add('read_document');
    }

    // 10. Admin Privileges & Group Administration
    if (
      text.includes('admin') ||
      text.includes('privilege') ||
      text.includes('grant') ||
      text.includes('revoke')
    ) {
      selected.add('grant_admin_privilege');
      selected.add('revoke_admin_privilege');
      selected.add('list_admin_privileges');
    }

    if (isGroup) {
      if (
        text.includes('tag all') ||
        text.includes('everyone') ||
        text.includes('kick') ||
        text.includes('remove') ||
        text.includes('group mode') ||
        text.includes('mute')
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
    const aliasMap: Record<string, string> = {
      send_message: 'send_message_to_contact',
      message_contact: 'send_message_to_contact',
      send_dm: 'send_message_to_contact',
      text_contact: 'send_message_to_contact',
      search_contacts: 'get_contact',
      find_contact: 'get_contact',
      lookup_contact: 'get_contact',
      schedule_reminder: 'set_reminder',
      post_status: 'post_whatsapp_status',
      reply_unreplied: 'reply_unreplied_messages',
    };

    const resolvedName = aliasMap[name] || name;
    const tool = this.tools.get(resolvedName);
    if (!tool) {
      return { success: false, message: `Tool "${name}" is not registered.` };
    }

    try {
      return await tool.execute(args || {}, context);
    } catch (err: any) {
      console.error(`[PluginRegistry] Error executing tool "${resolvedName}":`, err);
      return { success: false, message: `Execution failed: ${err.message}` };
    }
  }
}

export const pluginRegistry = new PluginRegistry();
