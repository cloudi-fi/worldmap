export interface City {
  name: string;
  lat: number;
  lng: number;
  /** Optional extra text shown in the tooltip below the city name. */
  info?: string;
}

export interface WorldMapOptions {
  /** The DOM element that will contain the globe canvas. Must have explicit width & height. */
  container: HTMLElement;
  /** ISO A2 country codes to highlight in active color, e.g. ['US', 'FR', 'DE']. */
  activeCountries?: string[];
  /** Cities rendered with a large dot (radius 0.5) and a larger pulse ring. */
  bigCities?: City[];
  /** Cities rendered with a small dot (radius 0.25) and a tighter pulse ring. */
  smallCities?: City[];
}

export interface WorldMapInstance {
  destroy(): void;
}
