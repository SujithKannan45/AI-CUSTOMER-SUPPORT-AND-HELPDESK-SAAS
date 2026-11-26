import { useCallback, useEffect, useRef, useState } from 'react';
import { describeReadError } from '@/features/shared/errors';
import { isObjectId } from '@/utils/object-id.util';
import { customerService } from './customer.service';
import type { CustomerDto } from './types';

export type CustomerDetailStatus =
  | 'idle'
  | 'invalid'
  | 'loading'
  | 'ready'
  | 'not-found'
  | 'error';

export interface CustomerDetailState {
  readonly status: CustomerDetailStatus;
  readonly customer: CustomerDto | null;
  readonly error: string | null;
  readonly forbidden: boolean;
  readonly refresh: () => void;
}

interface InternalState {
  status: CustomerDetailStatus;
  customer: CustomerDto | null;
  error: string | null;
  forbidden: boolean;
  workspaceId: string | null;
  customerId: string | null;
}

const INITIAL_STATE: InternalState = {
  status: 'idle',
  customer: null,
  error: null,
  forbidden: false,
  workspaceId: null,
  customerId: null,
};

/**
 * Loads one customer for the active workspace.
 *
 * A malformed id is rejected locally (`invalid`) without a request; a
 * well-formed id that is unknown or belongs to another tenant resolves to
 * `not-found` from the server's tenant-scoped 404 (foreign ids are concealed,
 * not distinguished). Data is keyed on workspace + id and rejected by a request
 * sequence, so a workspace switch can never surface the previous tenant's
 * record.
 */
export function useCustomerDetail(
  workspaceId: string | null,
  customerId: string | undefined,
): CustomerDetailState {
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<InternalState>(INITIAL_STATE);
  const requestSeq = useRef(0);

  const idIsValid = isObjectId(customerId);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (workspaceId === null || customerId === undefined || !idIsValid) {
      requestSeq.current += 1;
      setState({
        ...INITIAL_STATE,
        status: workspaceId === null ? 'idle' : 'invalid',
        workspaceId,
        customerId: customerId ?? null,
      });
      return;
    }

    const seq = ++requestSeq.current;
    const controller = new AbortController();

    setState((previous) => {
      const sameScope = previous.workspaceId === workspaceId && previous.customerId === customerId;
      if (sameScope && previous.customer !== null) {
        return { ...previous, error: null, forbidden: false };
      }
      return {
        status: 'loading',
        customer: null,
        error: null,
        forbidden: false,
        workspaceId,
        customerId,
      };
    });

    void (async () => {
      try {
        const payload = await customerService.get(workspaceId, customerId, controller.signal);
        if (seq !== requestSeq.current || controller.signal.aborted) return;

        setState({
          status: 'ready',
          customer: payload.customer,
          error: null,
          forbidden: false,
          workspaceId,
          customerId,
        });
      } catch (error) {
        if (seq !== requestSeq.current || controller.signal.aborted) return;

        const description = describeReadError(error, 'customer');
        setState({
          status: description.forbidden ? 'error' : description.notFound ? 'not-found' : 'error',
          customer: null,
          error: description.message,
          forbidden: description.forbidden,
          workspaceId,
          customerId,
        });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [workspaceId, customerId, idIsValid, reloadToken]);

  const scopeIsCurrent =
    state.workspaceId === workspaceId && state.customerId === (customerId ?? null);
  const staleScope = !scopeIsCurrent && (state.customer !== null || state.status === 'error');

  if (workspaceId === null) {
    return { status: 'idle', customer: null, error: null, forbidden: false, refresh };
  }

  if (!idIsValid) {
    return { status: 'invalid', customer: null, error: null, forbidden: false, refresh };
  }

  if (staleScope) {
    return { status: 'loading', customer: null, error: null, forbidden: false, refresh };
  }

  return {
    status: state.status,
    customer: state.customer,
    error: state.error,
    forbidden: state.forbidden,
    refresh,
  };
}
