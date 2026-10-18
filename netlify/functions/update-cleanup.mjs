import { getStore } from '@netlify/blobs';
import { cleanupUpdates } from '../../server/updates.mjs';
export default async()=>{console.log(JSON.stringify(await cleanupUpdates(getStore({name:'tc06-updates-v1',consistency:'strong'}))));};
export const config={schedule:'45 * * * *'};
