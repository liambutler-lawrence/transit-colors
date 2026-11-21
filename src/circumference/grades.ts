import { z } from 'zod';

export const roadGradeSchema = z.enum(['A++', 'A+', 'A', 'A-', 'B', 'C']);
export const transitGradeSchema = z.enum(['A', 'A-', 'B', 'C', 'AX', 'BX']);
export const ROAD_GRADES = roadGradeSchema.options;
export const TRANSIT_GRADES = transitGradeSchema.options;

export type CircumferenceNetworkMode = 'road' | 'transit';
export type RoadGrade = (typeof ROAD_GRADES)[number];
export type TransitGrade = (typeof TRANSIT_GRADES)[number];
export type GradeOption = RoadGrade | TransitGrade;

export function gradeOptions(mode: CircumferenceNetworkMode): readonly GradeOption[] {
  return mode === 'road' ? ROAD_GRADES : TRANSIT_GRADES;
}

export function readGradeOptions(
  mode: CircumferenceNetworkMode,
  value: string | null,
): Set<GradeOption> {
  const selected = value?.split(',');
  return new Set(
    gradeOptions(mode).filter((grade) => !selected || selected.includes(grade)),
  );
}

export function gradeDescription(
  mode: CircumferenceNetworkMode,
  grade: GradeOption,
): string {
  switch (grade) {
    case 'A++':
      return 'Grade separated and divided, at least four through lanes each way';
    case 'A+':
      return 'Grade separated and divided, at least three through lanes each way';
    case 'A':
      return mode === 'road'
        ? 'Grade separated and divided, at least two through lanes each way'
        : 'Grade separated, a track for each direction';
    case 'A-':
      return mode === 'road'
        ? 'Grade separated, at least one through lane each way'
        : 'Grade separated single track';
    case 'B':
      return mode === 'road'
        ? 'At least two through lanes each way, at-grade crossings allowed'
        : 'A track for each direction, at-grade crossings allowed';
    case 'C':
      return mode === 'road'
        ? 'At least one marked through lane each way, at-grade crossings allowed'
        : 'Single track with scheduled passenger service and an at-grade crossing';
    case 'AX':
      return 'Grade separated busway with a dedicated lane each way';
    case 'BX':
      return 'Dedicated busway lane each way, at-grade crossings allowed';
  }
}
