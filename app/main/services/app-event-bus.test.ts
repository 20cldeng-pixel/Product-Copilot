import { describe, expect, it, vi } from "vitest";
import { appEventBus } from "./app-event-bus";

describe("appEventBus", () => {
  it("给所有消费者发布同一份带递增序号的事件", () => {
    const listener = vi.fn();
    const unsubscribe = appEventBus.subscribe(listener);
    const first = appEventBus.publish("agent:test", { value: 1 });
    const second = appEventBus.publish("agent:test", { value: 2 });
    unsubscribe();
    appEventBus.publish("agent:test", { value: 3 });

    expect(second.sequence).toBe(first.sequence + 1);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, first);
    expect(listener).toHaveBeenNthCalledWith(2, second);
  });

  it("可以按游标补发事件", () => {
    const cursor = appEventBus.currentSequence();
    const first = appEventBus.publish("remote:a", { value: 1 });
    appEventBus.publish("remote:b", { value: 2 });

    expect(appEventBus.eventsAfter(cursor, (event) => event.channel === "remote:a"))
      .toEqual([first]);
  });
});
