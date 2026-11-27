import { describe, expect, it } from "vitest";
import { googleBookingEmbedUrl, isGoogleBookingUrl } from "@/features/viewings/google-booking";
import { viewingsSchema } from "@/features/settings/schema";

const full = "https://calendar.google.com/calendar/appointments/schedules/AcZssZ1abc-DEF_2";

describe("Google Calendar booking page", () => {
  it("accepts appointment schedule links only", () => {
    expect(isGoogleBookingUrl(full)).toBe(true);
    expect(
      isGoogleBookingUrl(full.replace("calendar/appointments", "calendar/u/1/appointments")),
    ).toBe(true);
    expect(isGoogleBookingUrl("https://calendar.app.google/Xy12AbCd")).toBe(true);
    expect(isGoogleBookingUrl("https://calendar.google.com/calendar/r")).toBe(false);
    expect(
      isGoogleBookingUrl(
        "https://evil.example/calendar.google.com/calendar/appointments/schedules/x",
      ),
    ).toBe(false);
    expect(isGoogleBookingUrl("http://calendar.google.com/calendar/appointments/schedules/x")).toBe(
      false,
    );
  });

  it("embeds full links with Google's embed flag; short links open on Google", () => {
    expect(googleBookingEmbedUrl(full)).toBe(`${full}?gv=true`);
    expect(googleBookingEmbedUrl(`${full}?gv=true`)).toBe(`${full}?gv=true`);
    expect(googleBookingEmbedUrl("https://calendar.app.google/Xy12AbCd")).toBeNull();
  });

  it("is optional in Settings -> Viewings", () => {
    expect(viewingsSchema.parse({}).googleBookingUrl).toBe("");
    expect(viewingsSchema.safeParse({ googleBookingUrl: "https://example.com" }).success).toBe(
      false,
    );
    expect(viewingsSchema.parse({ googleBookingUrl: full }).googleBookingUrl).toBe(full);
  });
});
