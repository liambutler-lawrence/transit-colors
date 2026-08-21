import { z } from 'zod';

export const landUseCategorySchema = z.enum([
  'vacant_industrial',
  'vacant_other',
  'industrial_active',
  'retail_auto',
  'commercial_active',
  'mixed_use_modern',
  'mixed_use_historic',
  'tower_no_retail',
  'housing',
  'civic_open_space',
  'other',
]);

export type LandUseCategory = z.infer<typeof landUseCategorySchema>;

export const LAND_USE_CATEGORIES: readonly {
  readonly color: string;
  readonly description: string;
  readonly key: LandUseCategory;
  readonly label: string;
}[] = [
  {
    key: 'vacant_industrial',
    label: 'Vacant · industrial zone',
    description: 'Vacant tax parcel in an industrial district or industrial use class.',
    color: '#d1495b',
  },
  {
    key: 'vacant_other',
    label: 'Vacant / parking lot',
    description: 'Other vacant land, surface parking, or an unimproved parcel.',
    color: '#b8a99a',
  },
  {
    key: 'industrial_active',
    label: 'Industrial · active',
    description: 'Improved industrial, warehouse, manufacturing, or logistics parcel.',
    color: '#665191',
  },
  {
    key: 'retail_auto',
    label: 'Retail · auto-oriented',
    description:
      'Active commercial parcel with parking, service-station, or strip-retail form.',
    color: '#f28e2b',
  },
  {
    key: 'commercial_active',
    label: 'Retail / commercial · active',
    description: 'Other active retail, office, hotel, or commercial parcel.',
    color: '#e9c949',
  },
  {
    key: 'mixed_use_modern',
    label: 'Mixed-use · modern',
    description: 'Housing plus commercial space outside the historic classification.',
    color: '#12a594',
  },
  {
    key: 'mixed_use_historic',
    label: 'Mixed-use · historic',
    description:
      'Housing plus commercial space in a historic district or a pre-1946 building.',
    color: '#2f78a8',
  },
  {
    key: 'tower_no_retail',
    label: 'Housing / office tower · no retail',
    description:
      'Eight or more stories without commercial space in the tax description.',
    color: '#687582',
  },
  {
    key: 'housing',
    label: 'Housing · neighborhood',
    description: 'Active residential parcel below the tower threshold.',
    color: '#6aaa64',
  },
  {
    key: 'civic_open_space',
    label: 'Civic / school / open space',
    description: 'Public, educational, religious, cemetery, medical, or park parcel.',
    color: '#79a7c3',
  },
  {
    key: 'other',
    label: 'Rail / utility / other',
    description: 'Parcel not supported by enough evidence for a more specific class.',
    color: '#8e969c',
  },
];

export function isLandUseCategory(value: unknown): value is LandUseCategory {
  return landUseCategorySchema.safeParse(value).success;
}

export function landUseCategoryDetails(category: LandUseCategory): {
  readonly color: string;
  readonly description: string;
  readonly key: LandUseCategory;
  readonly label: string;
} {
  const details = LAND_USE_CATEGORIES.find(({ key }) => key === category);
  if (!details) throw new Error(`Unknown land-use category: ${category}`);
  return details;
}

export const landUseStatusSchema = z.enum(['active', 'vacant', 'civic', 'other']);

export const landUsePropertiesSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    category: landUseCategorySchema,
    status: landUseStatusSchema,
    address: z.string(),
    block: z.string(),
    lot: z.string(),
    tax_class: z.string(),
    building: z.string(),
    zone_code: z.string(),
    zone_name: z.string(),
    zone_type: z.enum(['Redevelopment plan', 'Zoning district', 'Unmapped']),
    year_built: z.number().int().nonnegative(),
    stories: z.number().int().nonnegative(),
    historic: z.string(),
  })
  .loose();

export type LandUseProperties = z.infer<typeof landUsePropertiesSchema>;

export interface ParcelClassificationInput {
  readonly buildingDescription?: string | null;
  readonly historicDistrict?: string | null;
  readonly improvementValue?: string | number | null;
  readonly taxClass?: string | null;
  readonly yearBuilt?: string | number | null;
  readonly zoneCode?: string | null;
  readonly zoneName?: string | null;
}

export interface ParcelClassification {
  readonly category: LandUseCategory;
  readonly status: z.infer<typeof landUseStatusSchema>;
  readonly stories: number;
  readonly yearBuilt: number;
}

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

function positiveYear(value: string | number | null | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1700 && parsed <= 2100 ? parsed : 0;
}

export function storiesFromBuildingDescription(description: string): number {
  const storyCounts = [...description.toUpperCase().matchAll(/(\d+)\s*S\b/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  return storyCounts.length > 0 ? Math.max(...storyCounts) : 0;
}

export function classifyJerseyCityParcel(
  input: ParcelClassificationInput,
): ParcelClassification {
  const building = normalized(input.buildingDescription);
  const taxClass = normalized(input.taxClass);
  const zone = `${normalized(input.zoneCode)} ${normalized(input.zoneName)}`.trim();
  const yearBuilt = positiveYear(input.yearBuilt);
  const stories = storiesFromBuildingDescription(building);
  const improvementValue = Number(input.improvementValue ?? Number.NaN);

  const industrialEvidence =
    taxClass === '4B' ||
    /(?:^|[\s&+.-])(?:IND|IN)(?:$|[\s&+.-])|INDUSTR|WAREHOUSE|FACTORY|MANUF|LOGISTIC/.test(
      building,
    );
  const industrialZone =
    /^(?:I(?:-|\s|$)|PI(?:\s|$))/.test(zone) || zone.includes('INDUSTRIAL');
  const parkingOrAutoRetail =
    /PARKING|PAVED PARK|STRIP\s*MAL|SHOPPING|SERV\.?\s*STA|SERVICE STATION|GAS STATION|CAR WASH|MOTEL|AUTO/.test(
      building,
    );
  const residentialUnits = /\d+\s*U\b|RESI|APART|CONDO/.test(building);
  const commercialSpace =
    /COM(?:MERCIAL|'?L)|RETAIL|STORE|RESTAURANT|STRIP\s*MAL|(?:^|[-+&])C(?:[-+&]|$)/.test(
      building,
    );
  const vacantEvidence =
    taxClass === '1' ||
    /VACANT|UNIMPROVED/.test(building) ||
    ((taxClass === '4A' || taxClass === '4B') &&
      Number.isFinite(improvementValue) &&
      improvementValue <= 0 &&
      !building);
  const civicEvidence =
    taxClass.startsWith('15') ||
    /^(?:G|M|U|P\/O|C)(?:\s|$)/.test(zone) ||
    /SCHOOL|CHURCH|TEMPLE|SYNAGOGUE|CEMETER|HOSPITAL|PARK\b|PUBLIC/.test(building);

  if (vacantEvidence) {
    return {
      category:
        industrialZone || industrialEvidence ? 'vacant_industrial' : 'vacant_other',
      status: 'vacant',
      stories,
      yearBuilt,
    };
  }
  if (industrialEvidence) {
    return { category: 'industrial_active', status: 'active', stories, yearBuilt };
  }
  if (residentialUnits && commercialSpace) {
    return {
      category:
        input.historicDistrict || (yearBuilt > 0 && yearBuilt <= 1945)
          ? 'mixed_use_historic'
          : 'mixed_use_modern',
      status: 'active',
      stories,
      yearBuilt,
    };
  }
  if (parkingOrAutoRetail && taxClass === '4A') {
    return { category: 'retail_auto', status: 'active', stories, yearBuilt };
  }
  if (stories >= 8 && !commercialSpace && (taxClass === '2' || taxClass === '4C')) {
    return { category: 'tower_no_retail', status: 'active', stories, yearBuilt };
  }
  if (civicEvidence) {
    return { category: 'civic_open_space', status: 'civic', stories, yearBuilt };
  }
  if (taxClass === '4A' || commercialSpace) {
    return { category: 'commercial_active', status: 'active', stories, yearBuilt };
  }
  if (taxClass === '2' || taxClass === '4C' || residentialUnits) {
    return { category: 'housing', status: 'active', stories, yearBuilt };
  }
  return { category: 'other', status: 'other', stories, yearBuilt };
}
