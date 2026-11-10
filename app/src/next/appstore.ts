// The page's one store (the app's server, or the browser's IndexedDB).
import { openStore } from '../core/store';

export const store = openStore();
/** the page address keeps the app's token, so the classic view can reach the app's storage too */
export const classicHref = './index.html' + location.search;
