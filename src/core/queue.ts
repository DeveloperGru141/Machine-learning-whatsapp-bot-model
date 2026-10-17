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
    // Shed tasks only if queue is severely overloaded (max 50 waiting)
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
      // 60-second timeout safeguard per task (accommodates human reading, LLM reasoning, and natural human typing delays)
      await Promise.race([
        task.execute(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Task execution timed out')), 60000)
        ),
      ]);
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

