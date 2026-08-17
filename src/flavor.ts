export interface Tier {
  key: string;
  /** Inclusive lower bound. The last tier catches everything below the rest. */
  min: number;
  title: string;
  /** Role colour, as Discord wants it: a plain integer. */
  color: number;
}

/**
 * Standing, best to worst. This is both the board title and, when the guild
 * runs roles, the name and colour of the role the member wears.
 */
export const TIERS: Tier[] = [
  { key: 'model_citizen', min: 10, title: 'Model citizen', color: 0xe3b341 },
  { key: 'upstanding', min: 5, title: 'Upstanding member of society', color: 0x3fa45b },
  { key: 'mostly_harmless', min: 1, title: 'Mostly harmless', color: 0x8fcb9b },
  { key: 'clean', min: 0, title: 'Clean record', color: 0x9aa0a6 },
  { key: 'nuisance', min: -4, title: 'Known nuisance', color: 0xe08d3c },
  { key: 'repeat_offender', min: -9, title: 'Repeat offender', color: 0xc05621 },
  { key: 'menace', min: -19, title: 'Menace to society', color: 0xb63d3d },
  { key: 'beyond', min: -Infinity, title: 'Beyond rehabilitation', color: 0x7f1d1d },
];

export function tierFor(points: number): Tier {
  for (const tier of TIERS) {
    if (points >= tier.min) return tier;
  }
  return TIERS[TIERS.length - 1];
}

export function titleFor(points: number): string {
  return tierFor(points).title;
}
