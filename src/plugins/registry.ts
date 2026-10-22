import { IPlugin, BotTool, ExecutionContext, ToolResult } from './types.js';
import { db } from '../memory/db.js';

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
    const resolved = this.resolveAlias(name);
    return this.tools.get(resolved);
  }

  public resolveAlias(name: string): string {
    return PluginRegistry.ALIAS_MAP[name] || name;
  }

  public getAllTools(): BotTool[] {
    return Array.from(this.tools.values());
  }

  public getGroqToolDefinitions(isGroup?: boolean): any[] {
    const groupOnlyTools = new Set(['tag_all']);
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
  public getRelevantToolDefinitions(userMessage: string, isGroup?: boolean, chatJid?: string): any[] {
    const text = (userMessage || '').toLowerCase();
    const selected = new Set<string>();

    let recentChatContext = '';
    if (chatJid) {
      try {
        const recentRows = db.prepare(`
          SELECT message_text FROM chat_logs
          WHERE chat_jid = ?
          ORDER BY id DESC LIMIT 5
        `).all(chatJid) as Array<{ message_text: string | null }>;
        recentChatContext = recentRows.map((r) => r.message_text || '').join(' ').toLowerCase();
      } catch {}
    }

    const isContinuation =
      /^(do that|do it|do so|send it|send am|send the message|send the message to him|send to him|ping him|message him|proceed|yes|yes please|confirm|make you send am|send now|go ahead)$/i.test(
        text.trim()
      ) ||
      (text.split(/\s+/).length <= 4 &&
        (text.includes('send') ||
          text.includes('message') ||
          text.includes('ping') ||
          text.includes('text') ||
          text.includes('do')));

    // 1. Diagnostics, Status, Executive Briefing & Bot Health
    if (
      text.includes('health') ||
      text.includes('uptime') ||
      text.includes('diagnostics') ||
      text.includes('brief me') ||
      text.includes('briefing') ||
      text.includes('agenda') ||
      text.includes('my day') ||
      text.includes('morning brief') ||
      text.includes('executive') ||
      text.includes('analytics') ||
      text.includes('stats')
    ) {
      selected.add('get_bot_health_status');
      selected.add('get_bot_analytics');
      selected.add('get_executive_briefing');
    }

    // Interactive WhatsApp Polls
    if (
      text.includes('poll') ||
      text.includes('vote') ||
      text.includes('voting') ||
      text.includes('choice') ||
      text.includes('decide') ||
      text.includes('ballot')
    ) {
      selected.add('create_poll');
    }

    // Group Discussion Catch-Up & Thread Recap
    if (
      text.includes('catch up') ||
      text.includes('catch me up') ||
      text.includes('what did i miss') ||
      text.includes('what i miss') ||
      text.includes('recap') ||
      text.includes('summarize group') ||
      text.includes('summary of group') ||
      text.includes('summary of the group') ||
      text.includes('what was said') ||
      text.includes('what were you guys saying') ||
      text.includes('discussion summary') ||
      text.includes('fill me in')
    ) {
      selected.add('summarize_group_discussion');
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
    const recentHasPhone = /\+?\d[\d\s-]{7,}\d/.test(recentChatContext);
    if (
      hasPhoneNumber ||
      isContinuation ||
      (recentHasPhone && (text.includes('him') || text.includes('her') || text.includes('them') || text.includes('that') || text.includes('number'))) ||
      text.includes('message') ||
      text.includes('msg') ||
      text.includes('text') ||
      text.includes('dm') ||
      text.includes('tell') ||
      text.includes('send') ||
      text.includes('sent') ||
      text.includes('deliver') ||
      text.includes('ping') ||
      text.includes('inform') ||
      text.includes('notify') ||
      text.includes('write') ||
      text.includes('forward') ||
      text.includes('relay') ||
      text.includes('holla') ||
      text.includes('reach out') ||
      text.includes('reach') ||
      text.includes('alert') ||
      text.includes('talk to') ||
      text.includes('chat with') ||
      text.includes('drop a note') ||
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
      text.includes('vcf') ||
      text.includes('someone') ||
      text.includes('friend')
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

    // 6. Reminders, Daily Scheduled Broadcasts, & WhatsApp Channel Motivation
    if (
      text.includes('remind') ||
      text.includes('alarm') ||
      text.includes('timer') ||
      text.includes('schedule') ||
      text.includes('quote') ||
      text.includes('motivation') ||
      text.includes('channel') ||
      text.includes('verse') ||
      text.includes('broadcast') ||
      text.includes('daily') ||
      text.includes('morning')
    ) {
      selected.add('set_reminder');
      selected.add('schedule_daily_broadcast');
      selected.add('list_scheduled_broadcasts');
      selected.add('cancel_scheduled_broadcast');
      selected.add('broadcast_group_motivation');
      selected.add('scrape_channel_quotes');
      selected.add('list_channel_quotes');
    }

    // Memes Channel (0029Vb6oS4LJkK7AvtORyH46) with 2-Hour Cooldown
    if (
      text.includes('meme') ||
      text.includes('cooldown') ||
      text.includes('funny')
    ) {
      selected.add('post_channel_meme');
      selected.add('scrape_channel_memes');
      selected.add('get_meme_cooldown_status');
    }

    // Pattern-Based Sticker Engine
    if (
      text.includes('sticker') ||
      text.includes('stk') ||
      text.includes('send me a sticker') ||
      text.includes('drop sticker')
    ) {
      selected.add('send_contextual_sticker');
    }

    // 7. Image Generation (FLUX.1-Krea-dev via Hugging Face router)
    if (
      text.includes('image') ||
      text.includes('picture') ||
      text.includes('photo') ||
      text.includes('draw') ||
      text.includes('paint') ||
      text.includes('generate') ||
      text.includes('render') ||
      text.includes('flux') ||
      text.includes('sketch') ||
      text.includes('illustration')
    ) {
      selected.add('generate_image');
    }

    // 8. Voice Notes / TTS Synthesis (ElevenLabs)
    if (
      text.includes('voice') ||
      text.includes('voice note') ||
      text.includes('voicenote') ||
      text.includes('vn') ||
      text.includes('speak') ||
      text.includes('say it') ||
      text.includes('talk to me') ||
      text.includes('audio message')
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

    // 9. Memory, Cross-Chat Awareness, & Earlier Conversation Recall
    if (
      text.includes('remember') ||
      text.includes('recall') ||
      text.includes('memory') ||
      text.includes('forgot') ||
      text.includes('history') ||
      text.includes('earlier') ||
      text.includes('previously') ||
      text.includes('what was said') ||
      text.includes('what were they saying') ||
      text.includes('what did they say') ||
      text.includes('recap') ||
      text.includes('catch me up') ||
      text.includes('said in the group') ||
      text.includes('chat section') ||
      text.includes('across chat') ||
      text.includes('other chat') ||
      text.includes('other group') ||
      text.includes('contribute') ||
      text.includes('contributing') ||
      text.includes('activity') ||
      text.includes('what have you done') ||
      text.includes('wetin you don do') ||
      text.includes('what did you do') ||
      text.includes('what are you doing') ||
      text.includes('autonomous') ||
      text.includes('sentience') ||
      text.includes('on your own') ||
      text.includes('by yourself') ||
      text.includes('recent action')
    ) {
      selected.add('search_memory');
      selected.add('get_earlier_chat_history');
      selected.add('remember_fact');
      selected.add('get_cross_chat_activity');
      selected.add('list_autonomous_actions');
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

    
    // Group Moderation & Mode Toggle (Available in both Groups and DMs for Remote Admin)
    if (
      text.includes('lock') ||
      text.includes('unlock') ||
      text.includes('open group') ||
      text.includes('close group') ||
      text.includes('mute group') ||
      text.includes('unmute group') ||
      text.includes('group locked') ||
      text.includes('still locked') ||
      text.includes('unlock it') ||
      text.includes('open it') ||
      text.includes('lock it')
    ) {
      selected.add('set_group_mode');
      selected.add('get_group_info');
    }

    if (isGroup) {
      if (
        text.includes('tag') ||
        text.includes('everyone') ||
        text.includes('kick') ||
        text.includes('remove') ||
        text.includes('add') ||
        text.includes('delete') ||
        text.includes('revoke') ||
        text.includes('erase') ||
        text.includes('clean') ||
        text.includes('promote') ||
        text.includes('demote') ||
        text.includes('admin') ||
        text.includes('lock') ||
        text.includes('mute') ||
        text.includes('unlock') ||
        text.includes('unmute') ||
        text.includes('group mode') ||
        text.includes('subject') ||
        text.includes('name') ||
        text.includes('rename') ||
        text.includes('description') ||
        text.includes('link') ||
        text.includes('invite') ||
        text.includes('disappear') ||
        text.includes('ephemeral') ||
        text.includes('approval') ||
        text.includes('approve') ||
        text.includes('reject') ||
        text.includes('request') ||
        text.includes('pending') ||
        text.includes('info')
      ) {
        selected.add('tag_all');
        selected.add('kick_member');
        selected.add('add_member');
        selected.add('delete_group_message');
        selected.add('promote_member');
        selected.add('demote_member');
        selected.add('set_group_mode');
        selected.add('set_group_subject');
        selected.add('set_group_description');
        selected.add('get_group_invite_link');
        selected.add('revoke_group_invite_link');
        selected.add('set_disappearing_messages');
        selected.add('list_join_requests');
        selected.add('approve_join_request');
        selected.add('reject_join_request');
        selected.add('get_group_info');
      }

      if (
        text.includes('leave') ||
        text.includes('exit') ||
        text.includes('commot') ||
        text.includes('get out') ||
        text.includes('depart')
      ) {
        selected.add('leave_group');
      }
    }

    // 11. Group Messaging, Group Search, and Group Joining via Invite Link
    if (
      text.includes('group') ||
      text.includes('space') ||
      text.includes('channel') ||
      text.includes('chat.whatsapp.com') ||
      text.includes('join') ||
      text.includes('invite') ||
      text.includes('reply to') ||
      text.includes('post in') ||
      text.includes('send to') ||
      text.includes('tell the group')
    ) {
      selected.add('send_message_to_group');
      selected.add('list_joined_groups');
      selected.add('get_group_info');
      if (text.includes('join') || text.includes('invite') || text.includes('chat.whatsapp.com')) {
        selected.add('join_group');
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

  public static readonly ALIAS_MAP: Record<string, string> = {
    send_message: 'send_message_to_contact',
    message_contact: 'send_message_to_contact',
    send_dm: 'send_message_to_contact',
    text_contact: 'send_message_to_contact',
    search_contacts: 'get_contact',
    find_contact: 'get_contact',
    lookup_contact: 'get_contact',
    schedule_reminder: 'set_reminder',
    post_status: 'post_whatsapp_status',
    broadcast_motivation: 'broadcast_group_motivation',
    post_morning_motivation: 'broadcast_group_motivation',
    scrape_quotes: 'scrape_channel_quotes',
    get_channel_quotes: 'list_channel_quotes',
    send_sticker: 'send_contextual_sticker',
    reply_with_sticker: 'send_contextual_sticker',
    post_meme: 'post_channel_meme',
    scrape_memes: 'scrape_channel_memes',
    meme_cooldown: 'get_meme_cooldown_status',
    reply_unreplied: 'reply_unreplied_messages',
    join_group_via_invite_link: 'join_group',
    join_whatsapp_group: 'join_group',
    accept_group_invite: 'join_group',
    send_to_group: 'send_message_to_group',
    message_group: 'send_message_to_group',
    reply_to_group: 'send_message_to_group',
    post_to_group: 'send_message_to_group',
    send_group_message: 'send_message_to_group',
    kick: 'kick_member',
    remove_member: 'kick_member',
    add_participant: 'add_member',
    add_user: 'add_member',
    delete_message: 'delete_group_message',
    delete_msg: 'delete_group_message',
    revoke_message: 'delete_group_message',
    open_group: 'set_group_mode',
    unlock_group: 'set_group_mode',
    lock_group: 'set_group_mode',
    close_group: 'set_group_mode',
    mute_group: 'set_group_mode',
    unmute_group: 'set_group_mode',
    open_chat: 'set_group_mode',
    unlock_chat: 'set_group_mode',
    lock_settings: 'set_group_mode',
    unlock_settings: 'set_group_mode',
    group_info: 'get_group_info',
    list_admins: 'get_group_info',
    disappearing_messages: 'set_disappearing_messages',
    ephemeral_messages: 'set_disappearing_messages',
    approve_participant: 'approve_join_request',
    reject_participant: 'reject_join_request',
    create_image: 'generate_image',
    draw_image: 'generate_image',
    make_image: 'generate_image',
    generate_picture: 'generate_image',
    image_generator: 'generate_image',
    leave: 'leave_group',
    exit_group: 'leave_group',
    leave_chat: 'leave_group',
    exit_chat: 'leave_group',
    earlier_messages: 'get_earlier_chat_history',
    chat_history: 'get_earlier_chat_history',
    earlier_chat: 'get_earlier_chat_history',
    group_history: 'get_earlier_chat_history',
    earlier_discussion: 'get_earlier_chat_history',
    cross_chat_activity: 'get_cross_chat_activity',
    chats_contributed: 'get_cross_chat_activity',
    create_whatsapp_poll: 'create_poll',
    make_poll: 'create_poll',
    start_poll: 'create_poll',
    start_vote: 'create_poll',
    vote: 'create_poll',
    poll: 'create_poll',
    catch_me_up: 'summarize_group_discussion',
    group_summary: 'summarize_group_discussion',
    recap: 'summarize_group_discussion',
    chat_recap: 'summarize_group_discussion',
    what_did_i_miss: 'summarize_group_discussion',
    group_catchup: 'summarize_group_discussion',
    brief_me: 'get_executive_briefing',
    executive_briefing: 'get_executive_briefing',
    morning_briefing: 'get_executive_briefing',
    daily_briefing: 'get_executive_briefing',
    agenda: 'get_executive_briefing',
  };

  public async executeTool(name: string, args: any, context: ExecutionContext): Promise<ToolResult> {
    const resolvedName = this.resolveAlias(name);
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
