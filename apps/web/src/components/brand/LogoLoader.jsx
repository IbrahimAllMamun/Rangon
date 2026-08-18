'use client';

const P1 =
  'M239.46,206.16h-118.23l-41.8-84.91-24.01,56.84H0l29.81-70.57c12.25-29,47.62-40.03,74.18-23.14l135.47,121.77Z';
const P2 =
  'M204.66,70.68l-14.15,33.49h-55.4l22.42-53.12-103.92.11L75.19.09,157.75,0c36.43-.02,61.07,37.12,46.91,70.68Z';

/**
 * Logo loading animation — outline traces, then the solid mark fills in.
 * <LogoLoader />
 * <LogoLoader size={140} speed={0.8} label="Loading dashboard" />
 * Defaults to the brand orange; pass color="..." or inherit by passing color="inherit".
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
  const dur = (v) => `${v / speed}s`;

  return (
    <span
      role="status"
      aria-label={label}
      className={className}
      style={{ display: 'inline-flex', lineHeight: 0, color, ...style }}
    >
      <svg viewBox="-6 -6 251.46 218.16" width={size} height={h} aria-hidden="true">
        <path className="s" pathLength="100" d={P1} />
        <path className="s d2" pathLength="100" d={P2} />
        <path className="f" d={P1} />
        <path className="f d2" d={P2} />
      </svg>

      <style jsx>{`
        .s {
          fill: none;
          stroke: currentColor;
          stroke-width: 5;
          stroke-dasharray: 100;
          stroke-dashoffset: 100;
          animation: ll-draw ${dur(2.2)} ease-in-out infinite;
        }
        .f {
          fill: currentColor;
          opacity: 0;
          animation: ll-fill ${dur(2.2)} ease-in-out infinite;
        }
        .d2 {
          animation-delay: ${dur(0.28)};
        }
        @keyframes ll-draw {
          0% {
            stroke-dashoffset: 100;
            opacity: 1;
          }
          45% {
            stroke-dashoffset: 0;
            opacity: 1;
          }
          70%,
          100% {
            stroke-dashoffset: 0;
            opacity: 0;
          }
        }
        @keyframes ll-fill {
          0%,
          42% {
            opacity: 0;
          }
          62%,
          86% {
            opacity: 1;
          }
          100% {
            opacity: 0;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .s {
            animation: none;
            opacity: 0;
          }
          .f {
            animation: ll-fade ${dur(1.6)} ease-in-out infinite;
            opacity: 1;
          }
          @keyframes ll-fade {
            0%,
            100% {
              opacity: 0.35;
            }
            50% {
              opacity: 1;
            }
          }
        }
      `}</style>
    </span>
  );
}
