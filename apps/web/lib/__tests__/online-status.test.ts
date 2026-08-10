import { describe, expect, it, vi } from "vitest";
import {
  readOnlineStatus,
  subscribeToOnlineStatus,
  type OnlineStatusEventTarget,
} from "../use-online-status";

class TestOnlineStatusTarget implements OnlineStatusEventTarget {
  private readonly listeners = new Map<"online" | "offline", EventListener>();

  addEventListener(type: "online" | "offline", listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(
    type: "online" | "offline",
    listener: EventListener,
  ): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  emit(type: "online" | "offline"): void {
    this.listeners.get(type)?.(new Event(type));
  }
}

describe("online status signal", () => {
  it("reports browser connectivity and defaults safely for server rendering", () => {
    expect(readOnlineStatus({ onLine: true })).toBe(true);
    expect(readOnlineStatus({ onLine: false })).toBe(false);
    expect(readOnlineStatus(null)).toBe(true);
  });

  it("subscribes to both connectivity events and cleans them up", () => {
    const target = new TestOnlineStatusTarget();
    const onStoreChange = vi.fn();
    const unsubscribe = subscribeToOnlineStatus(onStoreChange, target);

    target.emit("offline");
    target.emit("online");
    expect(onStoreChange).toHaveBeenCalledTimes(2);

    unsubscribe();
    target.emit("offline");
    target.emit("online");
    expect(onStoreChange).toHaveBeenCalledTimes(2);
  });
});
