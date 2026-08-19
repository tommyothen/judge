/** Vote windows offered anywhere a duration can be chosen, in minutes. */
export const DURATION_CHOICES = [10, 60, 360, 1440, 4320, 10080] as const;

export function isDurationChoice(value: number): boolean {
  return (DURATION_CHOICES as readonly number[]).includes(value);
}

export function humanDuration(minutes: number): string {
  if (minutes === 60) return '1 hour';
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? '24 hours' : `${days} days`;
  }
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}
