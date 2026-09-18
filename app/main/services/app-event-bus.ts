import { EventEmitter } from "node:events";

export interface AppEvent<T = unknown> {
  sequence: number;
  channel: string;
  data: T;
  emittedAt: number;
}

type AppEventListener = (event: AppEvent) => void;

class AppEventBus {
  private readonly emitter = new EventEmitter();
  private nextSequence = 0;
  private readonly recentEvents: AppEvent[] = [];
  private readonly maxRecentEvents = 2_000;

  publish<T>(channel: string, data: T): AppEvent<T> {
    const event: AppEvent<T> = {
      sequence: ++this.nextSequence,
      channel,
      data,
      emittedAt: Date.now(),
    };
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.splice(0, this.recentEvents.length - this.maxRecentEvents);
    }
    this.emitter.emit("event", event);
    return event;
  }

  subscribe(listener: AppEventListener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  currentSequence(): number {
    return this.nextSequence;
  }

  /**
   * 返回游标后的事件；游标已早于环形缓冲时返回 null，调用方应重新拉快照。
   */
  eventsAfter(sequence: number, predicate?: (event: AppEvent) => boolean): AppEvent[] | null {
    const oldest = this.recentEvents[0]?.sequence;
    if (oldest !== undefined && sequence < oldest - 1) return null;
    return this.recentEvents.filter((event) => event.sequence > sequence && (!predicate || predicate(event)));
  }
}

export const appEventBus = new AppEventBus();
