import Globe from 'globe.gl';
import * as THREE from 'three';
import type { City } from './types';

// ─── Design tokens ───────────────────────────────────────────────────────────
const THEMES = {
  light: {
    bg:             '#F6F8FD',
    ocean:          '#F6F8FD',
    countrySide:    '#F6F8FD',
    countryDefault: '#C2D0F0',
    atmosphere:     '#C2D0F0',
    countryActive:  '#3F6ED2',
    countryStroke:  '#8898C8',
    city:           '#FFCC44',
    cityPulse:      '#ffe047',
  },
  dark: {
    bg:             '#162a63',
    ocean:          '#162a63',
    countrySide:    '#162a63',
    countryDefault: '#1d3884',
    atmosphere:     '#466cd6',
    // countryActive:  '#2546a6',
    countryActive:  '#466cd6',
    countryStroke:  '#162a63',
    city:           '#FFCC44',
    cityPulse:      '#ffe047',
  },
} as const;

type Theme = keyof typeof THEMES;

// ─── Continent tour stops ───────────────────────────────────────────────────
// Camera walks through these in order, looping continuously.
// Index must match the data-index attributes on the HTML continent buttons.
const TOUR_STOPS = [
  { lat:  29.727, lng:   4.840, altitude: 0.897 }, // 0 Europe
  { lat:  20.898, lng: -106.276, altitude: 1.166 }, // 1 N. America
  { lat: -33.929, lng:  -68.950, altitude: 1.357 }, // 2 S. America
  { lat: -17.046, lng:   17.292, altitude: 1.254 }, // 3 Africa
  { lat: -31.561, lng:  140.528, altitude: 1.094 }, // 4 Oceania
  { lat:  11.562, lng:   94.406, altitude: 1.038 }, // 5 Asia
] as const;
const TOUR_TRAVEL_MS = 20000; // camera transition between stops
const TOUR_DWELL_MS  = 200; // pause at each stop before moving on

// Horizontal stretch factor applied to the Three.js scene.
// Scaling the scene (not the canvas) keeps raycasting and tooltip
// projection in the same world-space coordinate system, so hover
// detection and tooltip placement remain accurate.
const GLOBE_SCALE_X = 1.0;
const GLOBE_SCALE_Y = 0.8;
const GLOBE_SCALE_Z = 1.0;

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
  theme: Theme = 'light',
): Promise<{ destroy: () => void; flyTo: (pov: { lat: number; lng: number; altitude?: number }, continentIndex: number, transitionMs?: number) => void }> {
  const COLORS = THEMES[theme];
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

  // Stretch the globe elliptically by scaling the Three.js scene in X.
  // This is safe: tooltip positions are derived from 3D→2D projection
  // through the same camera, so they stay aligned with the stretched geometry.
  globe.scene().scale.x = GLOBE_SCALE_X;
  globe.scene().scale.y = GLOBE_SCALE_Y;
  globe.scene().scale.z = GLOBE_SCALE_Z;

  // 3. Keep canvas sized to the container when the element is resized
  const ro = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    globe.width(width).height(height*1.5);
  });
  ro.observe(container);

  // 4. Configure OrbitControls (available immediately)
  const controls = globe.controls();
  controls.autoRotate    = false; // tour drives the camera instead of auto-rotate
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // Start the tour at Europe (index 0)
  globe.pointOfView(TOUR_STOPS[0], 0);

  // ── Tour scheduler ────────────────────────────────────────────────────────
  let tourIndex   = 0;
  let tourTimerId = 0;

  function scheduleNext(delayMs: number) {
    clearTimeout(tourTimerId);
    tourTimerId = window.setTimeout(() => {
      tourIndex = (tourIndex + 1) % TOUR_STOPS.length;
      globe.pointOfView(TOUR_STOPS[tourIndex], TOUR_TRAVEL_MS);
      scheduleNext(TOUR_DWELL_MS + TOUR_TRAVEL_MS);
    }, delayMs);
  }

  // Begin walking after the initial dwell
  scheduleNext(TOUR_DWELL_MS);

  // Pause the tour completely while dragging.
  // 3 s after the last drag input, snap to the nearest continent and resume.
  const canvas = globe.renderer().domElement;
  let idleTimerId = 0;

  // Squared lat/lng distance (good enough for "find closest view")
  function closestStopIndex(lat: number, lng: number): number {
    let best = 0;
    let bestDist = Infinity;
    TOUR_STOPS.forEach((stop, i) => {
      const dlat = stop.lat - lat;
      const dlng = ((stop.lng - lng + 540) % 360) - 180; // wrap longitude
      const dist  = dlat * dlat + dlng * dlng;
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
  }

  function snapAndResume() {
    const pov = globe.pointOfView();
    console.log('pointOfView', pov);
    tourIndex = closestStopIndex(pov.lat, pov.lng);
    globe.pointOfView(TOUR_STOPS[tourIndex], TOUR_TRAVEL_MS);
    scheduleNext(TOUR_DWELL_MS + TOUR_TRAVEL_MS);
  }

  function onPointerDown() {
    // Cancel any in-progress Globe.gl camera tween by snapping to current position.
    // Without this, the 20 s tween overwrites OrbitControls every frame and
    // dragging feels completely locked.
    globe.pointOfView(globe.pointOfView(), 0);
    clearTimeout(tourTimerId);
    clearTimeout(idleTimerId);
  }
  function onPointerUp() {
    // 3 s after the user releases, snap to the nearest continent and resume
    clearTimeout(idleTimerId);
    idleTimerId = window.setTimeout(snapAndResume, 3000);
  }
  function onWheel() {
    // Each wheel tick cancels any running tween and resets the idle countdown
    globe.pointOfView(globe.pointOfView(), 0);
    clearTimeout(tourTimerId);
    clearTimeout(idleTimerId);
    idleTimerId = window.setTimeout(snapAndResume, 3000);
  }

  canvas.addEventListener('pointerdown',  onPointerDown);
  canvas.addEventListener('pointerup',    onPointerUp);
  canvas.addEventListener('pointerleave', onPointerUp);
  canvas.addEventListener('wheel',        onWheel, { passive: true });

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
    .pointsTransitionDuration(0)
    .pointLabel((d: any)  => labelHtml((d as CityPoint).name, (d as CityPoint).info));

  // ── Dot pulse animation ───────────────────────────────────────────────────
  // Each dot suddenly jumps to 1.5× size + #FFCC44, then eases back to its
  // resting size + #fff2b3. ThreeGlobe stores the Three.js mesh on the datum
  // via __threeObjPoint, so we animate scale and material.color directly.
  const PULSE_COLOR_OBJ = new THREE.Color(COLORS.cityPulse);
  const REST_COLOR_OBJ  = new THREE.Color(COLORS.city);
  const PULSE_DURATION  = 1000; // ms for the return-to-rest animation
  const PULSE_SCALE     = 1.0;  // lateral (x/y) scale factor
  const PULSE_SCALE_Z   = 1.1;  // altitude (z) scale factor — lifts dot up when pulsing

  // pxPerDeg mirrors ThreeGlobe's internal formula (GLOBE_RADIUS = 100)
  const PX_PER_DEG = 2 * Math.PI * 100 / 360;

  let pulseFrameId = 0;
  const pulseSetupId = setTimeout(() => {
    // ThreeGlobe populates __threeObjPoint synchronously when pointsData() is
    // called. We clone each material so animating one dot doesn't affect others
    // that share the same MeshLambertMaterial instance.
    allPoints.forEach((city) => {
      const mesh = (city as any).__threeObjPoint as THREE.Mesh | undefined;
      if (!mesh) return;
      mesh.material = (mesh.material as THREE.Material).clone();
      // Compute base scale from the known pointRadius values rather than
      // reading mesh.scale (which may be mid-transition and wrong).
      const r = (city as CityPoint)._size === 'big' ? 0.7 : 0.2;
      (city as any)._baseScale  = r * PX_PER_DEG;
      (city as any)._baseScaleZ = mesh.scale.z; // altitude: set immediately since transitionDuration=0
      (city as any)._pulsing   = false;
      (city as any)._animStart = 0;
      // Stagger first pulse randomly across the first 5 s
      (city as any)._nextPulse = Date.now() + Math.random() * 10000;
    });

    function runPulse() {
      const now = Date.now();
      allPoints.forEach((city) => {
        const mesh = (city as any).__threeObjPoint as THREE.Mesh | undefined;
        if (!mesh) return;
        const mat        = mesh.material as THREE.MeshLambertMaterial;
        const baseScale  = (city as any)._baseScale  as number;
        const baseScaleZ = (city as any)._baseScaleZ as number;

        if ((city as any)._pulsing) {
          const t     = Math.min((now - (city as any)._animStart) / PULSE_DURATION, 1);
          const eased = t * (2 - t); // ease-out quadratic: fast start, slow finish
          const s     = PULSE_SCALE - (PULSE_SCALE - 1) * eased;
          mesh.scale.x = baseScale * s;
          mesh.scale.y = baseScale * s;
          mesh.scale.z = baseScaleZ * (PULSE_SCALE_Z - (PULSE_SCALE_Z - 1) * eased);
          mat.color.lerpColors(PULSE_COLOR_OBJ, REST_COLOR_OBJ, eased);
          if (t >= 1) {
            (city as any)._pulsing   = false;
            (city as any)._nextPulse = now + 4000 + Math.random() * 5000;
          }
        } else if (now >= (city as any)._nextPulse) {
          // Fire: instant jump to peak, then animate back
          (city as any)._pulsing   = true;
          (city as any)._animStart = now;
          mesh.scale.x = baseScale * PULSE_SCALE;
          mesh.scale.y = baseScale * PULSE_SCALE;
          mesh.scale.z = baseScaleZ * PULSE_SCALE_Z;
          mat.color.copy(PULSE_COLOR_OBJ);
        }
      });
      pulseFrameId = requestAnimationFrame(runPulse);
    }
    runPulse();
  }, 100);

  // ── Continent fly-to ──────────────────────────────────────────────────────
  // Jumps directly to the chosen continent then resumes the tour from the
  // next stop in sequence after 5 s.
  function flyTo(
    pov: { lat: number; lng: number; altitude?: number },
    continentIndex: number,
    transitionMs = 1500,
  ) {
    clearTimeout(tourTimerId);
    clearTimeout(idleTimerId);
    tourIndex = continentIndex;
    globe.pointOfView(pov, transitionMs);
    // After 5 s, move on to the next stop and continue walking
    tourTimerId = window.setTimeout(() => {
      tourIndex = (tourIndex + 1) % TOUR_STOPS.length;
      globe.pointOfView(TOUR_STOPS[tourIndex], TOUR_TRAVEL_MS);
      scheduleNext(TOUR_DWELL_MS + TOUR_TRAVEL_MS);
    }, 5000);
  }

  // 6. Return instance
  return {
    flyTo,
    destroy: () => {
      clearTimeout(tourTimerId);
      clearTimeout(idleTimerId);
      cancelAnimationFrame(pulseFrameId);
      clearTimeout(pulseSetupId);
      ro.disconnect();
      canvas.removeEventListener('pointerdown',  onPointerDown);
      canvas.removeEventListener('pointerup',    onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerUp);
      canvas.removeEventListener('wheel',        onWheel);
      globe._destructor();
    },
  };
}
