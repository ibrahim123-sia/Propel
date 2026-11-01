import { describe, expect, it } from "vitest";
import { claimsHandover } from "@/features/ai/assistant/customer";

describe("an answer that promises the team will reply", () => {
  it("is caught in the ways models say it", () => {
    for (const text of [
      "Sure, I’ll pass this on to our team.",
      "Good question for our team. I've asked Layla to reply to you, our agent will be in touch.",
      "I have asked our team to reply to you.",
      "I will let one of our agents know.",
      "I've forwarded your request to the team.",
    ])
      expect(claimsHandover(text), text).toBe(true);
  });

  it("is not confused with offers or plain answers", () => {
    for (const text of [
      "Would you like me to connect you with our team?",
      "Our team can arrange a viewing on Saturday.",
      "I couldn't find a home like that in our listings. Shall I ask the team to look?",
      "Here are three homes in Dubai Marina.",
    ])
      expect(claimsHandover(text), text).toBe(false);
  });
});
