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
  private activeChats: Set<string> = new Set();

  public enqueue(task: QueueTask): boolean {
    // Reject new work at capacity so existing chats keep their place and memory stays bounded.
    if (this.queue.length >= 50) {
      console.warn(`[RequestQueue] Queue is full; rejecting incoming task ${task.id}.`);
      return false;
    }

    this.queue.push(task);
    this.processNext();
    return true;
  }

  private async processNext(): Promise<void> {
    if (this.runningCount >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    // Find the first task whose chat is not currently being processed
    const taskIndex = this.queue.findIndex((t) => !this.activeChats.has(t.chatJid));
    if (taskIndex === -1) {
      return;
    }

    const [task] = this.queue.splice(taskIndex, 1);
    if (!task) return;

    this.runningCount++;
    this.activeChats.add(task.chatJid);

    try {
      // Warn on slow work, but retain the concurrency/chat lock until it settles. A Promise.race
      // would release both locks while the original handler continued in the background.
      const slowTaskWarning = setTimeout(() => {
        console.warn(`[RequestQueue] Task ${task.id} is still running after 60 seconds.`);
      }, 60_000);
      slowTaskWarning.unref?.();
      try {
        await task.execute();
      } finally {
        clearTimeout(slowTaskWarning);
      }
    } catch (err: any) {
      console.error(`[RequestQueue] Error executing task ${task.id}:`, err.message);
    } finally {
      this.runningCount--;
      this.activeChats.delete(task.chatJid);
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

