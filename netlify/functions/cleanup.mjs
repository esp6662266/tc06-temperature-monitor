import { getStore } from '@netlify/blobs';
import { cleanupStore } from '../../server/retention.mjs';

export default async () => {
  const summary = await cleanupStore(getStore({ name: 'tc06-monitor-v1', consistency: 'strong' }));
  console.log(JSON.stringify(summary));
};

// UTC minute 15 of each hour = Korea minute 15. No public deletion endpoint.
export const config = { schedule: '15 * * * *' };
