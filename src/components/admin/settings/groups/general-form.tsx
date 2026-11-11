"use client";

import {
  NumberField,
  SelectField,
  SwitchField,
  TextInputField,
  TextareaField,
} from "@/components/admin/fields";
import { MediaPicker } from "@/components/admin/media/media-picker";
import { FormSection } from "@/components/admin/page-header";
import type { SettingsOf } from "@/features/settings/schema";
import { SettingsForm } from "../settings-form";

const dateFormats = [
  { value: "d MMM yyyy", label: "20 Oct 2026" },
  { value: "dd/MM/yyyy", label: "20/10/2026" },
  { value: "MM/dd/yyyy", label: "10/20/2026" },
  { value: "yyyy-MM-dd", label: "2026-10-20" },
] as const;

/** 04 §1 General. */
export function GeneralSettingsForm({
  initial,
  readOnly,
  timeZones,
}: {
  initial: SettingsOf<"general">;
  readOnly: boolean;
  timeZones: string[];
}) {
  return (
    <SettingsForm group="general" initial={initial} readOnly={readOnly}>
      {({ value, set, errorFor }) => (
        <>
          <FormSection title="Agency" description="Used in the footer, emails and search results.">
            <TextInputField
              label="Agency name"
              required
              maxLength={120}
              value={value.agencyName}
              onChange={(agencyName) => set({ agencyName })}
              error={errorFor("agencyName")}
            />
            <TextInputField
              label="Legal name"
              value={value.legalName}
              onChange={(legalName) => set({ legalName })}
              error={errorFor("legalName")}
            />
            <TextareaField
              label="Short description"
              rows={2}
              maxLength={300}
              value={value.shortDescription}
              onChange={(shortDescription) => set({ shortDescription })}
              error={errorFor("shortDescription")}
            />
            <TextInputField
              label="Listing reference prefix"
              description={`New listings get references like ${value.referencePrefix || "LT"}-1001.`}
              maxLength={5}
              value={value.referencePrefix}
              onChange={(v) => set({ referencePrefix: v.toUpperCase().replace(/[^A-Z]/g, "") })}
              error={errorFor("referencePrefix")}
            />
            <TextInputField
              label="Licence or registration number"
              description="Shown in the footer."
              value={value.licenceNumber}
              onChange={(licenceNumber) => set({ licenceNumber })}
              error={errorFor("licenceNumber")}
            />
          </FormSection>

          <FormSection title="Logos and icons">
            <div className="grid gap-5 sm:grid-cols-2">
              <MediaPicker
                label="Logo for light backgrounds"
                value={value.logoLightId}
                onChange={(logoLightId) => set({ logoLightId })}
                error={errorFor("logoLightId")}
              />
              <MediaPicker
                label="Logo for dark backgrounds"
                value={value.logoDarkId}
                onChange={(logoDarkId) => set({ logoDarkId })}
                error={errorFor("logoDarkId")}
              />
              <MediaPicker
                label="Favicon"
                description="Square, at least 48×48 (SVG or PNG)."
                value={value.faviconId}
                onChange={(faviconId) => set({ faviconId })}
                error={errorFor("faviconId")}
              />
              <MediaPicker
                label="App icon"
                description="Square PNG, at least 512×512 (home screen icon)."
                value={value.appIconId}
                onChange={(appIconId) => set({ appIconId })}
                error={errorFor("appIconId")}
              />
            </div>
          </FormSection>

          <FormSection title="Region and language">
            <TextInputField
              label="Time zone"
              description="Schedules (daily summaries, reminders) run in this time zone."
              value={value.timeZone}
              suggestions={timeZones}
              onChange={(timeZone) => set({ timeZone })}
              error={errorFor("timeZone")}
            />
            <SelectField
              label="Date format"
              value={value.dateFormat}
              onChange={(dateFormat) => set({ dateFormat })}
              options={dateFormats.map((f) => ({ value: f.value, label: f.label }))}
            />
            <SelectField
              label="First day of the week"
              value={String(value.firstDayOfWeek) as "0" | "1" | "6"}
              onChange={(v) => set({ firstDayOfWeek: Number(v) as 0 | 1 | 6 })}
              options={[
                { value: "1", label: "Monday" },
                { value: "6", label: "Saturday" },
                { value: "0", label: "Sunday" },
              ]}
            />
            <SelectField
              label="Default language"
              value={value.defaultLanguage}
              onChange={(defaultLanguage) => set({ defaultLanguage })}
              options={[{ value: "en", label: "English" }]}
            />
            <SwitchField
              label="Right-to-left layout"
              description="Available once a right-to-left language is added."
              checked={value.rtl}
              onChange={(rtl) => set({ rtl })}
              disabled
            />
          </FormSection>

          <FormSection title="Uploads">
            <NumberField
              label="Largest upload"
              suffix="MB per file"
              min={1}
              max={100}
              step={1}
              value={value.maxUploadMb}
              onChange={(v) => set({ maxUploadMb: v ?? 20 })}
              error={errorFor("maxUploadMb")}
            />
          </FormSection>

          <FormSection
            title="Website header"
            description="The main button at the top of every page, e.g. “List your property”. Leave it empty to hide the button."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInputField
                label="Button text"
                maxLength={40}
                value={value.headerButton.label}
                onChange={(label) => set({ headerButton: { ...value.headerButton, label } })}
                error={errorFor("headerButton.label")}
              />
              <TextInputField
                label="Button link"
                placeholder="/contact"
                maxLength={300}
                value={value.headerButton.href}
                onChange={(href) => set({ headerButton: { ...value.headerButton, href } })}
                error={errorFor("headerButton.href")}
              />
            </div>
          </FormSection>

          <FormSection
            title="Maintenance mode"
            description="Visitors see a short message instead of the site. Signed-in admins can still browse it."
          >
            <SwitchField
              label="Site in maintenance mode"
              checked={value.maintenanceMode}
              onChange={(maintenanceMode) => set({ maintenanceMode })}
            />
            <TextareaField
              label="Message for visitors"
              rows={2}
              maxLength={500}
              value={value.maintenanceMessage}
              onChange={(maintenanceMessage) => set({ maintenanceMessage })}
              error={errorFor("maintenanceMessage")}
            />
          </FormSection>
        </>
      )}
    </SettingsForm>
  );
}
