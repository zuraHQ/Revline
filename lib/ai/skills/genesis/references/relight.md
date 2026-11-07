---
name: "relight"
description: "Genesis relight with LightX: whole frame or one SAM subject, named moments or an explicit sun, depth falloff, allowance and cost. Read before relight."
---
# Relight

`relight` changes the light in a clip: a named moment ("golden hour") or an explicit sun (azimuth, elevation, colour temperature). LightX relights 49 frames sampled evenly across the clip in one fal call; Genesis carries that light change onto every original frame at 1080p, following the motion between samples. Detail, faces and text come from the original footage, so LightX never redraws them.

## Workflow
1. `inspectTimeline` → footage `clipId`. The clip must play at most **15 s** of source; trim or `split` longer clips first.
2. Decide the scope (below). Subject only: `segment` the subject and `depth` the clip at the same time, then poll `getLayer` and `getJob` until both are ready.
3. `relight {clipId, light, layerId?, depthId?}` → `jobId`. The reply quotes `estimatedUsd` and the month's `allowance`.
4. `getJob {jobId}` every 30 s until `ready`. Then `applyJob {jobId}`: the clip points at the relit asset as one edit; one `undoLatestEdit` restores the original.
5. `getFrames` with `resolution:1080` at the start, middle and end of the clip, then `finish`.

## Whole frame or subject only
| The user says | Scope | Call |
|---|---|---|
| "make this golden hour", "relight the shot", "night scene" | Whole frame | `relight {clipId, light}` |
| "light her face", "put the woman in sunset light", "only the car" | Subject | `segment` + `depth`, then `relight {clipId, light, layerId, depthId}` |
| "brighter on him, keep the background as is" | Subject, `falloff:0` | as above |
| "warm light around her that spills onto the bench" | Subject, `falloff:.5–.8` | as above |

A whole-frame relight changes the sky, ground and every person together. A subject relight keeps the scene's original light and changes only the subject, plus a spill into what sits near it in depth and in the frame (`falloff`, default .35). The depth pass is required for subject relight: without it the new light would stop at the mask edge and look pasted on.

## Named moment or explicit angle
| The user gives | Use | Example |
|---|---|---|
| A time or mood: golden hour, sunset, noon, overcast, blue hour, moonlight, street light at night, neon, firelight, studio | `{moment, from?}` | `{moment:"goldenHour", from:"left"}` |
| A direction or angle: "sun from behind her, low", "45° from the right", "3200K key from above" | `{azimuth, elevation, kelvin}` | `{azimuth:-60, elevation:20, kelvin:3500}` |

- `from` is the side of the frame the light comes from (left, right, top, bottom). Each moment has a default side; pass `from` only when the user names one or the scene's existing light clearly comes from a side.
- `azimuth` is seen from the camera: 0 = from the camera, 90 = frame right, -90 = frame left, 180 = from behind (backlight). `elevation` 0 = horizon, 90 = overhead. `kelvin` 1900 candle, 3200 tungsten/golden, 5600 daylight (default), 7500+ shade or blue.
- `detail` adds words about the light only ("light haze"). Never describe the subject or scene: LightX is told only about light.
- `strength` (default 1) blends toward the original: .5 is halfway. Use it when the user asks for "a hint of" or "subtle" light.

## One by one or in parallel
| Situation | Do |
|---|---|
| Several clips, same light | Start every `relight` at once, then poll each `jobId`. Jobs are independent. |
| Several looks for one clip ("show me golden hour and blue hour") | Start both at once; apply the one the user picks. Each costs its own call. |
| Subject relight on a clip that is also relit whole-frame | One by one: apply the whole-frame result first, then relight the subject on the clip that now shows it. |
| Relight plus a depth effect (fog, blur) on the same clip | Relight first and apply it; then run `depthEffect` on the relit clip with the same depth pass. |
| Allowance nearly used | One by one, shortest clips first; tell the user what is left. |

## Cost, time and limits
| Item | Value |
|---|---|
| Price | $0.10 per LightX output second; one call returns 49 frames at 10 fps = **$0.49 per clip** (any length up to 15 s) |
| Measured, whole frame (8 s, 1080p) | **$0.49**, 523 s end to end (about 7 min of it fal's queue and LightX) |
| Measured, subject only (8 s, woman, with depth) | **$0.49** for LightX (plus the reused depth pass), 172 s end to end |
| Allowance | 60 relight seconds a month (120 on Pro), counted in clip seconds; failed jobs do not count |
| Max length | 15 s of source per clip |
| Output | 1080p, the source's frame rate, picture only (the clip keeps its sound) |
| Reuse | The same clip, light and scope reuse a finished result for free |

Past the allowance `relight` refuses with the seconds used. Say so plainly and offer a shorter range; never work around it.

## Rules
1. Explicit angles run in LightX `ic` mode: the nearest side plus the angle and colour in words. LightX's `hdr` mode (an environment map) is not used: on fal it refuses non-.exr images and then cannot decode a real .exr. The reply's `mode` says which ran.
2. Fast motion between the 49 samples can leave a soft light edge that lags a moving subject by a frame or two. Check the frame where the subject moves fastest.
3. Relight changes light, not content. If the user wants objects, weather or the sky replaced, say Genesis does not do that.
4. Do not trim, move or retime the clip after `applyJob` beyond the relit range; finish fails if the clip plays footage the result does not cover. `undoLatestEdit`, retime, then relight again.
