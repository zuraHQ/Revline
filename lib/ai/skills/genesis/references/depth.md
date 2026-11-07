---
name: "depth"
description: "Genesis depth pack: one VDA-Small depth pass per clip, reused by portrait blur, focus pull, fog/haze and depth scan, alone or with SAM layers. Read before depth or depthEffect."
---
# Depth pack

`depth` runs Video Depth Anything (VDA-Small, Apache-2.0) once per clip and stores a temporally stable depth video, reused like a SAM layer. `depthEffect` builds a plain, viewer-obvious effect from it with Genesis's own compositor on the media worker: no model call and no generation, so it never changes what is in the frame.

## Workflow
1. `depth {clipId}` → `jobId` (the depth pass). If the effect keeps or focuses on a subject, `segment` that subject at the same time.
2. `getJob` every 15–30 s until `ready` (and `getLayer` for any layer).
3. `depthEffect {clipId, depthId, effect, …}` → a new `jobId`. Poll `getJob`, then `applyJob`. One `undoLatestEdit` restores the clip.
4. `getFrames` with `resolution:1080` where the effect changes most (the end of a pull or sweep, the farthest fog), then `finish`.

Several effects of one clip each start from the same depth pass in parallel. To stack them (fog over a relit clip, blur after fog), apply one, then run the next `depthEffect` on the clip that now shows it.

## Effects
| Effect | What the viewer sees | Call |
|---|---|---|
| Portrait blur | Sharp at the focus depth; blur grows with distance from it | `{effect:"portraitBlur", focus:{layerId}}` or `focus:{depth:.2}` / `{point:{x,y}}` |
| Focus pull | Focus travels from one subject or depth to another over time | `{effect:"focusPull", from:{layerId:A}, to:{layerId:B}, start, end}` |
| Fog / haze | Haze thickens with distance; near things stay clear | `{effect:"fog", amount:.5, color:"#C8CDD2", near:.15}` |
| Depth scan | A glowing line sweeps through the scene by depth | `{effect:"depthScan", direction:"frontToBack", start, end, color, width}` |

- `focus` / `from` / `to`: `{layerId}` follows a SAM subject's depth every frame (best for people who move); `{point:{x,y}}` reads the depth under a frame point; `{depth}` is fixed (0 nearest, 1 farthest).
- `amount`: blur strength (.5 ≈ 24 px at 1080p at the farthest point), fog density, or scan brightness.
- `start` / `end` are timeline seconds inside the clip (default: the whole clip). The pull eases in and out; the scan line exists only between them.
- `keepLayerId` leaves one subject untouched: "blur everything except the woman" is `portraitBlur` with `focus:{layerId:W}, keepLayerId:W`; "fog behind her but not on her" is `fog` with `keepLayerId:W`.

## When each fits
| Request | Effect |
|---|---|
| "blur the background", "portrait mode", "make him pop" | portraitBlur on the subject's layer, with `keepLayerId` for a clean edge |
| "rack focus from her to him", "shift focus to the gardener" | focusPull between two layers |
| "misty", "hazy morning", "atmosphere" | fog |
| "scanner", "lidar sweep", "techy reveal" | depthScan |
| "fake camera move", "2.5D parallax", "push in on a still" | not here: use `freezeFrameParallax` |

Describe what the effect does when you propose it; do not pick a strength or colour the user did not ask for beyond the defaults.

## Cost, time and limits
| Item | Value |
|---|---|
| Depth pass | $0.04 per second of footage (fal, VDA-Small). Measured: 8 s of 1080p at 24 fps = **$0.32**, ready in 45 s |
| Depth effect | No model cost. Measured on 8 s of 1080p: fog 48 s, depth scan 24 s, portrait blur and focus pull 90–105 s (blur is the slow part) |
| Max range | 60 s per depth pass or effect |
| Output | 1080p video on the source clock, picture only (the clip keeps its sound) |
| Reuse | One depth pass serves every effect and subject relight of that footage, free |

## Rules
1. Depth is relative (near to far within the shot), not metres. Pick focus by subject or point, not by guessing a number, unless the user gives one.
2. Thin things (hair, branches, railings) get soft depth edges; portrait blur can halo them slightly. `keepLayerId` with a SAM layer gives the subject a clean edge.
3. Glass, mirrors, water and the sky have unreliable depth. If fog or blur looks wrong there, say so.
4. VDA-Small only. Base and Large are non-commercial; never ask for them.
