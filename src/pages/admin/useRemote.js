import { useCallback, useEffect, useState } from 'react';
import { api, OfflineError } from '../../api.js';

// Loads data from the server for the online-only administration screens.
export function useRemote(path) {
  const [state, setState] = useState({ data: null, error: null, loading: true });

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ data: await api(path), error: null, loading: false });
    } catch (err) {
      const error = err instanceof OfflineError ? 'Administration needs a connection to the server. Try again when online.' : err.message;
      setState({ data: null, error, loading: false });
    }
  }, [path]);

  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}
