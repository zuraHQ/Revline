import { z } from 'zod';

/** Named lighting moments. Each is a LightX `ic` prompt plus the side the light comes from by default. */
export const LIGHT_MOMENTS = {
  goldenHour: { prompt: 'warm golden hour sunlight, low sun, long soft shadows, glowing highlights', from: 'left' },
  sunset: { prompt: 'deep orange sunset light, sun at the horizon, long shadows, warm rim light', from: 'right' },
  noon: { prompt: 'bright midday sun high overhead, hard short shadows, neutral white daylight', from: 'top' },
  overcast: { prompt: 'soft diffuse overcast daylight, no hard shadows, even cool light', from: 'top' },
  blueHour: { prompt: 'cool blue hour twilight, soft ambient blue light after sunset, dim sky', from: 'top' },
  moonlight: { prompt: 'cool pale moonlight at night, soft blue shadows, dark surroundings', from: 'top' },
  nightStreetLight: { prompt: 'night, warm orange sodium street lamp from above, dark surroundings, pools of light', from: 'top' },
  neon: { prompt: 'night, saturated red and blue neon light, dark surroundings', from: 'left' },
  firelight: { prompt: 'warm flickering firelight from below, dark surroundings', from: 'bottom' },
  studio: { prompt: 'soft studio key light, clean neutral light, gentle shadows', from: 'left' },
} as const;
export type LightMoment = keyof typeof LIGHT_MOMENTS;
const MOMENT_IDS = Object.keys(LIGHT_MOMENTS) as [LightMoment, ...LightMoment[]];
const SIDES = ['left', 'right', 'top', 'bottom'] as const;
export type LightSide = (typeof SIDES)[number];

export const lightInput = z.union([
  z.object({
    moment: z.enum(MOMENT_IDS).describe('Named lighting moment.'),
    from: z.enum(SIDES).optional().describe('Side the light comes from, as seen in the frame; default depends on the moment.'),
    detail: z.string().trim().min(1).max(160).optional().describe('Extra words for the light only (e.g. "light rain haze"). Never describe the subject.'),
  }).strict(),
  z.object({
    azimuth: z.number().min(-180).max(180).describe('Degrees around the subject, seen from the camera: 0 = light from the camera, 90 = from frame right, -90 = from frame left, 180 = from behind (backlight).'),
    elevation: z.number().min(-30).max(90).describe('Degrees above the horizon: 0 = at the horizon, 90 = straight overhead, negative = from below.'),
    kelvin: z.number().min(1500).max(12000).optional().describe('Colour temperature: 1900 candle, 3200 tungsten/golden, 5600 daylight, 7500+ shade/blue. Default 5600.'),
  }).strict(),
]);
export type LightInput = z.infer<typeof lightInput>;

/** What the worker sends LightX: an `ic` prompt with a side, or an `hdr` environment rendered from the sun. */
export type LightPlan =
  | { mode: 'ic'; prompt: string; side: 'Left' | 'Right' | 'Top' | 'Bottom'; label: string }
  | { mode: 'hdr'; azimuth: number; elevation: number; kelvin: number; prompt: string; side: 'Left' | 'Right' | 'Top' | 'Bottom'; label: string };

const capital = (side: LightSide) => (side[0].toUpperCase() + side.slice(1)) as 'Left' | 'Right' | 'Top' | 'Bottom';

/** The LightX side nearest an explicit sun direction: the larger of its horizontal and vertical components. */
export function nearestSide(azimuth: number, elevation: number): LightSide {
  const rad = Math.PI / 180, horizontal = Math.abs(Math.sin(azimuth * rad)) * Math.cos(elevation * rad), vertical = Math.sin(elevation * rad);
  if (elevation < 0 && -vertical >= horizontal) return 'bottom';
  if (vertical >= horizontal) return 'top';
  return azimuth < 0 ? 'left' : 'right';
}

/** Words a diffusion prompt understands for an explicit angle and colour. */
export function angleWords(azimuth: number, elevation: number, kelvin: number) {
  const side = Math.abs(azimuth) <= 25 ? 'from the front' : Math.abs(azimuth) >= 155 ? 'from behind as a backlight' : `from the ${Math.abs(azimuth) > 115 ? 'back-' : Math.abs(azimuth) < 65 ? 'front-' : ''}${azimuth < 0 ? 'left' : 'right'}`;
  const height = elevation < 0 ? 'below' : elevation < 12 ? 'at the horizon' : elevation < 35 ? 'low in the sky' : elevation < 65 ? 'high' : 'directly overhead';
  const colour = kelvin < 2400 ? 'deep orange candle-warm' : kelvin < 3600 ? 'warm golden' : kelvin < 4800 ? 'soft warm white' : kelvin < 6500 ? 'neutral white daylight' : 'cool blue';
  return `${colour} sunlight ${side}, sun ${height} (${Math.round(elevation)}° elevation), ${elevation > 50 ? 'short' : 'long'} shadows`;
}

/** Light input to the LightX plan. Explicit angles use `hdr` unless `ic` is forced (the angle-word fallback). */
export function lightPlan(light: LightInput, explicitMode: 'hdr' | 'ic'): LightPlan {
  if ('moment' in light) {
    const moment = LIGHT_MOMENTS[light.moment], side = light.from ?? moment.from;
    return { mode: 'ic', prompt: light.detail ? `${moment.prompt}, ${light.detail}` : moment.prompt, side: capital(side), label: `${light.moment} from ${side}` };
  }
  const kelvin = light.kelvin ?? 5600, side = capital(nearestSide(light.azimuth, light.elevation)), prompt = angleWords(light.azimuth, light.elevation, kelvin);
  const label = `sun azimuth ${Math.round(light.azimuth)}°, elevation ${Math.round(light.elevation)}°, ${Math.round(kelvin)}K`;
  return explicitMode === 'hdr' ? { mode: 'hdr', azimuth: light.azimuth, elevation: light.elevation, kelvin, prompt, side, label } : { mode: 'ic', prompt, side, label };
}
