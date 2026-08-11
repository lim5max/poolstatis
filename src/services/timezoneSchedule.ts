export interface ZonedCadence {
  timezone: string;
  frequency: 'daily' | 'weekly';
  localTime: string;
  /** JavaScript weekday: Sunday=0, Monday=1, … Saturday=6. */
  weekday: number | null;
}

export interface ZonedOccurrence {
  scheduledAt: Date;
  localRunKey: string;
  resolution: 'exact' | 'dst_shifted';
}

interface LocalMinute {
  date: string;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function nextZonedOccurrence(cadence: ZonedCadence, after: Date): ZonedOccurrence {
  const match = /^(\d{2}):(\d{2})$/.exec(cadence.localTime);
  if (!match) throw new Error('local time must use HH:mm');
  const target = Number(match[1]) * 60 + Number(match[2]);
  if (target < 0 || target >= 24 * 60) throw new Error('local time must use a valid HH:mm');
  if (cadence.frequency === 'weekly' && (cadence.weekday === null || cadence.weekday < 0 || cadence.weekday > 6)) {
    throw new Error('weekly cadence requires weekday 0..6');
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: cadence.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
    formatter.format(after);
  } catch {
    throw new Error(`invalid timezone "${cadence.timezone}"`);
  }

  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  let previous: LocalMinute | null = null;
  for (let offset = 0; offset <= 8 * 24 * 60; offset += 1) {
    const instant = new Date(start + offset * 60_000);
    const local = localMinute(formatter, instant);
    const eligible = cadence.frequency === 'daily' || local.weekday === cadence.weekday;
    const wallMinute = local.hour * 60 + local.minute;
    if (eligible && wallMinute === target) {
      return { scheduledAt: instant, localRunKey: local.date, resolution: 'exact' };
    }
    if (eligible && previous?.date === local.date && previous.weekday === local.weekday) {
      const previousWallMinute = previous.hour * 60 + previous.minute;
      if (previousWallMinute < target && wallMinute > target) {
        return { scheduledAt: instant, localRunKey: local.date, resolution: 'dst_shifted' };
      }
    }
    previous = local;
  }
  throw new Error('could not resolve the next scheduled occurrence within eight days');
}

function localMinute(formatter: Intl.DateTimeFormat, instant: Date): LocalMinute {
  const parts = Object.fromEntries(
    formatter.formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const weekday = WEEKDAYS[parts.weekday ?? ''];
  if (weekday === undefined || !parts.year || !parts.month || !parts.day || !parts.hour || !parts.minute) {
    throw new Error('timezone formatter returned an incomplete local minute');
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday,
  };
}
