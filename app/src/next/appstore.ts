// The page's one store (the app's server, or the browser's IndexedDB).
import { openStore } from '../core/store';

export const store = openStore();
