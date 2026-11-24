import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@/app/providers/toast.provider';
import { workspaceService } from '@/features/workspace/workspace.service';
import { useWorkspaceStore } from '@/features/workspace/workspace.store';
import { HttpApiError } from '@/services/http-client.service';
import { makeWorkspace, resetAuthStores } from '@/test/fixtures';
import { CreateWorkspaceDialog } from './create-workspace-dialog';

function renderDialog(onCreated = vi.fn()): void {
  render(
    <ToastProvider>
      <CreateWorkspaceDialog open onClose={() => undefined} onCreated={onCreated} />
    </ToastProvider>,
  );
}

describe('CreateWorkspaceDialog', () => {
  beforeEach(() => {
    resetAuthStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('moves initial focus into the name field', async () => {
    renderDialog();

    expect(await screen.findByLabelText(/Workspace name/)).toHaveFocus();
  });

  it('validates the backend length rule before submitting', async () => {
    const create = vi.spyOn(workspaceService, 'create');
    renderDialog();

    await userEvent.type(screen.getByLabelText(/Workspace name/), 'ab');
    await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(await screen.findByText('Use at least 3 characters.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('only activates the workspace after the server confirms it', async () => {
    const created = makeWorkspace('ws-new', 'Acme Labs');
    const create = vi.spyOn(workspaceService, 'create').mockResolvedValue(created);
    const onCreated = vi.fn();
    renderDialog(onCreated);

    await userEvent.type(screen.getByLabelText(/Workspace name/), '  Acme Labs  ');
    await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(await screen.findByText('Workspace created')).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith({ name: 'Acme Labs' });
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-new');
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  it('shows a safe conflict message and keeps the dialog open', async () => {
    vi.spyOn(workspaceService, 'create').mockRejectedValue(
      new HttpApiError('Workspace slug already exists', { status: 409, code: 'CONFLICT' }),
    );
    renderDialog();

    await userEvent.type(screen.getByLabelText(/Workspace name/), 'Acme Labs');
    await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(
      await screen.findByText('A workspace with that name already exists. Try a different name.'),
    ).toBeInTheDocument();
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
  });
});
