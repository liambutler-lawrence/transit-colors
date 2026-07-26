import type { Map } from 'maplibre-gl';

import type { CompletedOperation, PerformanceLog } from './app/types.js';

declare global {
  interface WindowEventMap {
    'transit:ready': CustomEvent<CompletedOperation>;
  }

  interface Window {
    __transitMap: Map;
    __transitPerformance: PerformanceLog;
  }
}

export {};
