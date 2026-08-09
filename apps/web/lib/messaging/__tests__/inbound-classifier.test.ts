import { describe, expect, it } from "vitest";
import { classifyInboundSms } from "../inbound";

describe("classifyInboundSms", () => {
  it.each([
    "STOP",
    " stop! ",
    "UNSUBSCRIBE",
    "please stop texting me",
    "Kindly stop messaging me.",
    "do not text me",
    "don't send me text messages",
    "don’t text me",
    "stop texting",
    "stop sending me texts",
    "stop sending me messages",
    "no more texts",
    "remove me from your text list",
    "take me off the SMS list",
    "unsubscribe me from SMS messages",
  ])("classifies an unambiguous opt-out: %s", (text) => {
    expect(classifyInboundSms(text)).toBe("stop");
  });

  it.each(["START", "yes", "UNSTOP!"])(
    "classifies an exact opt-in keyword: %s",
    (text) => {
      expect(classifyInboundSms(text)).toBe("start");
    }
  );

  it.each(["HELP", "info!"])("classifies exact HELP: %s", (text) => {
    expect(classifyInboundSms(text)).toBe("help");
  });

  it.each([
    "do not stop texting me",
    "please stop by tomorrow",
    "can you help me reschedule?",
    "I said start next week",
    "stopping in at 3",
    "do not stop sending me messages",
    "I don't want you to stop texting",
    "no more texts?",
    "can you remove me from your text list?",
  ])("does not guess at ambiguous conversation: %s", (text) => {
    expect(classifyInboundSms(text)).toBe("other");
  });
});
