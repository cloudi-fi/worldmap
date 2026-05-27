import { createGlobe } from './globe';
import type { WorldMapOptions, WorldMapInstance } from './types';
import styles from './style.css?inline';

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected) return;
  const el = document.createElement('style');
  el.dataset['id'] = 'worldmap-styles';
  el.textContent = styles;
  document.head.appendChild(el);
  stylesInjected = true;
}

/**
 * Initialise a 3-D globe widget inside `options.container`.
 *
 * @example
 * ```ts
 * const map = await initWorldMap({
 *   container: document.getElementById('globe'),
 *   activeCountries: ['US', 'FR', 'DE'],
 *   bigCities:   [{ name: 'Paris',  lat: 48.85, lng:   2.35 }],
 *   smallCities: [{ name: 'Lyon',   lat: 45.74, lng:   4.83 }],
 * });
 * // later …
 * map.destroy();
 * ```
 */
export async function initWorldMap(options: WorldMapOptions): Promise<WorldMapInstance> {
  const {
    container,
    activeCountries = [],
    bigCities       = [],
    smallCities     = [],
    theme           = 'light',
  } = options;

  injectStyles();

  const cleanup = await createGlobe(container, activeCountries, bigCities, smallCities, theme);
  return { destroy: cleanup };
}

export type { City, WorldMapOptions, WorldMapInstance } from './types';
