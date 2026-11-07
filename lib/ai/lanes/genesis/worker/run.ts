import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runMediaCommand as run } from '@/lib/server/media-command';
import { processingThreads } from '@/lib/server/processing-resources';
import { download, requireFal, subscribe, type FalClient } from '@/lib/server/fal';
import { videoInfo, type DerivedFile } from '@/lib/server/freeze-still';
import { pixelTrackPython } from '@/lib/server/worker-tool-path';
import { ownedMediaUrl } from '@/lib/server/owned-media';
import { AnalysisError } from '@/lib/media-analysis/errors';
import { DEPTH_ENDPOINT, DEPTH_MODEL, LIGHTX_FRAMES, LIGHTX_OUTPUT_FPS, OUTPUT_SHORT_SIDE, RELIGHT_ENDPOINT } from '../config';
import type { GenesisJobResult, GenesisWork, RelightParams } from '../job';


type Progress = (value: number) => void;

/** Run one Genesis job on `source` (the clip's current media). Returns the stored-on-source-clock video and the billing receipt. */
export async function runGenesisJob(source: string, directory: string, work: GenesisWork, convexOrigin: string, signal: AbortSignal, onProgress: Progress): Promise<{ file: DerivedFile; result: GenesisJobResult }> {
  const probe = await videoInfo(source, signal), fps = Math.min(60, Math.max(1, Math.round(probe.fps || 30)));
  if (!probe.width || !probe.height) throw new AnalysisError('This video cannot be read.', 422);
  const duration = work.end - work.start, short = OUTPUT_SHORT_SIDE;
  // Output: the processed window at 1080p (short side), on the source's frame rate. ffmpeg applies rotation
  // before the filter, so the scale reads displayed width and height; the window's own size is the truth after.
  const window = join(directory, 'genesis-window.mp4');
  await run('ffmpeg', ['-v', 'error', '-threads', String(processingThreads()), '-ss', work.start.toFixed(6), '-i', source, '-t', duration.toFixed(6), '-map', '0:v:0', '-an', '-vf', `fps=${fps},scale='if(gte(iw,ih),-2,${short})':'if(gte(iw,ih),${short},-2)':flags=lanczos,setsar=1`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-y', window], { signal, timeout: 600_000, maxBuffer: 1024 * 1024 });
  const shown = await videoInfo(window, signal), width = shown.width, height = shown.height;
  if (!width || !height) throw new AnalysisError('This video cannot be read.', 422);
  const frames = await frameCount(window, signal);
  onProgress(12);
  const owned = (url: string) => ownedMediaUrl(url, convexOrigin);
  const masks = Object.fromEntries((work.masks ?? []).map(mask => [mask.layerId, owned(mask.url)]));
  const depth = work.depthUrl ? owned(work.depthUrl) : undefined;
  const base = { window, width, height, fps, frames, start: work.start, duration, ...(depth ? { depth } : {}), masks };
  let composed: string, result: GenesisJobResult;
  if (work.job === 'depth') {
    const fal = requireFal('Depth passes need FAL_KEY on the media worker.');
    composed = await depthPass(fal, window, directory, frames, fps, signal);
    result = { billedSeconds: Math.round(duration * 1000) / 1000, calls: 1 };
    onProgress(85);
  } else if (work.job === 'relight') {
    const fal = requireFal('Relight needs FAL_KEY on the media worker.');
    const params = work.params as RelightParams;
    if (params.scope === 'subject' && (!depth || !params.layerId || !masks[params.layerId])) throw new AnalysisError('Subject relight needs its layer mask and depth pass.', 400);
    const relit = await lightx(fal, window, directory, frames, params, signal, onProgress);
    composed = join(directory, 'genesis-relit.mp4');
    await compose({ mode: 'relight', ...base, params, relit: relit.path, keyframes: relit.keyframes, output: composed }, signal, value => onProgress(55 + value * 33));
    result = { billedSeconds: LIGHTX_FRAMES / LIGHTX_OUTPUT_FPS, mode: params.plan.mode, calls: 1 };
  } else {
    if (!depth) throw new AnalysisError('Depth effects need a depth pass.', 400);
    composed = join(directory, 'genesis-effect.mp4');
    await compose({ mode: 'effect', ...base, params: work.params, output: composed }, signal, value => onProgress(15 + value * 73));
    result = { billedSeconds: 0 };
  }
  // On the source clock: black before `start`, so second N of the result is second N of the footage.
  const aligned = join(directory, 'genesis-output.mp4');
  const pad = work.start > 0 ? `,tpad=start_duration=${work.start.toFixed(6)}:start_mode=add:color=black` : '';
  await run('ffmpeg', ['-v', 'error', '-i', composed, '-vf', `fps=${fps},format=yuv420p${pad}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', work.job === 'depth' ? '12' : '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', '-y', aligned], { signal, timeout: 3_600_000, maxBuffer: 1024 * 1024 });
  const info = await videoInfo(aligned, signal);
  if (!info.width || !info.height || !(info.duration > 0)) throw new AnalysisError('The Genesis result is unreadable.', 502);
  onProgress(94);
  return { file: { path: aligned, kind: 'video', contentType: 'video/mp4', width: info.width, height: info.height, duration: info.duration }, result };
}

/** VDA-Small depth of the window, grayscale with white = near, retimed to exactly the window's frames. */
async function depthPass(fal: FalClient, window: string, directory: string, frames: number, fps: number, signal: AbortSignal) {
  const url = await fal.storage.upload(new Blob([await readFile(window)], { type: 'video/mp4' }));
  signal.throwIfAborted();
  const data = await subscribe(fal, DEPTH_ENDPOINT, { video_url: url, model: DEPTH_MODEL, colormap: 'grayscale', resolution: 'auto', output_fps: fps }, signal) as { video?: { url?: string } };
  if (!data.video?.url) throw new AnalysisError('Depth Anything returned no video.', 502);
  const raw = join(directory, 'genesis-depth-raw.mp4'), path = join(directory, 'genesis-depth.mp4');
  await download(data.video.url, raw, signal);
  const returned = await frameCount(raw, signal);
  await run('ffmpeg', ['-v', 'error', '-i', raw, '-vf', `setpts=N*${frames / returned}/(${fps}*TB),fps=${fps},format=gray`, '-frames:v', String(frames), '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', '-y', path], { signal, timeout: 600_000, maxBuffer: 1024 * 1024 });
  return path;
}

/** LightX works at 672x384. Other shapes keep their aspect inside it (black bars), never squashed; compose.py fits the same way. */
const LIGHTX_FIT = 'scale=672:384:force_original_aspect_ratio=decrease:flags=area,pad=672:384:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1';

/** 49 frames sampled evenly across the window (repeated when it is shorter), relit by LightX in one call. */
async function lightx(fal: FalClient, window: string, directory: string, frames: number, params: RelightParams, signal: AbortSignal, onProgress: Progress) {
  const keyframes = Array.from({ length: LIGHTX_FRAMES }, (_, index) => Math.min(frames - 1, Math.round(index * (frames - 1) / (LIGHTX_FRAMES - 1))));
  const sampled = join(directory, 'genesis-lightx-in.mp4');
  const select = keyframes.map(index => `eq(n\\,${index})`).join('+');
  // select drops repeats, so short clips go through a frame list instead.
  const unique = new Set(keyframes).size === keyframes.length;
  if (unique) await run('ffmpeg', ['-v', 'error', '-i', window, '-vf', `select='${select}',setpts=N/(24*TB),${LIGHTX_FIT}`, '-r', '24', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-an', '-y', sampled], { signal, timeout: 600_000, maxBuffer: 1024 * 1024 });
  else {
    const stills = join(directory, 'genesis-lightx-%04d.png');
    await run('ffmpeg', ['-v', 'error', '-i', window, '-vf', LIGHTX_FIT, '-y', stills], { signal, timeout: 600_000, maxBuffer: 1024 * 1024 });
    const list = join(directory, 'genesis-lightx.txt');
    await writeFile(list, keyframes.map(index => `file '${join(directory, `genesis-lightx-${String(index + 1).padStart(4, '0')}.png`)}'\nduration ${1 / 24}`).join('\n'));
    await run('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=24', '-frames:v', String(LIGHTX_FRAMES), '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-y', sampled], { signal, timeout: 600_000, maxBuffer: 1024 * 1024 });
  }
  if (await frameCount(sampled, signal) < LIGHTX_FRAMES) throw new AnalysisError('Could not prepare 49 frames for LightX.', 500);
  onProgress(18);
  const videoUrl = await fal.storage.upload(new Blob([await readFile(sampled)], { type: 'video/mp4' }));
  const plan = params.plan;
  let input: Record<string, unknown>;
  if (plan.mode === 'hdr') {
    const env = join(directory, 'genesis-env.exr');
    await compose({ mode: 'envmap', azimuth: plan.azimuth, elevation: plan.elevation, kelvin: plan.kelvin, output: env }, signal, () => {});
    // LightX's hdr mode accepts OpenEXR only (a PNG is refused with 422 after queueing).
    const envUrl = await fal.storage.upload(new File([await readFile(env)], 'environment.exr', { type: 'image/x-exr' }));
    input = { video_url: videoUrl, prompt: plan.prompt, relit_cond_type: 'hdr', relit_cond_img_url: envUrl, seed: params.seed };
  } else input = { video_url: videoUrl, relit_cond_type: 'ic', relight_parameters: { relight_prompt: plan.prompt, bg_source: plan.side, cfg: 2, use_sky_mask: false }, seed: params.seed };
  onProgress(22);
  const data = await subscribe(fal, RELIGHT_ENDPOINT, input, signal) as { video?: { url?: string } };
  if (!data.video?.url) throw new AnalysisError('LightX returned no video.', 502);
  const path = join(directory, 'genesis-lightx-out.mp4');
  await download(data.video.url, path, signal);
  onProgress(55);
  return { path, keyframes };
}

/** Run the Python compositor; it streams `p <fraction>` progress lines. */
async function compose(spec: Record<string, unknown>, signal: AbortSignal, onProgress: (fraction: number) => void) {
  const child = spawn(pixelTrackPython(), [join(process.cwd(), 'lib/ai/lanes/genesis/worker/compose.py'), JSON.stringify(spec)], { signal, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-1500); });
  const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  let buffer = '';
  for await (const data of child.stdout) {
    buffer += String(data);
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      const match = /^p ([\d.]+)$/.exec(line.trim());
      if (match) onProgress(Math.min(1, Number(match[1])));
    }
  }
  const code = await closed;
  if (code !== 0) throw new AnalysisError(`The Genesis compositor failed: ${stderr.trim().slice(-400) || `exit ${code}`}`, 500);
}

async function frameCount(path: string, signal: AbortSignal) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path], { signal, timeout: 60_000 });
  const count = Number(stdout.trim());
  if (!Number.isInteger(count) || count < 1) throw new AnalysisError('The video has no frames.', 502);
  return count;
}
