import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const defaults: IconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export function IconChat(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="M2.5 3.5h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H9l-2.5 2v-2h-4a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />
    </svg>
  );
}

export function IconHistory(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.5l2.25 1.25" />
    </svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v1.25M8 13.25V14.5M1.5 8h1.25M13.25 8H14.5M3.4 3.4l.88.88M11.72 11.72l.88.88M3.4 12.6l.88-.88M11.72 4.28l.88-.88" />
    </svg>
  );
}

export function IconSend(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="M14 2L7 9M14 2l-4.5 12L7 9M14 2 2 6.5 7 9" />
    </svg>
  );
}

export function IconStop(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconRetry(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="M3 8a5 5 0 0 1 8.5-3.5M13 8a5 5 0 0 1-8.5 3.5" />
      <path d="M11 2.5V5.5H8" />
    </svg>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
      <path d="M4 10.5V4.5a1 1 0 0 1 1-1h6" />
    </svg>
  );
}

export function IconContext(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="M3 4.5h10M3 8h7M3 11.5h10" />
      <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export function IconIndex(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="M4 12.5V6.5l4-2.5 4 2.5v6" />
      <path d="M8 4V12.5" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

export function IconTokens(props: IconProps) {
  return (
    <svg {...defaults} {...props}>
      <ellipse cx="8" cy="5.5" rx="5" ry="2" />
      <path d="M3 5.5v5c0 1.1 2.24 2 5 2s5-.9 5-2v-5" />
      <path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" />
    </svg>
  );
}
