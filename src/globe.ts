import Globe from 'globe.gl';
import * as THREE from 'three';
import type { City } from './types';

// ─── Design tokens ───────────────────────────────────────────────────────────
const COLORS = {
  bg:             '#F6F8FD',
  ocean:          '#F6F8FD',
  countryDefault: '#C2D0F0',
  countryActive:  '#3F6ED2',
  // countrySide:    '#9AAAD8',
  countrySide:    '#F6F8FD',
  countryStroke:  '#8898C8',
  atmosphere:     '#C2D0F0',
  city:           '#FFD338',
} as const;

// GeoJSON with properties.ADMIN (name) and properties.ISO_A2 (code)
const COUNTRIES_URL =
  'https://raw.githubusercontent.com/vasturiano/globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson';

// ─── Types ────────────────────────────────────────────────────────────────────
type CityPoint = City & { _size: 'big' | 'small' };

// ─── ISO A2 resolver ─────────────────────────────────────────────────────────
// Natural Earth 110m marks some countries as ISO_A2 = "-99" (France, Norway…).
// We fall back first to WB_A2, then to a compact A3 → A2 table.
const A3_TO_A2: Record<string, string> = {
  NOR: 'NO', // Norway
  CYN: 'CY', // Northern Cyprus (mapped to CY for convenience)
};

function resolveIso2(props: Record<string, string>): string {
  const iso2 = props['ISO_A2'];
  if (iso2 && iso2 !== '-99') return iso2.toUpperCase();
  const wb2 = props['WB_A2'];
  if (wb2 && wb2 !== '-99') return wb2.toUpperCase();
  return (A3_TO_A2[props['ADM0_A3']] ?? '').toUpperCase();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function labelHtml(title: string, info?: string): string {
  return [
    `<span class="wm-label-title">${title}</span>`,
    info ? `<span class="wm-label-info">${info}</span>` : '',
  ].join('');
}

// ─── Main export ─────────────────────────────────────────────────────────────
/**
 * Creates and mounts a Globe.gl globe into `container`.
 * Returns a cleanup function that tears down the globe.
 */
export async function createGlobe(
  container: HTMLElement,
  activeCountries: string[],
  bigCities: City[],
  smallCities: City[],
): Promise<() => void> {
  // Globe.gl defaults to window.innerWidth × window.innerHeight — override with
  // the actual container dimensions so the canvas fills the element correctly.
  const w = container.clientWidth  || 1200;
  const h = container.clientHeight || 600;

  // 1. Create globe immediately so the user sees it spinning while data loads
  const globe = new Globe(container, { waitForGlobeReady: false, animateIn: false })
    .width(w)
    .height(h)
    .backgroundColor(COLORS.bg)
    .showAtmosphere(true)
    .atmosphereColor(COLORS.atmosphere)
    .atmosphereAltitude(0.0);

  // 2. Override the globe surface material — MeshBasicMaterial ignores all scene
  //    lights, giving a perfectly uniform ocean colour with no shading gradient.
  globe.globeMaterial(
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(COLORS.ocean),
    }),
  );

  // Replace the default directional lights with a single ambient light so that
  // Lambert-shaded objects (city dots, country polygons) render as their exact
  // assigned colour. Three.js Lambert divides by π internally, so we set
  // intensity = Math.PI to cancel that factor and get colour × 1 = colour.
  globe.lights([new THREE.AmbientLight(0xffffff, Math.PI)]);

  // 3. Keep canvas sized to the container when the element is resized
  const ro = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    globe.width(width).height(height*1.5);
  });
  ro.observe(container);

  // 4. Configure OrbitControls (available immediately)
  const controls = globe.controls();
  controls.autoRotate      = true;
  controls.autoRotateSpeed = 0.4;
  controls.enableDamping   = true;
  controls.dampingFactor   = 0.08;

  // Tilt the initial camera 20° north so the northern hemisphere is centred
  globe.pointOfView({ lat: 30, lng: 40, altitude: 1.5 }, 0);

  // 5. Pause auto-rotate while the user is dragging
  const canvas = globe.renderer().domElement;

  function pauseRotation()  { controls.autoRotate = false; }
  function resumeRotation() { controls.autoRotate = true;  }

  canvas.addEventListener('pointerdown',  pauseRotation);
  canvas.addEventListener('pointerup',    resumeRotation);
  canvas.addEventListener('pointerleave', resumeRotation);

  // 6. Fetch country GeoJSON and populate layers
  const res     = await fetch(COUNTRIES_URL);
  const geojson = (await res.json()) as { features: object[] };

  const activeSet  = new Set(activeCountries.map((c) => c.toUpperCase()));
  const allPoints: CityPoint[] = [
    ...bigCities.map((c)   => ({ ...c, _size: 'big'   as const })),
    ...smallCities.map((c) => ({ ...c, _size: 'small' as const })),
  ];

  globe
    // ── Country polygons ──────────────────────────────────────────────────
    .polygonsData(geojson.features)
    .polygonCapColor((d: any) =>
      activeSet.has(resolveIso2(d.properties ?? {}))
        ? COLORS.countryActive
        : COLORS.countryDefault,
    )
    .polygonSideColor(() => COLORS.countrySide)
    .polygonStrokeColor(() => COLORS.countryStroke)
    .polygonAltitude(0.01)
    .polygonLabel((d: any) => labelHtml(d.properties?.ADMIN ?? ''))

    // ── City dots (big + small combined) ─────────────────────────────────
    .pointsData(allPoints)
    .pointLat((d: any)    => (d as CityPoint).lat)
    .pointLng((d: any)    => (d as CityPoint).lng)
    .pointColor(() => COLORS.city)
    .pointRadius((d: any) => (d as CityPoint)._size === 'big' ? 0.7 : 0.2)
    .pointAltitude(0.015)
    .pointLabel((d: any)  => labelHtml((d as CityPoint).name, (d as CityPoint).info))

    // ── Pulse rings (real-time activity feel) ─────────────────────────────
    .ringsData(allPoints)
    .ringLat((d: any)    => (d as CityPoint).lat)
    .ringLng((d: any)    => (d as CityPoint).lng)
    // Return a t→color function per ring; t goes from 0 (new) to 1 (gone)
    .ringColor((_d: any): ((t: number) => string) =>
      (t: number) => `rgba(255,211,56,${Math.max(0, 1 - t * 1.8).toFixed(3)})`,
    )
    .ringMaxRadius((d: any)  => (d as CityPoint)._size === 'big' ? 4 : 2.5)
    .ringPropagationSpeed(2)
    .ringRepeatPeriod(1500);

  // 6. Return cleanup
  return () => {
    ro.disconnect();
    canvas.removeEventListener('pointerdown',  pauseRotation);
    canvas.removeEventListener('pointerup',    resumeRotation);
    canvas.removeEventListener('pointerleave', resumeRotation);
    globe._destructor();
  };
}
