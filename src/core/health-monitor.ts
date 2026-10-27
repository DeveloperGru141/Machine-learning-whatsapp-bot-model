import type { WASocket } from '@whiskeysockets/baileys';

export interface HealthReport {
  uptime: number; // in seconds
  messagesHandled: number;
  errors: number;
  isConnected: boolean;
  memoryUsage: NodeJS.MemoryUsage;
  lastMessageProcessed?: number;
}

export class HealthMonitor {
  private lastMessageProcessed: number = 0;
  private totalMessagesHandled: number = 0;
  private totalErrors: number = 0;
  private uptimeStart: number = Date.now();
  private isConnected: boolean = false;
  private disconnectedSince: number = 0;
  private monitoringInterval: NodeJS.Timeout | null = null;

  public recordMessage(): void {
    this.totalMessagesHandled++;
    this.lastMessageProcessed = Date.now();
  }

  public recordError(err: Error): void {
    this.totalErrors++;
    console.error('[HealthMonitor] Error recorded:', err.message, err.stack);
  }

  public setConnectionStatus(connected: boolean): void {
    this.isConnected = connected;
    if (connected) {
      this.disconnectedSince = 0;
    } else if (this.disconnectedSince === 0) {
      this.disconnectedSince = Date.now();
    }
    console.log(`[HealthMonitor] WhatsApp connection status: ${connected ? 'ONLINE' : 'OFFLINE'}`);
  }

  public getHealthReport(): HealthReport {
    const uptime = Math.floor((Date.now() - this.uptimeStart) / 1000);
    return {
      uptime,
      messagesHandled: this.totalMessagesHandled,
      errors: this.totalErrors,
      isConnected: this.isConnected,
      memoryUsage: process.memoryUsage(),
      lastMessageProcessed: this.lastMessageProcessed > 0 ? this.lastMessageProcessed : undefined,
    };
  }

  public startMonitoring(_sock: WASocket, ownerJid: string): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }

    console.log('[HealthMonitor] Starting periodic health monitoring (5 min interval)...');

    // Run check every 5 minutes
    this.monitoringInterval = setInterval(() => {
      const now = Date.now();

      // Check 1: If no messages processed in last 10 minutes AND was previously active
      if (
        this.totalMessagesHandled > 0 &&
        this.lastMessageProcessed > 0 &&
        now - this.lastMessageProcessed > 10 * 60 * 1000
      ) {
        const idleMinutes = Math.floor((now - this.lastMessageProcessed) / 60000);
        console.warn(
          `⚠️ [HealthMonitor] WARNING: Bot has been idle with no messages processed in the last ${idleMinutes} minutes despite prior activity.`
        );
      }

      // Check 2: If isConnected is false for more than 2 minutes, attempt to notify via console
      if (!this.isConnected && this.disconnectedSince > 0 && now - this.disconnectedSince > 2 * 60 * 1000) {
        const downMinutes = Math.floor((now - this.disconnectedSince) / 60000);
        console.error(
          `🚨 [HealthMonitor] CRITICAL: WhatsApp socket has been disconnected for ${downMinutes}m (> 2 min). Socket is down; cannot send DM to owner (${ownerJid}). Please verify network or trigger restart.`
        );
      }
    }, 5 * 60 * 1000);

    // Allow node to exit gracefully if this is the only active handle
    this.monitoringInterval.unref();
  }

  public stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }
}

export const healthMonitor = new HealthMonitor();
