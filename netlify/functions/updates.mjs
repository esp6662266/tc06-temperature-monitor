import { getStore } from '@netlify/blobs';
import { createUpdates } from '../../server/updates.mjs';
export default createUpdates(() => getStore({name:'tc06-updates-v1',consistency:'strong'}));
