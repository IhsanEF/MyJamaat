import { getDatabase } from './database.mjs';
// Lazy access keeps builds independent from production files and credentials.
export const env = { get DB() { return getDatabase(); } };
