import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';
import type { MediaWorkItem } from '../../convex/lib/media_task_contract';
import { beatTrackModelPath, beatTrackPython, pixelTrackPython, sceneDetectPython, videoImporterPath } from './worker-tool-path';

const run = promisify(execFile);
/** Check before subscribing/claiming: a missing dependency must not consume an attempt. */
export async function localWorkerCapabilities() {
  const excludedKinds = new Set<MediaWorkItem['kind']>();
  const missing: string[] = [];
  const available = async (label: string, file: string, args: string[]) => {
    try { await run(file, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }); return true; }
    catch { missing.push(label); return false; }
  };
  const media = (await Promise.all(['ffmpeg', 'ffprobe'].map(file => available(file, file, ['-version'])))).every(Boolean);
  let browser = false;
  try { browser = await available('Chromium', await puppeteer.executablePath(), ['--version']); }
  catch { missing.push('Chromium'); }
  if (!browser) for (const kind of ['facecam', 'speakers', 'track', 'snapshot', 'review', 'blueprint', 'render'] as const) excludedKinds.add(kind);
  if (!['public/vendor/blaze-face.tflite', 'public/vendor/face-landmarker.task', 'public/vendor/mediapipe/vision_wasm_internal.wasm'].every(path => existsSync(path))) {
    missing.push('MediaPipe models / WASM');
    for (const kind of ['facecam', 'speakers', 'track'] as const) excludedKinds.add(kind);
  }
  const scene = sceneDetectPython();
  if (!await available('scene detection / OpenCV', scene, ['-c', 'import cv2, scenedetect'])) {
    for (const kind of ['facecam', 'speakers', 'shots', 'reference', 'derive'] as const) excludedKinds.add(kind);
  }
  const pixel = pixelTrackPython();
  if (pixel !== scene && !await available('pixel tracking / OpenCV', pixel, ['-c', 'import cv2'])) excludedKinds.add('derive');
  // The Genesis compositor runs in the same OpenCV environment.
  if (!await available('Genesis compositor / OpenCV', pixel, ['-c', 'import cv2, numpy'])) excludedKinds.add('genesis');
  const beat = beatTrackPython();
  const model = beatTrackModelPath();
  if (!await available('Beat This', beat, ['-c', 'import beat_this, torch, torchaudio']) || !existsSync(model)) {
    excludedKinds.add('beats'); excludedKinds.add('reference');
    if (!existsSync(model)) missing.push('Beat This model');
  }
  const importer = videoImporterPath();
  if (!await available('video importer', importer, ['--version'])) excludedKinds.add('import');
  return { media, excludedKinds: [...excludedKinds], missing };
}
