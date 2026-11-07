'use client';

import { ArrowRight } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { createLandingVideoPlayback } from './video-playback';
import { LandingButton, LandingHeading, LandingSection } from './ui';

/* Each tab's card shows `poster` until its loop exists. To add one, drop a muted 4–6 s 1080p MP4
 * at the path named beside it in public/landing/genesis/ and set `video`. Sources and licenses:
 * public/landing/genesis/sources.json. */
type GenesisTab = { id: string; label: string; lead: string; line: string; alt: string; poster: string; video?: string };

const tabs: GenesisTab[] = [
  { id: 'layers', label: 'Layers', lead: 'Layers.', line: 'Split a video into separate layers for each person, object and the background.',
    alt: 'A couple walking two dogs in a park, cut out by SAM 3.1 into separate layers for each person and dog.', poster: '/landing/genesis/layers.webp' }, // video: /landing/genesis/layers.mp4
  { id: 'select', label: 'Select', lead: 'Select.', line: 'Click any object or type its name, and Revline tracks it through the shot.',
    alt: 'A night street in Tokyo with a SAM 3.1 outline around a woman holding a black parasol.', poster: '/landing/genesis/select.webp' }, // video: /landing/genesis/select.mp4
  { id: 'speed', label: 'Speed', lead: 'Speed.', line: 'Slow one subject down while everything else plays at normal speed.',
    alt: 'A woman sitting beside a skate bowl while a skater rides behind her.', poster: '/landing/genesis/speed.webp' }, // video: /landing/genesis/speed.mp4
  { id: 'color', label: 'Color', lead: 'Color.', line: 'Keep only what you pick in color, or grade, glow or blur just that object.',
    alt: 'A park in black and white except a woman in a red dress, selected by SAM 3.1.', poster: '/landing/genesis/color.webp' }, // video: /landing/genesis/color.mp4
  { id: 'text', label: 'Text', lead: 'Text.', line: 'Put a title behind the subject, so they walk in front of it.',
    alt: 'A man walking toward the camera in front of a large title, placed behind him with his SAM 3.1 mask.', poster: '/landing/genesis/text.webp' }, // video: /landing/genesis/text.mp4
  { id: 'replace', label: 'Replace', lead: 'Replace.', line: 'Track an image onto a surface, such as a phone screen or a sign.',
    alt: 'A hand reaching for a phone with a green screen.', poster: '/landing/genesis/replace.webp' }, // video: /landing/genesis/replace.mp4
];

const count = tabs.length;
/** Signed distance from `position` to card `index` around the ring, in cards: [-count/2, count/2). */
const offsetOf = (index: number, position: number) => ((index - position) % count + count * 1.5) % count - count / 2;
const wrap = (index: number) => ((index % count) + count) % count;

type Geometry = { width: number; height: number; gap: number; radius: number; perspective: number };

/** Card size and cylinder radius for the stage width: on phones one card nearly fills it with ~16px of each neighbour showing. */
function measure(stage: number, phone: boolean): Geometry {
  const width = phone ? stage - 56 : Math.min(stage * 0.5, 760);
  const height = width * 9 / 16;
  const radius = width * (phone ? 3 : 1.6);
  return { width, height, gap: phone ? 8 : 24, radius, perspective: radius * (phone ? 1.4 : 1.15) };
}

function GenesisMedia({ tab, active, inView }: { tab: GenesisTab; active: boolean; inView: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const play = active && inView && !!tab.video && !failed;
  useEffect(() => {
    const video = ref.current;
    if (!video || !play) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const playback = createLandingVideoPlayback(video, reason => { if (reason) setFailed(true); });
    const update = () => playback.setPlaying(!reduced.matches);
    update();
    reduced.addEventListener('change', update);
    return () => { reduced.removeEventListener('change', update); playback.dispose(); };
  }, [play]);
  return <>
    <img src={tab.poster} alt={tab.alt} width={960} height={540} loading="lazy" decoding="async" draggable={false} />
    {/* Only the centre card mounts its loop; side cards stay on the poster. */}
    {play && <video ref={ref} src={tab.video} poster={tab.poster} muted loop playsInline preload="auto" aria-hidden="true" />}
  </>;
}

export function LandingGenesis() {
  const [active, setActive] = useState(0);
  const [inView, setInView] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLDivElement | null)[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const position = useRef(0);
  const geometry = useRef<Geometry | null>(null);
  const tween = useRef(0);
  const drag = useRef<{ id: number; x: number; y: number; start: number; moved: boolean; lastX: number; lastTime: number; speed: number } | null>(null);

  // Places every card on the cylinder for the current (possibly fractional) position.
  const layout = useCallback(() => {
    const shape = geometry.current;
    if (!shape) return;
    const step = (shape.width + shape.gap) / shape.radius;
    cards.current.forEach((card, index) => {
      if (!card) return;
      const offset = offsetOf(index, position.current), distance = Math.abs(offset);
      card.style.transform = `translate(-50%, -50%) translateZ(${shape.radius}px) rotateY(${-offset * step}rad) translateZ(${-shape.radius}px)`;
      card.style.opacity = String(Math.max(0, Math.min(1, 2 - distance)));
      card.style.visibility = distance > 1.95 ? 'hidden' : 'visible';
      card.style.zIndex = String(10 - Math.round(distance * 2));
    });
  }, []);

  // Before the first paint, so the cards never show stacked at the default size.
  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return;
    const phone = matchMedia('(max-width: 760px)');
    const resize = () => {
      const shape = measure(node.clientWidth, phone.matches);
      geometry.current = shape;
      node.style.setProperty('--genesis-card-w', `${shape.width}px`);
      node.style.setProperty('--genesis-card-h', `${shape.height}px`);
      node.style.perspective = `${shape.perspective}px`;
      layout();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    phone.addEventListener('change', resize);
    resize();
    const visibility = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
    visibility.observe(node);
    return () => { observer.disconnect(); visibility.disconnect(); phone.removeEventListener('change', resize); cancelAnimationFrame(tween.current); };
  }, [layout]);

  // Slides to card `target` along the shorter way round; snaps when motion is reduced.
  const goTo = useCallback((target: number) => {
    cancelAnimationFrame(tween.current);
    const from = position.current;
    const to = from + offsetOf(target, from);
    setActive(wrap(target));
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(to - from) < 0.001) {
      position.current = wrap(Math.round(to));
      layout();
      return;
    }
    const start = performance.now(), duration = 420 + 80 * Math.min(3, Math.abs(to - from));
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / duration), eased = 1 - (1 - t) ** 3;
      position.current = from + (to - from) * eased;
      layout();
      if (t < 1) tween.current = requestAnimationFrame(frame);
      else position.current = wrap(Math.round(to));
    };
    tween.current = requestAnimationFrame(frame);
  }, [layout]);

  // Keeps the active tab visible in the pill, which scrolls sideways on phones, without scrolling the page.
  useEffect(() => {
    const pill = list.current, trigger = pill?.querySelector<HTMLElement>(`[data-genesis-tab="${tabs[active].id}"]`);
    if (!pill || !trigger || pill.scrollWidth <= pill.clientWidth) return;
    const left = trigger.offsetLeft - (pill.clientWidth - trigger.offsetWidth) / 2;
    pill.scrollTo({ left: Math.max(0, left), behavior: 'instant' });
  }, [active]);

  // A press only becomes a drag after 6px of mostly horizontal movement; a tap never interrupts a slide.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !geometry.current) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start: position.current, moved: false, lastX: event.clientX, lastTime: performance.now(), speed: 0 };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current, shape = geometry.current;
    if (!state || state.id !== event.pointerId || !shape) return;
    if (event.pointerType === 'mouse' && event.buttons === 0) { drag.current = null; return; }
    if (!state.moved) {
      const dx = event.clientX - state.x;
      if (Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(event.clientY - state.y)) return;
      cancelAnimationFrame(tween.current);
      Object.assign(state, { moved: true, x: event.clientX, start: position.current });
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const now = performance.now();
    state.speed = (event.clientX - state.lastX) / Math.max(1, now - state.lastTime);
    state.lastX = event.clientX;
    state.lastTime = now;
    position.current = state.start - (event.clientX - state.x) / (shape.width + shape.gap);
    layout();
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current, shape = geometry.current;
    if (!state || state.id !== event.pointerId) return;
    drag.current = null;
    if (!state.moved || !shape) return;
    const travelled = position.current - state.start;
    // Speed at release: a quick flick moves one card even when it travelled less than half a card.
    const speed = performance.now() - state.lastTime < 100 ? state.speed : 0;
    const steps = Math.abs(travelled) >= 0.5 ? Math.round(travelled) : Math.abs(speed) > 0.4 ? -Math.sign(speed) : 0;
    goTo(Math.round(state.start) + steps);
  };
  const onPointerLeave = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId && !drag.current.moved) drag.current = null;
  };

  return <LandingSection id="genesis" className="landing-genesis" headingId="landing-genesis-heading" data-nav-tone="dark">
    <LandingHeading id="landing-genesis-heading" align="center" tone="inverse" title="Revline Genesis" description="MCP for Claude and Codex" />
    <Tabs value={tabs[active].id} onValueChange={value => goTo(tabs.findIndex(tab => tab.id === value))} className="landing-genesis-tabs">
      <div ref={list} className="landing-genesis-pill">
        <TabsList aria-label="Genesis tools" className="landing-genesis-list">
          {tabs.map(tab => <TabsTrigger key={tab.id} value={tab.id} data-genesis-tab={tab.id} className="landing-genesis-trigger">{tab.label}</TabsTrigger>)}
        </TabsList>
      </div>
      <div ref={stage} className="landing-genesis-stage" role="group" aria-roledescription="carousel" aria-label="Revline Genesis examples"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onPointerLeave={onPointerLeave}>
        {tabs.map((tab, index) => <div key={tab.id} ref={node => { cards.current[index] = node; }} className="landing-genesis-card"
          role="group" aria-roledescription="slide" aria-label={`${index + 1} of ${count}: ${tab.label}`} aria-hidden={index !== active || undefined}>
          <GenesisMedia tab={tab} active={index === active} inView={inView} />
        </div>)}
      </div>
      {tabs.map(tab => <TabsContent key={tab.id} value={tab.id} className="landing-genesis-caption">
        <p><strong>{tab.lead}</strong> {tab.line}</p>
      </TabsContent>)}
    </Tabs>
    <LandingButton href="#mcp" variant="inverse-outline" size="md" className="landing-genesis-button">Connect to Claude or Codex<ArrowRight size={16} aria-hidden="true" /></LandingButton>
  </LandingSection>;
}
