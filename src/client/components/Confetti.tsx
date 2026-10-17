import { useEffect, useRef } from 'react';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  /** In-plane rotation, for variety. */
  angle: number;
  spin: number;
  /** Rotation around the paper's vertical axis, which makes it flutter. */
  flip: number;
  flipSpeed: number;
  sway: number;
  swaySpeed: number;
  swayAmount: number;
  delay: number;
  life: number;
}

const bursts = 2;
const perBurst = 70;

/** Light gravity and strong air drag slow thin paper down to a flutter. */
const gravity = 0.055;
const drag = 0.986;

/**
 * Confetti bursting from the bottom center; each piece launches high and then
 * flutters down like a paper sliver. Purely decorative, and skipped for users
 * who prefer reduced motion.
 */
export function Confetti() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const styles = getComputedStyle(canvas);
    const colors = ['--confetti-1', '--confetti-2', '--confetti-3', '--confetti-4', '--confetti-5']
      .map((name) => styles.getPropertyValue(name).trim())
      .filter(Boolean);
    if (colors.length === 0) colors.push('currentColor');

    const dpr = window.devicePixelRatio || 1;
    let width = 0;
    let height = 0;
    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const particles: Particle[] = [];
    for (let burst = 0; burst < bursts; burst++) {
      for (let index = 0; index < perBurst; index++) {
        // A tight fan upward, so pieces reach the top before drifting down.
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.1;
        const speed = 22 + Math.random() * 10;
        particles.push({
          x: width / 2 + (Math.random() - 0.5) * 80,
          y: height + 12,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          size: 5 + Math.random() * 6,
          color: colors[index % colors.length],
          angle: Math.random() * Math.PI,
          spin: (Math.random() - 0.5) * 0.08,
          flip: Math.random() * Math.PI * 2,
          flipSpeed: 0.06 + Math.random() * 0.12,
          sway: Math.random() * Math.PI * 2,
          swaySpeed: 0.03 + Math.random() * 0.05,
          swayAmount: 0.05 + Math.random() * 0.05,
          delay: burst * 280 + Math.random() * 160,
          life: 0,
        });
      }
    }

    let last = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      // Keep the flutter speed the same on 60Hz and 120Hz displays.
      const dt = Math.min(2.5, (now - last) / 16.67);
      last = now;
      context.clearRect(0, 0, width, height);
      let alive = false;
      for (const particle of particles) {
        if (particle.delay > 0) {
          particle.delay -= 16 * dt;
          alive = true;
          continue;
        }
        particle.life += dt;
        particle.vy += gravity * dt;
        particle.vx += Math.sin(particle.sway) * particle.swayAmount * dt;
        particle.sway += particle.swaySpeed * dt;
        particle.vx *= Math.pow(drag, dt);
        particle.vy *= Math.pow(drag, dt);
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
        particle.angle += particle.spin * dt;
        particle.flip += particle.flipSpeed * dt;

        const fade = particle.life > 640 ? Math.max(0, 1 - (particle.life - 640) / 240) : 1;
        if (fade > 0 && particle.y - particle.size < height + 40) alive = true;

        // The paper turns around its vertical axis: its width squashes as it
        // flips, which is what reads as a flutter.
        const paperWidth = Math.max(particle.size * Math.abs(Math.cos(particle.flip)), particle.size * 0.18);
        const paperHeight = particle.size * 0.62;
        context.save();
        context.globalAlpha = fade;
        context.translate(particle.x, particle.y);
        context.rotate(particle.angle);
        context.fillStyle = particle.color;
        context.fillRect(-paperWidth / 2, -paperHeight / 2, paperWidth, paperHeight);
        context.restore();
      }
      if (alive) frame = requestAnimationFrame(draw);
      else context.clearRect(0, 0, width, height);
    };
    frame = requestAnimationFrame(draw);

    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={ref} className="merge-confetti" aria-hidden="true" />;
}
