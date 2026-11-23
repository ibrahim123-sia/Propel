"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { format } from "@/lib/i18n";
import { viewings as t } from "@/lib/i18n/dictionaries/viewings";

type SlotData = { timeZone: string; slots: string[] };

const visitorZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

/** YYYY-MM-DD in a time zone: the value a date input uses. */
const dayKey = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
const dayLabel = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(iso));
const timeLabel = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );

const field =
  "h-11 w-full rounded-input border border-input bg-surface px-3 text-[15px] text-ink focus-visible:outline-2 focus-visible:outline-accent";

/**
 * Free viewing times (09 §5) with the browser's own controls: its date picker for the day and
 * a list of that day's free times, in the visitor's time zone (the agency's time in brackets
 * when it differs). The date picker cannot grey out single days, so a day without free times
 * says so and offers the next free one. `source` is the query for /api/viewings/slots.
 */
export function SlotPicker({
  source,
  value,
  onChange,
  reloadKey = 0,
  error,
}: {
  source: string;
  value: string | null;
  onChange: (start: string | null) => void;
  /** Change it to fetch the free times again (after a time was taken). */
  reloadKey?: number;
  error?: string;
}) {
  const id = useId();
  const [data, setData] = useState<SlotData | null>(null);
  const [failed, setFailed] = useState(false);
  const [day, setDay] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/viewings/slots?${source}`, { signal: ctl.signal })
      .then((r) =>
        r.ok ? (r.json() as Promise<SlotData>) : Promise.reject(new Error(String(r.status))),
      )
      .then((d) => {
        setData(d);
        setFailed(false);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") setFailed(true);
      });
    return () => ctl.abort();
  }, [source, reloadKey]);

  const zone = useMemo(() => visitorZone() ?? data?.timeZone ?? "UTC", [data]);
  const days = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of data?.slots ?? []) {
      const key = dayKey(s, zone);
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return map;
  }, [data, zone]);

  if (failed) return <p className="text-[14px] text-danger">{t.booking.failed}</p>;
  if (!data) return <p className="text-[14px] text-text-muted">{t.booking.loading}</p>;
  const keys = [...days.keys()].sort();
  if (keys.length === 0) return <p className="text-[14px] text-text-muted">{t.booking.none}</p>;

  const selectedDay = day ?? keys[0]!;
  const times = days.get(selectedDay) ?? [];
  const nextFree = times.length ? null : (keys.find((k) => k > selectedDay) ?? keys[0]!);
  const showAgency =
    zone !== data.timeZone && times.some((s) => timeLabel(s, zone) !== timeLabel(s, data.timeZone));
  const pickDay = (key: string) => {
    setDay(key);
    onChange(null);
  };

  return (
    <div className="flex flex-col gap-3">
      {showAgency && (
        <p className="text-[13px] text-text-muted">
          {format(t.booking.yourTime, {
            zone: zone.split("/").at(-1)!.replace(/_/g, " "),
            agency: data.timeZone.split("/").at(-1)!.replace(/_/g, " "),
          })}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5" htmlFor={`${id}-day`}>
          <span className="text-[14px] font-semibold text-ink">{t.booking.dayLabel}</span>
          <input
            id={`${id}-day`}
            type="date"
            className={field}
            min={keys[0]}
            max={keys.at(-1)}
            value={selectedDay}
            onChange={(e) => e.target.value && pickDay(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5" htmlFor={`${id}-time`}>
          <span className="text-[14px] font-semibold text-ink">{t.booking.timeLabel}</span>
          <select
            id={`${id}-time`}
            className={field}
            disabled={times.length === 0}
            value={value && times.includes(value) ? value : ""}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">{t.booking.pickTimePlaceholder}</option>
            {times.map((s) => (
              <option key={s} value={s}>
                {timeLabel(s, zone)}
                {showAgency ? ` (${timeLabel(s, data.timeZone)})` : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {nextFree && (
        <div
          className="flex flex-wrap items-center gap-2 text-[14px] text-text-muted"
          role="status"
        >
          <span>
            {t.booking.noTimesThatDay}{" "}
            {format(t.booking.nextFree, { day: dayLabel(days.get(nextFree)![0]!, zone) })}
          </span>
          <Button type="button" variant="outline-site" size="sm" onClick={() => pickDay(nextFree)}>
            {format(t.booking.useNextFree, { day: dayLabel(days.get(nextFree)![0]!, zone) })}
          </Button>
        </div>
      )}
      {error && <p className="text-[13px] font-medium text-danger">{error}</p>}
    </div>
  );
}

export { visitorZone };
