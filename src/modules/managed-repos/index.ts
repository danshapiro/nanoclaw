import { registerDeliveryAction } from '../../delivery.js';
import { handleApplyManagedRepos, handlePushManagedRepo } from './actions.js';
import { startManagedReposIpcWatcher } from './ipc.js';

registerDeliveryAction('apply_managed_repos', handleApplyManagedRepos);
registerDeliveryAction('push_managed_repo', handlePushManagedRepo);
startManagedReposIpcWatcher();
