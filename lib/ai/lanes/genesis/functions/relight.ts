import { z } from 'zod';
import { lightInput } from './light';
import { MAX_RELIGHT_SECONDS, RELIGHT_MONTHLY_SECONDS } from '../config';

export const relightInput = z.object({
  clipId: z.string().min(1).describe('Footage clip to relight; at most 15 s of source.'),
  light: lightInput.describe('{moment:"goldenHour", from?:"left"} for a named moment, or {azimuth, elevation, kelvin?} for an explicit sun.'),
  layerId: z.string().min(1).optional().describe('A ready SAM layer: relight only that subject. Omit to relight the whole frame.'),
  depthId: z.string().min(1).optional().describe('Required with layerId: a ready depth pass of this footage, so the light falls off into the nearby scene with distance.'),
  strength: z.number().min(0).max(1).optional().describe('How much of the new light to keep: 1 = all of it (default), .5 = halfway between the original and the relit look.'),
  falloff: z.number().min(0).max(1).optional().describe('Subject relight: how far the new light spills into the nearby scene (0 = subject only, default .35, 1 = wide).'),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional().describe('Repeat a result exactly; default fixed per request.'),
}).strict();
export type RelightInput = z.infer<typeof relightInput>;

export const relightDescription = `Genesis (MCP only). Relight footage with LightX on fal: 49 frames sampled across the clip are relit in one call (4.9 output seconds at $0.10 = $0.49 per clip), and the light change is carried onto every original 1080p frame, following motion between samples. light: a named moment (goldenHour, sunset, noon, overcast, blueHour, moonlight, nightStreetLight, neon, firelight, studio; optional from left/right/top/bottom) or an explicit sun {azimuth, elevation, kelvin}. Whole frame by default; with layerId (a ready SAM layer) and depthId (a ready depth pass) only that subject is relit and the new light falls off into the nearby scene by depth. Clips over ${MAX_RELIGHT_SECONDS} s are refused: trim or split first. Output is a new 1080p asset; poll getJob (several minutes, fal queues vary), then applyJob points the clip at it (one undo restores). Monthly allowance: ${RELIGHT_MONTHLY_SECONDS.mcp} relight seconds (${RELIGHT_MONTHLY_SECONDS.pro} on Pro); the reply reports what is left. Same clip, light and scope reuse a finished result for free.`;
