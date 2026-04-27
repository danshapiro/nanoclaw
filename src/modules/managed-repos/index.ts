import { registerDeliveryAction } from '../../delivery.js';
import { handleApplyManagedRepos, handlePushManagedRepo } from './actions.js';

registerDeliveryAction('apply_managed_repos', handleApplyManagedRepos);
registerDeliveryAction('push_managed_repo', handlePushManagedRepo);
