import { registerDeliveryAction } from '../../delivery.js';
import { handleApplyManagedRepos, handlePublishLocalSkill, handlePushManagedRepo } from './actions.js';
import { startManagedReposIpcWatcher } from './ipc.js';

registerDeliveryAction('apply_managed_repos', handleApplyManagedRepos);
registerDeliveryAction('push_managed_repo', handlePushManagedRepo);
registerDeliveryAction('publish_local_skill', handlePublishLocalSkill);
startManagedReposIpcWatcher();
