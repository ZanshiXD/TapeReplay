// Stroke icons, drawn in the current text color.
import type { SVGProps } from 'react';

const S = (d: string | string[], extra?: SVGProps<SVGSVGElement>) => (p: SVGProps<SVGSVGElement>) => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...extra} {...p}>
    {(Array.isArray(d) ? d : [d]).map((x, i) => <path key={i} d={x} />)}
  </svg>
);
export const IReplay = S(['M4 20V4M4 20h16', 'M8 15v-4M12 13V7M16 16v-5']);
export const IBacktest = S(['M8 7l-5 5 5 5M16 7l5 5-5 5', 'M13.5 4.5l-3 15']);
export const IJournal = S(['M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M5 17a3 3 0 0 1 3-3h11M9 8h6']);
export const ILibrary = S(['M3 7.5V19h18V9.5h-9L10 7H3z', 'M3 7.5V5h6l2 2']);
export const IGuide = S(['M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z', 'M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5', 'M9 8h7M9 11.5h5']);
export const ISettings = S(['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8']);
export const IPlus = S('M12 5v14M5 12h14', { strokeWidth: 2.2 });
export const IClose = S('M6 6l12 12M18 6L6 18', { strokeWidth: 2 });
export const ITrash = S(['M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13']);
export const IGear = S(['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M12 3v3M12 18v3M3 12h3M18 12h3']);
export const IInd = S('M3 17c3 0 4-9 8-9s4 7 7 7 2-4 3-5');
export const IChev = S('M6 9l6 6 6-6', { width: 12, height: 12, strokeWidth: 2 });
export const IBack = S(['M6 5v14', 'M18 6l-9 6 9 6z']);
export const IFwd = S(['M18 5v14', 'M6 6l9 6-9 6z']);
export const ICheck = S('M5 12.5l4.5 4.5L19 7.5', { strokeWidth: 2.2 });
export const ISearch = S(['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4'], { strokeWidth: 2 });
export const IClassic = S(['M4 5h16v14H4z', 'M4 9h16M9 9v10']);
export const ILayout1 = S('M4 5h16v14H4z');
export const ILayout2 = S(['M4 5h16v14H4z', 'M12 5v14']);
export const ILayout4 = S(['M4 5h16v14H4z', 'M12 5v14M4 12h16']);
export const IPlay = (p: SVGProps<SVGSVGElement>) => <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}><path d="M7 4.5l12 7.5-12 7.5z" /></svg>;
export const IPause = (p: SVGProps<SVGSVGElement>) => <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>;
export const Logo = () => <svg width={14} height={20} viewBox="0 0 14 20" aria-hidden="true"><rect x="0" y="0" width="14" height="8.5" rx="2" fill="#26a69a" /><rect x="0" y="11.5" width="14" height="8.5" rx="2" fill="#ef5350" /></svg>;
