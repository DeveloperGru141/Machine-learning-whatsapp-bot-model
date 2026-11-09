import { IPlugin, BotTool, ExecutionContext, ToolResult } from './types.js';

export class PluginRegistry {
  private plugins: Map<string, IPlugin> = new Map();
  private tools: Map<string, BotTool> = new Map();

  public async registerPlugin(plugin: IPlugin): Promise<void> {
    const existingPlugin = this.plugins.get(plugin.name);
    if (existingPlugin) {
      if (existingPlugin === plugin) return;
      throw new Error(`Plugin "${plugin.name}" is already registered.`);
    }

    for (const tool of plugin.tools || []) {
      if (this.tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" is already registered by another plugin.`);
      }
    }

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

  private validateValue(value: unknown, schema: any, path: string): string | null {
    if (!schema || typeof schema !== 'object') return null;

    const expectedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (expectedTypes.length > 0) {
      const matchesType = expectedTypes.some((type: string) => {
        switch (type) {
          case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
          case 'array': return Array.isArray(value);
          case 'integer': return typeof value === 'number' && Number.isInteger(value);
          case 'number': return typeof value === 'number' && Number.isFinite(value);
          case 'string': return typeof value === 'string';
          case 'boolean': return typeof value === 'boolean';
          case 'null': return value === null;
          default: return true;
        }
      });
      if (!matchesType) return `${path} must be ${expectedTypes.join(' or ')}.`;
    }

    if (Array.isArray(schema.enum) && !schema.enum.some((item: unknown) => item === value)) {
      return `${path} must be one of the allowed values.`;
    }
    if (typeof value === 'string') {
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) return `${path} is too short.`;
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return `${path} is too long.`;
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) return `${path} has an invalid format.`;
    }
    if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path} is below its minimum.`;
      if (typeof schema.maximum === 'number' && value > schema.maximum) return `${path} exceeds its maximum.`;
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${path} has too few items.`;
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${path} has too many items.`;
      if (schema.items) {
        for (let index = 0; index < value.length; index++) {
          const error = this.validateValue(value[index], schema.items, `${path}[${index}]`);
          if (error) return error;
        }
      }
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const objectValue = value as Record<string, unknown>;
      const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
      for (const required of schema.required || []) {
        if (!(required in objectValue)) return `${path}.${required} is required.`;
      }
      for (const [key, childValue] of Object.entries(objectValue)) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) {
          const error = this.validateValue(childValue, properties[key], `${path}.${key}`);
          if (error) return error;
        } else if (schema.additionalProperties === false) {
          return `${path}.${key} is not an allowed argument.`;
        } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          const error = this.validateValue(childValue, schema.additionalProperties, `${path}.${key}`);
          if (error) return error;
        }
      }
    }
    return null;
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
  public async getRelevantToolDefinitions(userMessage: string, isGroup?: boolean, _chatJid?: string): Promise<any[]> {
    const text = (userMessage || '').toLowerCase();
    const selected = new Set<string>();

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

    // Publish tools are exposed only for clear posting requests, not when someone asks about status or memes.
    const explicitlyAsksToPost = /\b(?:post|publish|share|put|upload)\b/.test(text);
    if (explicitlyAsksToPost && /\b(?:status|story)\b/.test(text)) {
      selected.add('post_whatsapp_status');
    }
    if (explicitlyAsksToPost && /\bmeme\b/.test(text)) selected.add('post_channel_meme');

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
      text.includes('update on') ||
      text.includes('this season') ||
      text.includes('season to date') ||
      text.includes('so far this season') ||
      text.includes('goals scored') ||
      text.includes('how many goals') ||
      text.includes('scored this season') ||
      text.includes('current stats') ||
      text.includes('latest stats')
    ) {
      selected.add('web_search');
    }
    if (
      /\b(?:football|soccer|match|game)\b/.test(text) &&
      /\b(?:score|result|won|winning|played|live)\b/.test(text)
    ) {
      selected.add('get_live_football_scores');
    }

    const asksGroupMotivation = /\b(?:broadcast|send|share|post)\b/.test(text) &&
      /\b(?:groups|group|everyone)\b/.test(text) &&
      /\b(?:motivation|motivational|quote|verse|morning|evening|night|roundup|round-up)\b/.test(text);
    const asksAllGroups = /\b(?:groups|everyone|all groups|every group|across all groups)\b/.test(text);
    const asksToMessageGroup = /\b(?:send|tell|post|relay|forward|share)\b/.test(text) &&
      /\b(?:group|groups|space)\b/.test(text) && !(asksGroupMotivation && asksAllGroups);

    // 4. Contact Management, Direct Messaging & Unreplied Catch-Up
    const hasPhoneNumber = /\+?\d[\d\s-]{7,}\d/.test(userMessage);
    const dispatchVerb = /\b(?:send|message|msg|text|dm|tell|deliver|ping|inform|notify|write|forward|relay|holla|reach|alert|greet)\b/.test(text);
    const namedRecipientCue = /\b(?:to\s+(?:him|her|them|someone|my friend|my boss|[\p{L}][\p{L}'-]{1,})|him|her|them|someone|my friend|my boss)\b/iu.test(userMessage) ||
      /\b(?:message|msg|text|dm|ping)\s+(?!me\b|us\b|what\b|why\b|how\b)([\p{L}][\p{L}'-]{1,})/iu.test(userMessage);
    const asksToSendContact = !asksToMessageGroup && !(asksGroupMotivation && asksAllGroups) && (
      dispatchVerb && (hasPhoneNumber || namedRecipientCue)
    ) && !/\b(?:contact card|vcard|vcf|export contacts)\b/.test(text);
    const asksToSaveContact = /\b(?:save|add|store|create)\b/.test(text) && /\b(?:contact|number|phone)\b/.test(text);
    const asksToLookupContact = !asksToSendContact && /\b(?:find|search|lookup|look up|show|get|check|who is|what is)\b/.test(text) &&
      /\b(?:contact|address book|phone number|contact details|contact info)\b/.test(text);
    const asksToListContacts = /\b(?:list|show|export)\b/.test(text) && /\b(?:contacts|address book|vcf)\b/.test(text);
    if (asksToSendContact) selected.add('send_message_to_contact');
    if (asksToSaveContact) selected.add('save_contact');
    if (asksToLookupContact) selected.add('get_contact');
    if (asksToListContacts) selected.add('list_contacts');
    if (/\b(?:send|share|create)\b/.test(text) && /\b(?:contact card|vcard)\b/.test(text)) selected.add('send_contact_card');
    if (/\bexport\b/.test(text) && /\b(?:contacts|address book|vcf)\b/.test(text)) selected.add('export_contacts_vcf');

    // 5. Unreplied DMs Catch-Up
    if (
      text.includes('unreplied') ||
      text.includes('unread') ||
      text.includes('catch up') ||
      text.includes('missed') ||
      text.includes('replied to') ||
      text.includes('reply to') ||
      (text.includes('reply') && (text.includes('dm') || text.includes('ppl') || text.includes('people') || text.includes('contact') || text.includes('dms')))
    ) {
      selected.add('reply_unreplied_messages');
      selected.add('send_message_to_contact');
    }

    // 6. Reminders and scheduled broadcasts
    if (text.includes('remind') || text.includes('alarm') || text.includes('timer')) {
      selected.add('set_reminder');
    }
    if (text.includes('schedule') && /\b(?:daily|broadcast|morning|quote|verse|motivation)\b/.test(text)) {
      selected.add('schedule_daily_broadcast');
    }
    if (text.includes('scheduled broadcast') || text.includes('scheduled reminder') || text.includes('broadcast schedule')) {
      selected.add('list_scheduled_broadcasts');
    }
    if (text.includes('cancel') && /\b(?:scheduled|broadcast|reminder)\b/.test(text)) {
      selected.add('cancel_scheduled_broadcast');
    }
    if (asksGroupMotivation && asksAllGroups) {
      if (/\b(?:evening|night|roundup|round-up)\b/.test(text)) selected.add('broadcast_group_evening_roundup');
      else selected.add('broadcast_group_motivation');
    }
    if (text.includes('scrape') && /\bquotes?\b/.test(text)) {
      selected.add('scrape_channel_quotes');
    }
    if ((text.includes('list') || text.includes('show')) && /\bquotes?\b/.test(text)) {
      selected.add('list_channel_quotes');
    }

    // Memes Channel (0029Vb6oS4LJkK7AvtORyH46) with 2-Hour Cooldown
    if (text.includes('cooldown') && /meme|status/i.test(text)) {
      selected.add('get_meme_cooldown_status');
    }
    if (text.includes('scrape') && text.includes('meme')) selected.add('scrape_channel_memes');

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

    if (text.includes('export') && (text.includes('chat') || text.includes('conversation') || text.includes('history'))) {
      selected.add('export_chat');
    }
    if (text.includes('export') && /\b(?:training|dataset|fine.?tuning)\b/.test(text)) {
      selected.add('export_training_data');
    }

    if (/\b(?:reload|hot reload)\b/.test(text) && /\bplugins?\b/.test(text)) {
      selected.add('reload_plugins');
    }

    if (text.includes('contact reminder') || text.includes('save contact reminder')) {
      selected.add('get_contact_save_reminder_status');
      if (text.includes('start') || text.includes('begin') || text.includes('run')) {
        selected.add('start_contact_save_reminders');
        selected.add('preview_contact_save_reminders');
      }
      if (text.includes('pause') || text.includes('stop')) selected.add('pause_contact_save_reminders');
      if (text.includes('preview')) selected.add('preview_contact_save_reminders');
    }

    if (text.includes('my groups') || text.includes('groups are you in') || text.includes('groups you are in')) {
      selected.add('list_my_groups');
    }

    if (text.includes('view once') || text.includes('view-once')) {
      selected.add('list_view_once');
      selected.add('retrieve_view_once');
    }

    if (text.includes('tts') || text.includes('voice id') || text.includes('voice setting')) {
      selected.add('get_tts_voice_info');
      if (text.includes('set') || text.includes('change') || text.includes('switch')) selected.add('set_tts_voice_id');
    }

    if (text.includes('transcribe') || text.includes('transcription')) selected.add('transcribe_voice_note');

    if (text.includes('proactive check-in') || text.includes('proactive checkin') || text.includes('trigger a check-in')) {
      selected.add('trigger_proactive_checkin');
    }

    if (text.includes('suspicious link') || text.includes('check this link') || text.includes('is this link safe')) {
      selected.add('inspect_suspicious_link');
    }

    if (text.includes('group banter') || text.includes('inside joke') || text.includes('past joke')) {
      selected.add('search_group_banter');
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
      text.includes('somewhere else') ||
      text.includes('in another chat') ||
      text.includes('from another chat') ||
      text.includes('elsewhere') ||
      text.includes('across whatsapp') ||
      text.includes('across my chats') ||
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

    if (isGroup) {
      if (/\b(?:tag|mention|ping)\b/.test(text) && /\b(?:everyone|everybody|all members|all)\b/.test(text)) selected.add('tag_all');
      if (/\b(?:kick|remove)\b/.test(text) && /\b(?:member|user|person|participant)\b/.test(text)) selected.add('kick_member');
      if (/\b(?:add|invite)\b/.test(text) && /\b(?:member|user|person|participant)\b/.test(text)) selected.add('add_member');
      if (/\b(?:delete|remove|erase|revoke)\b/.test(text) && /\b(?:message|msg|text)\b/.test(text)) selected.add('delete_group_message');
      if (/\bpromote\b/.test(text) && /\b(?:admin|member|user|person)\b/.test(text)) selected.add('promote_member');
      if (/\bdemote\b/.test(text) && /\b(?:admin|member|user|person)\b/.test(text)) selected.add('demote_member');

      if (/\b(?:lock|unlock|open|close|mute|unmute)\b/.test(text) && /\b(?:group|chat|messages|settings)\b/.test(text)) {
        selected.add('set_group_mode');
      }
      if (/\b(?:rename|change|update)\b/.test(text) && /\b(?:group name|group subject|subject)\b/.test(text)) selected.add('set_group_subject');
      if (/\b(?:change|update|edit)\b/.test(text) && /\b(?:group description|description)\b/.test(text)) selected.add('set_group_description');
      if (/\b(?:get|show|find|share)\b/.test(text) && /\b(?:group )?(?:invite link|join link)\b/.test(text)) selected.add('get_group_invite_link');
      if (/\b(?:revoke|reset|replace)\b/.test(text) && /\b(?:invite link|join link)\b/.test(text)) selected.add('revoke_group_invite_link');
      if (/\b(?:disappearing|ephemeral)\b/.test(text)) selected.add('set_disappearing_messages');
      if (/\b(?:pending|list|show|who)\b/.test(text) && /\b(?:join requests|requests to join)\b/.test(text)) selected.add('list_join_requests');
      if (/\bapprove\b/.test(text) && /\b(?:join request|participant|request)\b/.test(text)) selected.add('approve_join_request');
      if (/\breject\b/.test(text) && /\b(?:join request|participant|request)\b/.test(text)) selected.add('reject_join_request');
      if (/\b(?:group info|group details|who are the admins|list admins|member count)\b/.test(text)) selected.add('get_group_info');

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
    if (asksToMessageGroup) {
      selected.add('send_message_to_group');
    }
    if (/\b(?:which|what|list|show)\b/.test(text) && /\b(?:groups|groups? you are in|groups? you joined)\b/.test(text)) {
      selected.add('list_joined_groups');
    }
    if (/\b(?:group info|group details|who are the admins|list admins|member count)\b/.test(text)) {
      selected.add('get_group_info');
    }
    if (text.includes('chat.whatsapp.com') || (/\bjoin\b/.test(text) && /\bgroup\b/.test(text))) {
      selected.add('join_group');
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

    const validationError = this.validateValue(args, tool.parameters, 'arguments');
    if (validationError) {
      return { success: false, message: `Invalid arguments for ${resolvedName}: ${validationError}` };
    }

    try {
      return await tool.execute(args, context);
    } catch (err: any) {
      console.error(`[PluginRegistry] Error executing tool "${resolvedName}":`, err);
      return { success: false, message: `Execution failed: ${err.message}` };
    }
  }
}

export const pluginRegistry = new PluginRegistry();
