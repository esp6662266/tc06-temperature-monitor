import { getStore } from '@netlify/blobs';
import { createAPI } from '../../server/api.mjs';

export default createAPI(() => getStore({ name: 'tc06-monitor-v1', consistency: 'strong' }));
