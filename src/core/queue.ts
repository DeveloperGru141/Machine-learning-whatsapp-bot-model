export interface QueueTask {
  id: string;
  senderJid: string;
  chatJid: string;
  execute: () => Promise<void>;
}

export class RequestQueue {
  private queue: QueueTask[] = [];
  private runningCount = 0;
  private maxConcurrency = 3;
  private userLastRequest: Map<string, number> = new Map();
  private userCooldownMs = 1500; // 1.5s cooldown per user to prevent flood

  public enqueue(task: QueueTask): boolean {
    const now = Date.now();
    const last = this.userLastRequest.get(task.senderJid) || 0;

    // Reject flood bursts from same user within cooldown window
    if (now - last < this.userCooldownMs) {
      console.warn(`[RequestQueue] Throttling burst request from ${task.senderJid}`);
      return false;
    }
    this.userLastRequest.set(task.senderJid, now);

    // Shed tasks if queue is overloaded (max 50 waiting)
    if (this.queue.length >= 50) {
      console.warn(`[RequestQueue] Queue capacity exceeded. Dropping oldest non-priority request.`);
      this.queue.shift();
    }

    this.queue.push(task);
    this.processNext();
    return true;
  }

  private async processNext(): Promise<void> {
    if (this.runningCount >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    const task = this.queue.shift();
    if (!task) return;

    this.runningCount++;

    try {
      // 45-second timeout safeguard per task
      await Promise.race([
        task.execute(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Task execution timed out')), 45000)
        ),
      ]);
    } catch (err: any) {
      console.error(`[RequestQueue] Error executing task ${task.id}:`, err.message);
    } finally {
      this.runningCount--;
      // Process next item in queue
      setImmediate(() => this.processNext());
    }
  }

  public getStats() {
    return {
      running: this.runningCount,
      waiting: this.queue.length,
    };
  }
}

export const requestQueue = new RequestQueue();
