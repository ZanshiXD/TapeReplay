// Whether the phone layout is on (html.m, set in main.tsx from the window size), for parts laid out differently there.
import { useEffect, useState } from 'react';

export const isPhone = () => document.documentElement.classList.contains('m');

export function usePhone() {
  const [p, setP] = useState(isPhone);
  useEffect(() => {
    const f = () => setP(isPhone());
    addEventListener('resize', f); f();
    return () => removeEventListener('resize', f);
  }, []);
  return p;
}
