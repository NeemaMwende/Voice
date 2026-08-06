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

export const IconStop = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </svg>
);

export const IconPause = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <rect x="6" y="5" width="4" height="14" rx="1.5" /><rect x="14" y="5" width="4" height="14" rx="1.5" />
  </svg>
);

export const IconSparkle = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
    <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
  </svg>
);

export const IconMenu = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);

export const IconX = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

export const IconUsers = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

export const IconSettings = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export const IconSun = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

export const IconMoon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

export const IconMail = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 6-10 7L2 6" />
  </svg>
);

export const IconLock = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

export const IconUser = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
  </svg>
);

export const IconEye = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconEyeOff = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.39-1.61" />
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22" />
  </svg>
);

export const IconLogout = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </svg>
);

export const IconShield = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke={base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);
