import { Link } from 'react-router-dom';
import { useOnline, usePendingCount, useSyncState } from '../hooks.js';
import { timeAgo } from '../format.js';

export function describeSync(sync, pending, online) {
  if (sync.status === 'syncing') return { tone: 'busy', text: 'Syncing…' };
  if (!online || sync.status === 'offline') {
    return { tone: 'offline', text: pending ? `Offline · ${pending} waiting` : 'Offline' };
  }
  if (sync.status === 'auth') return { tone: 'error', text: 'Log in again to sync' };
  if (sync.status === 'error') return { tone: 'error', text: 'Sync failed' };
  if (pending) return { tone: 'pending', text: `${pending} waiting to sync` };
  return { tone: 'ok', text: 'All synced' };
}

export default function SyncBadge() {
  const sync = useSyncState();
  const pending = usePendingCount();
  const online = useOnline();
  const { tone, text } = describeSync(sync, pending, online);
  return (
    <Link to="/sync" className={`sync-badge sync-${tone}`} title={`Last sync: ${timeAgo(sync.lastSyncAt)}`}>
      <span className="dot" />
      {text}
    </Link>
  );
}
