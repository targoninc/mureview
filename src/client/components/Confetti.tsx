import { useEffect, useRef } from 'react';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  angle: number;
  spin: number;
  delay: number;
}

const bursts = 2;
const perBurst = 70;

/**
 * Confetti bursting from the bottom center; purely decorative, and skipped
 * for users who prefer reduced motion.
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
        // A fan upward, wide enough to reach across the screen before falling.
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.7;
        const speed = 9 + Math.random() * 11;
        particles.push({
          x: width / 2 + (Math.random() - 0.5) * 80,
          y: height + 12,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          size: 5 + Math.random() * 6,
          color: colors[index % colors.length],
          angle: Math.random() * Math.PI,
          spin: (Math.random() - 0.5) * 0.3,
          delay: burst * 280 + Math.random() * 160,
        });
      }
    }

    let frame = 0;
    const draw = () => {
      context.clearRect(0, 0, width, height);
      let alive = false;
      for (const particle of particles) {
        if (particle.delay > 0) {
          particle.delay -= 16;
          alive = true;
          continue;
        }
        particle.vy += 0.32;
        particle.vx *= 0.992;
        particle.vy *= 0.992;
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.angle += particle.spin;
        if (particle.y - particle.size < height + 40) alive = true;
        context.save();
        context.translate(particle.x, particle.y);
        context.rotate(particle.angle);
        context.fillStyle = particle.color;
        context.fillRect(-particle.size / 2, -particle.size / 3, particle.size, particle.size * 0.62);
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
