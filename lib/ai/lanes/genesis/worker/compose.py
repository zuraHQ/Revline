"""Genesis compositor: relight transfer and depth effects at full resolution. JSON spec in argv[1].

Frames stream through ffmpeg pipes (rgb24 in, rgb24 out). Progress lines `p <0..1>` go to stdout.
Depth arrives as grayscale with white = near; here D is distance (0 = nearest, 1 = farthest).
"""
import json
import math
import signal
import subprocess
import sys

import cv2
import numpy as np

signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
cv2.setNumThreads(2)
LX_W, LX_H = 672, 384
FLOW_W, FLOW_H = 336, 192
LX_FIT = 'scale=672:384:force_original_aspect_ratio=decrease:flags=area,pad=672:384:(ow-iw)/2:(oh-ih)/2:color=black'


def reader(path, width, height, fmt, start=None, duration=None, fps=None, extra='', decoder=None, fit=None):
    """Raw frames of one input at width x height. `start`/`duration` are seconds on that input's clock."""
    channels = 3 if fmt == 'rgb24' else 1
    args = ['ffmpeg', '-v', 'error']
    if decoder:
        args += ['-c:v', decoder]
    if start is not None:
        args += ['-ss', f'{start:.6f}']
    args += ['-i', path]
    if duration is not None:
        args += ['-t', f'{duration:.6f}']
    chain = [f'fps={fps}'] if fps else []
    if extra:
        chain.append(extra)
    chain += [fit or f'scale={width}:{height}:flags=bicubic', f'format={fmt}']
    args += ['-map', '0:v:0', '-vf', ','.join(chain), '-f', 'rawvideo', '-pix_fmt', fmt, '-']
    process = subprocess.Popen(args, stdout=subprocess.PIPE)
    size = width * height * channels
    last = None
    while True:
        data = process.stdout.read(size)
        if len(data) < size:
            break
        last = np.frombuffer(data, np.uint8).reshape((height, width, channels) if channels == 3 else (height, width))
        yield last
    process.wait()


class Held:
    """Frames of a secondary input; holds the last frame if it runs short (or a fallback if it is empty)."""

    def __init__(self, frames, fallback):
        self.frames, self.last = frames, fallback

    def next(self):
        frame = next(self.frames, None)
        if frame is not None:
            self.last = frame
        return self.last


def writer(path, width, height, fps):
    return subprocess.Popen(['ffmpeg', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{width}x{height}', '-r', str(fps), '-i', '-',
                             '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-y', path], stdin=subprocess.PIPE)


def linear(rgb):
    return np.power(rgb.astype(np.float32) / 255.0, 2.2)


def srgb(lin):
    return (np.power(np.clip(lin, 0, 1), 1 / 2.2) * 255.0 + .5).astype(np.uint8)


def hex_rgb(value):
    value = value.lstrip('#')
    return np.array([int(value[i:i + 2], 16) for i in (0, 2, 4)], np.float32) / 255.0


def smoothstep(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def distance_of(depth_gray):
    # The depth video is 8-bit and H.264: smoothing removes its steps, which fog and blur would show as bands.
    sigma = max(1.5, min(depth_gray.shape) / 360.0)
    return 1.0 - cv2.GaussianBlur(depth_gray.astype(np.float32), (0, 0), sigma) / 255.0


def soft(mask_gray):
    return mask_gray.astype(np.float32) / 255.0


def subject_depth(D, mask, previous):
    pick = D[mask > .5]
    return float(np.median(pick)) if pick.size > 32 else previous


def focus_at(target, D, masks, width, height, memory, key):
    """Distance in focus for one frame: a fixed depth, the depth under a point, or a subject's median depth."""
    if 'depth' in target:
        return float(target['depth'])
    if 'point' in target:
        x = int(round(target['point']['x'] * (width - 1)))
        y = int(round(target['point']['y'] * (height - 1)))
        r = max(2, width // 200)
        value = float(np.median(D[max(0, y - r):y + r + 1, max(0, x - r):x + r + 1]))
        memory[key] = value
        return value
    value = subject_depth(D, masks[target['layerId']], memory.get(key, .5))
    memory[key] = value
    return value


def depth_blur(lin, D, focus, max_sigma):
    """Blur that grows with distance from the focus depth: blend of five Gaussian levels, per pixel."""
    if max_sigma < .5:
        return lin
    weight = np.clip(np.abs(D - focus) / .35, 0, 1)
    # The radius changes smoothly across depth edges, so a sharp edge never sits beside a blurred one (no halo line).
    weight = cv2.GaussianBlur(weight, (0, 0), max(1.0, max_sigma / 2)) * 4.0
    levels = [lin] + [cv2.GaussianBlur(lin, (0, 0), max_sigma * k / 4.0) for k in range(1, 5)]
    out = np.zeros_like(lin)
    for k in range(5):
        share = np.clip(1.0 - np.abs(weight - k), 0, 1)[..., None]
        out += levels[k] * share
    return out


def effects(spec):
    width, height, fps, count = spec['width'], spec['height'], spec['fps'], spec['frames']
    params = spec['params']
    kind = params['effect']
    source = reader(spec['window'], width, height, 'rgb24')
    depth = Held(reader(spec['depth'], width, height, 'gray', spec['start'], spec['duration'], fps), np.full((height, width), 128, np.uint8))
    masks = {layer: Held(reader(url, width, height, 'gray', spec['start'], spec['duration'], fps, 'alphaextract', 'libvpx-vp9'), np.zeros((height, width), np.uint8))
             for layer, url in spec.get('masks', {}).items()}
    out = writer(spec['output'], width, height, fps)
    scale = min(width, height) / 1080.0
    memory = {}
    keep = params.get('keepLayerId')
    for index, frame in enumerate(source):
        t = spec['start'] + index / fps
        D = distance_of(depth.next())
        layer_masks = {layer: soft(held.next()) for layer, held in masks.items()}
        lin = linear(frame)
        if kind in ('portraitBlur', 'focusPull'):
            if kind == 'portraitBlur':
                focus = focus_at(params['focus'], D, layer_masks, width, height, memory, 'focus')
            else:
                a = focus_at(params['from'], D, layer_masks, width, height, memory, 'from')
                b = focus_at(params['to'], D, layer_masks, width, height, memory, 'to')
                mix = smoothstep((t - params['t0']) / max(1e-6, params['t1'] - params['t0']))
                focus = a + (b - a) * mix
            result = depth_blur(lin, D, focus, params['amount'] * 48.0 * scale)
        elif kind == 'fog':
            near = params['near']
            x = np.clip((D - near) / max(1e-6, 1 - near), 0, 1)
            density = (1 - np.exp(-3.0 * params['amount'] * x))[..., None]
            result = lin * (1 - density) + np.power(hex_rgb(params['color']), 2.2) * density
        else:
            progress = (t - params['t0']) / max(1e-6, params['t1'] - params['t0'])
            if 0 <= progress <= 1:
                position = progress if params['direction'] == 'frontToBack' else 1 - progress
                glow = np.exp(-.5 * ((D - position) / params['width']) ** 2)[..., None] * params['amount']
                light = np.power(hex_rgb(params['color']), 2.2) * glow
                result = 1 - (1 - lin) * (1 - np.clip(light, 0, 1))
            else:
                result = lin
        if keep:
            m = layer_masks[keep][..., None]
            result = lin * m + result * (1 - m)
        out.stdin.write(srgb(result).tobytes())
        if index % 8 == 0:
            print(f'p {min(1.0, (index + 1) / count):.3f}', flush=True)
    out.stdin.close()
    if out.wait() != 0:
        sys.exit('Could not encode the depth effect.')


def guide_of(rgb):
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0


def ratio_coefficients(relit, original, radius=16, eps=2e-2):
    """Light change from LightX as a guided filter (He et al.) of relit/original, guided by the original's
    luminance: coefficients a, b with ratio = a * guide + b. They follow the original's edges, so the new light
    stays inside the shapes it belongs to instead of haloing across them, and they upsample to full resolution."""
    ratio = np.clip((linear(relit) + .01) / (linear(original) + .01), .05, 8.0)
    guide = guide_of(original)
    box = lambda image: cv2.boxFilter(image, -1, (2 * radius + 1, 2 * radius + 1))
    mean_i, mean_ii = box(guide), box(guide * guide)
    variance = (mean_ii - mean_i * mean_i)[..., None]
    mean_p, mean_ip = box(ratio), box(ratio * guide[..., None])
    a = (mean_ip - mean_i[..., None] * mean_p) / (variance + eps)
    b = mean_p - a * mean_i[..., None]
    return np.concatenate([box(a), box(b)], axis=2)


def warp(image, flow):
    h, w = flow.shape[:2]
    big = cv2.resize(flow, (image.shape[1], image.shape[0])) * np.array([image.shape[1] / w, image.shape[0] / h], np.float32)
    gx, gy = np.meshgrid(np.arange(image.shape[1], dtype=np.float32), np.arange(image.shape[0], dtype=np.float32))
    return cv2.remap(image, gx + big[..., 0], gy + big[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def relight(spec):
    width, height, fps, count = spec['width'], spec['height'], spec['fps'], spec['frames']
    params = spec['params']
    keys = spec['keyframes']
    # Pass 1: the clip fitted into LightX's frame exactly as it was sent. Colour is kept only at keyframes
    # (for the light ratios); every frame keeps a small grey copy for the motion between them.
    wanted = set(keys)
    colour, grey = {}, []
    for index, frame in enumerate(reader(spec['window'], LX_W, LX_H, 'rgb24', fit=LX_FIT)):
        if index in wanted:
            colour[index] = frame
        grey.append(cv2.cvtColor(cv2.resize(frame, (FLOW_W, FLOW_H), interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY))
    if not grey:
        sys.exit('The clip has no frames.')
    relit = [frame for frame in reader(spec['relit'], LX_W, LX_H, 'rgb24')]
    if len(relit) < len(keys):
        sys.exit(f'LightX returned {len(relit)} frames for {len(keys)} samples.')
    # The picture's area inside LightX's frame (black bars around other aspects).
    fit = min(LX_W / width, LX_H / height)
    cw, ch = int(round(width * fit / 2)) * 2, int(round(height * fit / 2)) * 2
    x0, y0 = (LX_W - cw) // 2, (LX_H - ch) // 2
    ratios = {}
    for slot, index in enumerate(keys):
        if index not in ratios:
            ratios[index] = ratio_coefficients(relit[slot], colour[min(index, max(colour))])
    ordered = sorted(ratios)
    strength = params.get('strength', 1.0)
    subject = params['scope'] == 'subject'
    falloff = params.get('falloff', .35)
    depth = Held(reader(spec['depth'], width, height, 'gray', spec['start'], spec['duration'], fps), np.full((height, width), 128, np.uint8)) if subject else None
    mask = Held(reader(spec['masks'][params['layerId']], width, height, 'gray', spec['start'], spec['duration'], fps, 'alphaextract', 'libvpx-vp9'), np.zeros((height, width), np.uint8)) if subject else None
    out = writer(spec['output'], width, height, fps)
    flow_args = dict(pyr_scale=.5, levels=4, winsize=21, iterations=3, poly_n=5, poly_sigma=1.1, flags=0)
    subject_distance = .5
    for index, frame in enumerate(reader(spec['window'], width, height, 'rgb24')):
        n = min(index, len(grey) - 1)
        after = next((k for k in ordered if k >= n), ordered[-1])
        before = next((k for k in reversed(ordered) if k <= n), ordered[0])
        if before == after:
            ratio = ratios[before]
        else:
            # Each keyframe's light change, carried along the motion to this frame, blended by distance in time.
            r0 = warp(ratios[before], cv2.calcOpticalFlowFarneback(grey[n], grey[before], None, **flow_args))
            r1 = warp(ratios[after], cv2.calcOpticalFlowFarneback(grey[n], grey[after], None, **flow_args))
            mix = (n - before) / (after - before)
            ratio = r0 * (1 - mix) + r1 * mix
        coefficients = cv2.resize(ratio[y0:y0 + ch, x0:x0 + cw], (width, height), interpolation=cv2.INTER_LINEAR)
        ratio = np.clip(coefficients[..., :3] * guide_of(frame)[..., None] + coefficients[..., 3:], .05, 8.0)
        if strength != 1.0:
            ratio = np.power(np.clip(ratio, .05, 8.0), strength)
        lin = linear(frame)
        lit = np.clip(lin * ratio, 0, 1)
        if subject:
            m = soft(mask.next())
            D = distance_of(depth.next())
            subject_distance = subject_depth(D, m, subject_distance)
            weight = m
            if falloff > 0:
                # The light spills into what is near the subject in depth and close to it in the frame.
                outside = (m < .5).astype(np.uint8)
                pixels = cv2.distanceTransform(outside, cv2.DIST_L2, 5) if outside.any() else np.zeros_like(m)
                spatial = np.exp(-pixels / (falloff * .25 * width + 1.0))
                closeness = np.exp(-((D - subject_distance) / (.06 + .3 * falloff)) ** 2)
                weight = np.maximum(m, falloff * spatial * closeness)
            weight = weight[..., None]
            lit = lin * (1 - weight) + lit * weight
        out.stdin.write(srgb(lit).tobytes())
        if index % 8 == 0:
            print(f'p {min(1.0, (index + 1) / count):.3f}', flush=True)
    out.stdin.close()
    if out.wait() != 0:
        sys.exit('Could not encode the relit video.')


def kelvin_rgb(kelvin):
    """Colour of a black body (Tanner Helland's fit), 0..1."""
    t = kelvin / 100.0
    r = 255 if t <= 66 else 329.698727446 * ((t - 60) ** -0.1332047592)
    g = 99.4708025861 * math.log(t) - 161.1195681661 if t <= 66 else 288.1221695283 * ((t - 60) ** -0.0755148492)
    b = 255 if t >= 66 else 0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    return np.clip(np.array([r, g, b], np.float32) / 255.0, 0, 1)


def envmap(spec):
    """Equirectangular HDR environment (.exr, linear light) for LightX `hdr`: sky, ground and a sun far brighter
    than 1.0 at the given direction. Longitude 0 (image centre) looks into the scene; light from the camera sits at the edges."""
    width, height = 1024, 512
    azimuth, elevation, kelvin = math.radians(spec['azimuth']), math.radians(spec['elevation']), spec['kelvin']
    lon = (np.arange(width, dtype=np.float32) + .5) / width * 2 * math.pi - math.pi
    lat = math.pi / 2 - (np.arange(height, dtype=np.float32) + .5) / height * math.pi
    lon, lat = np.meshgrid(lon, lat)
    sun_lon = math.pi - azimuth
    sun_lon = (sun_lon + math.pi) % (2 * math.pi) - math.pi
    sun = np.array([math.cos(elevation) * math.sin(sun_lon), math.sin(elevation), math.cos(elevation) * math.cos(sun_lon)], np.float32)
    dirs = np.stack([np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)], -1)
    angle = np.degrees(np.arccos(np.clip(dirs @ sun, -1, 1)))
    colour = kelvin_rgb(kelvin)
    day = float(np.clip(math.sin(elevation) * 1.5 + .25, .15, 1))
    up = np.clip(np.sin(lat), 0, 1)[..., None]
    horizon = colour * .55 + .25
    zenith = np.array([.35, .5, .8], np.float32) * (.6 + .4 * (kelvin / 12000))
    sky = (horizon * (1 - up) + zenith * up) * day * .55
    ground = np.array([.16, .14, .12], np.float32) * day
    image = np.where((lat > 0)[..., None], sky, ground)
    image = image + colour * (np.exp(-(angle / 2.5) ** 2) * 60.0 + np.exp(-(angle / 22.0) ** 2) * .8)[..., None]
    # LightX takes only OpenEXR; ffmpeg writes it from planar float (G, B, R plane order).
    planes = np.stack([image[..., 1], image[..., 2], image[..., 0]]).astype('<f4')
    done = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-s', f'{width}x{height}', '-i', '-', '-frames:v', '1', '-c:v', 'exr', '-y', spec['output']], input=planes.tobytes())
    if done.returncode != 0:
        sys.exit('Could not write the environment map.')


if __name__ == '__main__':
    job = json.loads(sys.argv[1])
    {'effect': effects, 'relight': relight, 'envmap': envmap}[job['mode']](job)
