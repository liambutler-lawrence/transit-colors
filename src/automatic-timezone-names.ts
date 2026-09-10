import { z } from 'zod';
import type { AutomaticRegion } from './automatic-timezones.js';
import { PolygonHitIndex } from './polygon-hit-index.js';

export const automaticTimezoneNameSchema = z.object({
  timezone_name: z.string().regex(/^[A-Za-z]+\/[A-Za-z0-9_-]+$/),
  metro_name: z.string().nullable(),
  population: z.number().nonnegative().nullable(),
  coordinates: z.tuple([z.number(), z.number()]).nullable(),
  source: z.string().nullable(),
  place_id: z.string().nullable(),
  method: z.enum(['metro', 'settlement', 'administrative-fallback']),
});

export type AutomaticTimezoneName = z.infer<typeof automaticTimezoneNameSchema>;
export interface TimezoneNamingPlace {
  readonly id: string;
  readonly name: string;
  readonly asciiName: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly population: number;
  readonly countryCode: string;
  readonly timezone: string;
  readonly source: string;
}

const AREAS = new Set([
  'Africa',
  'America',
  'Antarctica',
  'Asia',
  'Atlantic',
  'Australia',
  'Europe',
  'Indian',
  'Pacific',
]);

function areaOf(place: TimezoneNamingPlace): string | undefined {
  const area = place.timezone.split('/')[0];
  return area && AREAS.has(area) ? area : undefined;
}

export function timezoneNameSegment(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[Łł]/g, 'l')
    .replace(/[Øø]/g, 'o')
    .replace(/[’']/g, '')
    .replace(/[^A-Za-z0-9-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function preferred(left: TimezoneNamingPlace, right: TimezoneNamingPlace): boolean {
  return (
    left.population > right.population ||
    (left.population === right.population &&
      (left.asciiName < right.asciiName ||
        (left.asciiName === right.asciiName && left.id < right.id)))
  );
}

/** Names only: callers supply the terminal administrative regions already resolved
 * by the UTC algorithm. Metro centers never split, merge, or change their offsets.
 * The supplementary gazetteer fills regions missing a primary populated place;
 * city-proper counts do not compete against primary metropolitan estimates.
 */
export function nameAutomaticTimezoneRegions(
  regions: readonly AutomaticRegion[],
  primary: readonly TimezoneNamingPlace[],
  secondary: readonly TimezoneNamingPlace[],
  countryAreas: ReadonlyMap<string, string> = new Map(),
): Map<string, AutomaticTimezoneName> {
  const winners = new Map<string, TimezoneNamingPlace>();
  function select(
    places: readonly TimezoneNamingPlace[],
    candidates: readonly AutomaticRegion[],
  ): void {
    const countries = new Set(candidates.map((r) => r.country_code));
    const index = new PolygonHitIndex(
      candidates.map((region) => ({
        polygons: region.geometry.coordinates,
        value: region,
      })),
    );
    for (const place of places) {
      if (!countries.has(place.countryCode)) continue;
      const region = index.find(
        place.longitude,
        place.latitude,
        (r) => r.country_code === place.countryCode,
      );
      if (!region) continue;
      const previous = winners.get(region.id);
      if (!previous || preferred(place, previous)) winners.set(region.id, place);
    }
  }
  const inhabitedCandidates = regions.filter((r) => !r.coverage_note);
  select(primary, inhabitedCandidates);
  select(
    secondary,
    inhabitedCandidates.filter((r) => !winners.has(r.id)),
  );

  // Prefixes describe geography, never the simulated UTC offset. Prefer the
  // place's existing IANA area; a missing area can borrow a nearby same-country
  // place's area, but never its city name.
  const areaPlaces = [...primary, ...secondary].filter((p) => areaOf(p));
  const byCountry = new Map<string, TimezoneNamingPlace[]>();
  for (const place of areaPlaces) {
    const group = byCountry.get(place.countryCode) ?? [];
    group.push(place);
    byCountry.set(place.countryCode, group);
  }
  function areaFor(
    region: AutomaticRegion,
    place: TimezoneNamingPlace | undefined,
  ): string {
    if (!place) return 'Etc';
    const ownArea = areaOf(place);
    if (ownArea) return ownArea;
    const anchor: readonly [number, number] = [place.longitude, place.latitude];
    let nearest: TimezoneNamingPlace | undefined;
    let distance = Infinity;
    for (const candidate of byCountry.get(region.country_code) ?? []) {
      const dx = ((candidate.longitude - anchor[0] + 540) % 360) - 180;
      const dy = candidate.latitude - anchor[1];
      const squared = (dx * Math.cos((anchor[1] * Math.PI) / 180)) ** 2 + dy ** 2;
      if (
        squared < distance ||
        (squared === distance && candidate.id < (nearest?.id ?? ''))
      ) {
        nearest = candidate;
        distance = squared;
      }
    }
    return (
      (nearest && areaOf(nearest)) ?? countryAreas.get(region.country_code) ?? 'Etc'
    );
  }
  const names = new Map<string, AutomaticTimezoneName>();
  const groups = new Map<string, AutomaticRegion[]>();
  for (const region of regions) {
    const place = winners.get(region.id);
    const segment =
      timezoneNameSegment(place?.asciiName || region.name) ||
      timezoneNameSegment(region.id);
    const name = `${areaFor(region, place)}/${segment}`;
    names.set(region.id, {
      timezone_name: name,
      metro_name: place?.name ?? null,
      population: place?.population ?? null,
      coordinates: place ? [place.longitude, place.latitude] : null,
      source: place?.source ?? null,
      place_id: place?.id ?? null,
      method: place
        ? place.source === 'natural-earth-populated-places' &&
          place.population >= 50_000
          ? 'metro'
          : 'settlement'
        : 'administrative-fallback',
    });
    const group = groups.get(name) ?? [];
    group.push(region);
    groups.set(name, group);
  }
  // Preserve an existing Area/City spelling for its matching metro. Otherwise
  // qualify homonyms by their administrative region, deterministically.
  const occupied = new Set(groups.keys());
  for (const [base, group] of [...groups].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const canonical = ordered.find((r) => winners.get(r.id)?.timezone === base);
    for (const region of ordered) {
      if (region === canonical) continue;
      const suffix = timezoneNameSegment(
        region.iso_code || `${region.country_code}_${region.name}`,
      );
      let name = `${base}_${suffix}`;
      if (occupied.has(name)) name += `_${timezoneNameSegment(region.id)}`;
      if (occupied.has(name))
        throw new Error(`Duplicate automatic timezone name: ${name}`);
      occupied.add(name);
      const entry = names.get(region.id);
      if (!entry) throw new Error(`Missing automatic timezone name: ${region.id}`);
      entry.timezone_name = name;
    }
  }
  return names;
}
