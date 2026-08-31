export function ReturnWindowMark({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`return-window-mark ${className}`.trim()}
      viewBox="0 0 64 32"
      aria-hidden="true"
      focusable="false"
    >
      <path className="mark-baseline" d="M5 16H59" />
      <path className="mark-window" d="M9 16H44" />
      <path className="mark-tail" d="M44 16H59" />
      <circle className="mark-about" cx="29" cy="16" r="5" />
      <path className="mark-allow" d="M44 6V26M44 6H49M44 26H49" />
    </svg>
  );
}
