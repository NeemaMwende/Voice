type P = { className?: string };
const base = "currentColor";

export const IconMic = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8" />
  </svg>
);

export const IconGrid = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
);

export const IconUpload = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
  </svg>
);

export const IconWave = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12h2M6 8v8M10 4v16M14 7v10M18 9v6M22 12h0" />
  </svg>
);

export const IconNotes = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
  </svg>
);

export const IconPlay = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M6 4l14 8-14 8z" />
  </svg>
);

export const IconCopy = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

export const IconDownload = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </svg>
);

export const IconClock = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  </svg>
);

export const IconTrash = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
);

export const IconSearch = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
  </svg>
);
