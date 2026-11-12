"use client";

import { AdminField, ListField, SelectField, SwitchField } from "@/components/admin/fields";
import { FormSection } from "@/components/admin/page-header";
import { Input } from "@/components/ui/input";
import {
  notificationEvents,
  type NotificationEvent,
  type SettingsOf,
} from "@/features/settings/schema";
import { reports as rt } from "@/lib/i18n/dictionaries/reports";
import { SettingsForm } from "../settings-form";

const weekdayOptions = rt.settings.weekdays.map((label, i) => ({ value: String(i), label }));
const hourOptions = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${String(h).padStart(2, "0")}:00`,
}));

const eventLabels: Record<NotificationEvent, string> = {
  newLead: "New lead",
  leadNotAnswered: "Lead not answered in time",
  newViewing: "New viewing",
  viewingCancelled: "Viewing cancelled",
  dailySummary: "Daily summary",
  weeklyReport: "Weekly report",
  integrationError: "An integration stopped working",
};

type Audience = "admins" | "agents";
type Channel = "email" | "whatsapp";
const columns: Array<[Audience, Channel, string]> = [
  ["admins", "email", "Admins: email"],
  ["admins", "whatsapp", "Admins: WhatsApp"],
  ["agents", "email", "Agent: email"],
  ["agents", "whatsapp", "Agent: WhatsApp"],
];

/** 04 §10 Notifications: which events reach admins and the assigned agent, and how. */
export function NotificationsSettingsForm({
  initial,
  readOnly,
}: {
  initial: SettingsOf<"notifications">;
  readOnly: boolean;
}) {
  return (
    <SettingsForm group="notifications" initial={initial} readOnly={readOnly}>
      {({ value, set, errorFor }) => (
        <>
          <FormSection
            title="Who is told about what"
            description="Admins get alerts at the addresses in Settings -> Contact; agents at the email and WhatsApp on their profile."
          >
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-[12px] text-text-muted">
                    <th scope="col" className="py-2 pe-3 text-start font-semibold">
                      Event
                    </th>
                    {columns.map(([, , label]) => (
                      <th key={label} scope="col" className="px-2 py-2 text-center font-semibold">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {notificationEvents.map((event) => (
                    <tr key={event} className="border-b border-border last:border-0">
                      <th scope="row" className="py-2 pe-3 text-start font-medium text-ink">
                        {eventLabels[event]}
                      </th>
                      {columns.map(([audience, channel, label]) => (
                        <td key={label} className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--color-accent)]"
                            aria-label={`${eventLabels[event]}, ${label}`}
                            checked={value[audience][event][channel]}
                            onChange={(e) =>
                              set({
                                [audience]: {
                                  ...value[audience],
                                  [event]: {
                                    ...value[audience][event],
                                    [channel]: e.target.checked,
                                  },
                                },
                              } as Partial<SettingsOf<"notifications">>)
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </FormSection>

          <FormSection title="Daily summary">
            <AdminField
              label="Sent at"
              description="In the agency's time zone."
              error={errorFor("dailySummaryTime")}
            >
              <Input
                type="time"
                aria-label="Daily summary time"
                className="w-32"
                value={value.dailySummaryTime}
                onChange={(e) => set({ dailySummaryTime: e.target.value })}
              />
            </AdminField>
          </FormSection>

          <FormSection title={rt.settings.title} description={rt.settings.description}>
            <SwitchField
              label={rt.settings.enabled}
              checked={value.weeklyReport.enabled}
              onChange={(enabled) => set({ weeklyReport: { ...value.weeklyReport, enabled } })}
              error={errorFor("weeklyReport.enabled")}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label={rt.settings.weekday}
                value={String(value.weeklyReport.weekday)}
                options={weekdayOptions}
                onChange={(v) =>
                  set({ weeklyReport: { ...value.weeklyReport, weekday: Number(v) } })
                }
                error={errorFor("weeklyReport.weekday")}
              />
              <SelectField
                label={rt.settings.hour}
                value={String(value.weeklyReport.hour)}
                options={hourOptions}
                onChange={(v) => set({ weeklyReport: { ...value.weeklyReport, hour: Number(v) } })}
                error={errorFor("weeklyReport.hour")}
              />
            </div>
            <ListField
              label={rt.settings.recipients}
              description={rt.settings.recipientsHint}
              placeholder="name@example.com, then Enter"
              max={20}
              value={value.weeklyReport.recipients}
              onChange={(recipients) =>
                set({ weeklyReport: { ...value.weeklyReport, recipients } })
              }
              error={errorFor("weeklyReport.recipients")}
            />
          </FormSection>
        </>
      )}
    </SettingsForm>
  );
}
