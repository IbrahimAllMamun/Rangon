'use client';

const P1 =
  'M239.46,206.16h-118.23l-41.8-84.91-24.01,56.84H0l29.81-70.57c12.25-29,47.62-40.03,74.18-23.14l135.47,121.77Z';
const P2 =
  'M204.66,70.68l-14.15,33.49h-55.4l22.42-53.12-103.92.11L75.19.09,157.75,0c36.43-.02,61.07,37.12,46.91,70.68Z';

/** Base cadence in seconds; `speed` divides these. */
const DRAW_DURATION = 2.2;
const SECOND_GLYPH_DELAY = 0.28;

/**
 * Logo loading animation — outline traces, then the solid mark fills in.
 * <LogoLoader />
 * <LogoLoader size={140} speed={0.8} label="Loading dashboard" />
 * Defaults to the brand orange; pass color="..." or inherit by passing color="inherit".
 *
 * The keyframes live in `styles/globals.css` under `.logo-loader`, not in a
 * `<style jsx>` block. Turbopack applies styled-jsx's class names but does not
 * inject its CSS, which left this rendering as a dead static shape under
 * `next dev --turbopack`. Plain CSS behaves the same under both bundlers, and
 * `prefers-reduced-motion` is handled alongside it.
 */
export default function LogoLoader({
  size = 96,
  speed = 1,
  color = 'rgb(253, 56, 7)',
  label = 'Loading',
  className,
  style,
}) {
  const h = Math.round((size * 218.16) / 251.46);

  return (
    <span
      role="status"
      aria-label={label}
      className={['logo-loader', className].filter(Boolean).join(' ')}
      style={{
        color,
        '--ll-duration': `${DRAW_DURATION / speed}s`,
        '--ll-delay': `${SECOND_GLYPH_DELAY / speed}s`,
        ...style,
      }}
    >
      <svg viewBox="-6 -6 251.46 218.16" width={size} height={h} aria-hidden="true">
        <path className="ll-trace" pathLength="100" d={P1} />
        <path className="ll-trace ll-second" pathLength="100" d={P2} />
        <path className="ll-fill" d={P1} />
        <path className="ll-fill ll-second" d={P2} />
      </svg>
    </span>
  );
}
