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

  public getGroqToolDefinitions(): any[] {
    return this.getAllTools().map((t) => ({
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
