"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import {
  CheckboxListField,
  NumberField,
  SelectField,
  SwitchField,
  TextInputField,
} from "@/components/admin/fields";
import { FormSection } from "@/components/admin/page-header";
import { WorkingHoursEditor } from "@/components/admin/working-hours-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SettingsOf } from "@/features/settings/schema";
import { SettingsForm } from "../settings-form";

const reminderChoices = ["1", "2", "4", "12", "24", "48", "72"] as const;
const longDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeZone: "UTC" });

/** 04 §6 Viewings: slot rules, agency hours and holidays, video tool, reminders. */
export function ViewingsSettingsForm({
  initial,
  readOnly,
  firstDayOfWeek,
}: {
  initial: SettingsOf<"viewings">;
  readOnly: boolean;
  firstDayOfWeek: number;
}) {
  const [holiday, setHoliday] = useState("");
  return (
    <SettingsForm group="viewings" initial={initial} readOnly={readOnly}>
      {({ value, set, errorFor }) => (
        <>
          <FormSection title="Booking rules">
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                label="Viewing length"
                suffix="minutes"
                min={10}
                max={240}
                step={5}
                value={value.defaultLengthMin}
                onChange={(v) => set({ defaultLengthMin: v ?? 30 })}
                error={errorFor("defaultLengthMin")}
              />
              <NumberField
                label="Gap between viewings"
                suffix="minutes"
                min={0}
                max={120}
                step={5}
                value={value.bufferMin}
                onChange={(v) => set({ bufferMin: v ?? 0 })}
                error={errorFor("bufferMin")}
              />
              <NumberField
                label="Bookable up to"
                suffix="days ahead"
                min={1}
                max={180}
                step={1}
                value={value.bookingWindowDays}
                onChange={(v) => set({ bookingWindowDays: v ?? 30 })}
                error={errorFor("bookingWindowDays")}
              />
              <NumberField
                label="Minimum notice"
                suffix="hours"
                min={0}
                max={168}
                step={1}
                value={value.minNoticeHours}
                onChange={(v) => set({ minNoticeHours: v ?? 0 })}
                error={errorFor("minNoticeHours")}
              />
            </div>
          </FormSection>

          <FormSection
            title="Agency hours"
            description="Viewing slots are offered inside these hours. Agents can have their own."
          >
            <WorkingHoursEditor
              value={value.workingHours}
              onChange={(workingHours) => set({ workingHours })}
              firstDayOfWeek={firstDayOfWeek}
              error={errorFor("workingHours")}
            />
          </FormSection>

          <FormSection title="Holidays" description="No viewings are offered on these dates.">
            {value.holidays.length > 0 && (
              <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {[...value.holidays].sort().map((d) => (
                  <li
                    key={d}
                    className="flex items-center justify-between gap-2 px-3 py-1.5 text-[13px]"
                  >
                    <span>{longDate.format(new Date(`${d}T00:00:00Z`))}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${d}`}
                      onClick={() => set({ holidays: value.holidays.filter((x) => x !== d) })}
                    >
                      <XIcon />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-end gap-2">
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink">
                Add a date
                <Input
                  type="date"
                  value={holiday}
                  onChange={(e) => setHoliday(e.target.value)}
                  className="w-44"
                />
              </label>
              <Button
                type="button"
                variant="outline"
                disabled={
                  !holiday || value.holidays.includes(holiday) || value.holidays.length >= 60
                }
                onClick={() => {
                  set({ holidays: [...value.holidays, holiday] });
                  setHoliday("");
                }}
              >
                <PlusIcon /> Add
              </Button>
            </div>
            {errorFor("holidays") && (
              <p role="alert" className="text-[12.5px] font-medium text-danger">
                {errorFor("holidays")}
              </p>
            )}
          </FormSection>

          <FormSection title="Google Calendar booking">
            <TextInputField
              label="Booking page link"
              description={
                <>
                  In Google Calendar choose Create, then Appointment schedule, set your hours and
                  save. Open the schedule, choose Share, then Website embed, and paste the link from
                  the code here (it starts with
                  https://calendar.google.com/calendar/appointments/schedules/). &quot;Book a
                  tour&quot; then shows that booking page; leave it empty to use the times above.
                </>
              }
              type="url"
              placeholder="https://calendar.google.com/calendar/appointments/schedules/…"
              value={value.googleBookingUrl}
              onChange={(googleBookingUrl) => set({ googleBookingUrl: googleBookingUrl.trim() })}
              error={errorFor("googleBookingUrl")}
            />
          </FormSection>

          <FormSection title="Video viewings">
            <SelectField
              label="Video tool"
              value={value.videoTool}
              onChange={(videoTool) => set({ videoTool })}
              options={[
                { value: "whatsapp", label: "WhatsApp video call" },
                { value: "google_meet", label: "Google Meet (link made with the calendar event)" },
                { value: "zoom", label: "Zoom (one fixed meeting link)" },
              ]}
            />
            {value.videoTool === "zoom" && (
              <TextInputField
                label="Zoom meeting link"
                type="url"
                placeholder="https://"
                value={value.zoomLink}
                onChange={(zoomLink) => set({ zoomLink: zoomLink.trim() })}
                error={errorFor("zoomLink")}
              />
            )}
          </FormSection>

          <FormSection title="Reminders">
            <CheckboxListField
              label="Remind the customer"
              description="Up to three reminders before the viewing."
              columns={3}
              value={
                value.reminders.customerHoursBefore.map(String) as Array<
                  (typeof reminderChoices)[number]
                >
              }
              onChange={(v) => {
                const hours = v
                  .map(Number)
                  .sort((a, b) => b - a)
                  .slice(0, 3);
                set({ reminders: { ...value.reminders, customerHoursBefore: hours } });
              }}
              options={reminderChoices.map((h) => ({
                value: h,
                label: h === "1" ? "1 hour before" : `${h} hours before`,
              }))}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <SwitchField
                label="By email"
                checked={value.reminders.customerEmail}
                onChange={(customerEmail) =>
                  set({ reminders: { ...value.reminders, customerEmail } })
                }
              />
              <SwitchField
                label="By WhatsApp"
                checked={value.reminders.customerWhatsapp}
                onChange={(customerWhatsapp) =>
                  set({ reminders: { ...value.reminders, customerWhatsapp } })
                }
              />
            </div>
            <NumberField
              label="Remind the agent"
              suffix="hours before (0 = no reminder)"
              min={0}
              max={48}
              step={1}
              value={value.reminders.agentHoursBefore}
              onChange={(v) => set({ reminders: { ...value.reminders, agentHoursBefore: v ?? 0 } })}
              error={errorFor("reminders.agentHoursBefore")}
            />
          </FormSection>
        </>
      )}
    </SettingsForm>
  );
}
