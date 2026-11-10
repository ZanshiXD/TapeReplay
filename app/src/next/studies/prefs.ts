// Settings of the chart studies (price zones, session lines), kept in this browser. Every chart's study layer reads
// them; `ver` bumps on any change so the layers know to redraw.
import { zonePrefs, type ZonePrefs } from '../../core/zones';
import { sessPrefs, type SessPrefs } from '../../core/sessions-studies';
import { bump, pref, setPref } from '../live';

export const studies = { zones: zonePrefs(pref<Partial<ZonePrefs>>('zones', {})), sess: sessPrefs(pref<Partial<SessPrefs>>('sessions', {})), ver: 0 };

export function setZones(p: Partial<ZonePrefs>) { studies.zones = zonePrefs({ ...studies.zones, ...p }); studies.ver++; setPref('zones', studies.zones); bump(); }
export function setSess(p: Partial<SessPrefs>) { studies.sess = sessPrefs({ ...studies.sess, ...p }); studies.ver++; setPref('sessions', studies.sess); bump(); }
export const zonesShown = () => studies.zones.added && studies.zones.on;
export const sessShown = () => studies.sess.added && studies.sess.on;
/** the Z key: shows or hides the price zones (and puts them on the charts the first time) */
export function toggleZones(): boolean {
  const on = !zonesShown();
  setZones({ added: true, on });
  return on;
}
