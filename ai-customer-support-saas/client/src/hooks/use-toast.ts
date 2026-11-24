import { useContext } from 'react';
import { ToastContext, type ToastApi } from '@/components/ui/toast-context';

/** Access to the app-wide toast queue; requires `<ToastProvider>`. */
export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return context;
}
